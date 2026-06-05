import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { TokensService } from '../auth/tokens.service';

/** One record from the WAWUAfrica provisioning export (Brief Section 2). */
interface ExportRecord {
  category: 'A' | 'B' | 'C';
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  country: string | null;
  state: string | null;
  passwordHash: string | null;
  onboardingRef: string | null;
  wawuafricaAppUserId: number | null;
  sourceCreatedAt: string | null;
}

interface ExportResponse {
  data: ExportRecord[];
  pagination: { nextPage: number | null } | null;
}

export interface ProvisioningResult {
  created: number;
  skipped: number;
  activationEmailsQueued: number;
}

export interface ProvisioningStatus {
  status: 'idle' | 'running' | 'completed' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  result: ProvisioningResult | null;
  error: string | null;
}

@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);
  private static readonly PER_PAGE = 500;

  private state: ProvisioningStatus = {
    status: 'idle',
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly tokens: TokensService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Kick off provisioning in the background and return immediately. A second
   * call while a job is running is a no-op (returns the in-flight status).
   */
  start(): ProvisioningStatus {
    if (this.state.status === 'running') {
      return this.state;
    }

    const startedAt = new Date().toISOString();
    this.state = {
      status: 'running',
      startedAt,
      finishedAt: null,
      result: null,
      error: null,
    };

    void this.runProvisioning()
      .then((result) => {
        this.state = {
          status: 'completed',
          startedAt,
          finishedAt: new Date().toISOString(),
          result,
          error: null,
        };
      })
      .catch((err: unknown) => {
        this.logger.error(`Provisioning job failed: ${String(err)}`);
        this.state = {
          status: 'failed',
          startedAt,
          finishedAt: new Date().toISOString(),
          result: null,
          error: String(err),
        };
      });

    return this.state;
  }

  /** Last (or in-flight) provisioning job status. */
  getStatus(): ProvisioningStatus {
    return this.state;
  }

  /**
   * Pull the deduplicated export from WAWUAfrica and upsert-safely create
   * wawu_users. Category B (no passwordHash) gets a one-time activation email.
   */
  async runProvisioning(): Promise<ProvisioningResult> {
    const baseUrl = this.config
      .getOrThrow<string>('WAWUAFRICA_API_URL')
      .replace(/\/+$/, '');
    const serviceKey = this.config.getOrThrow<string>('INTERNAL_SERVICE_KEY');
    const appUrl = (this.config.get<string>('APP_URL') ?? '').replace(/\/+$/, '');

    let created = 0;
    let skipped = 0;
    let activationEmailsQueued = 0;
    let errors = 0;
    let page = 1;

    for (;;) {
      const url = `${baseUrl}/api/internal/users/export-for-provisioning?page=${page}&per_page=${ProvisioningService.PER_PAGE}`;
      const res = await fetch(url, {
        headers: { 'X-Service-Key': serviceKey },
      });
      if (!res.ok) {
        throw new Error(
          `Export request failed at page ${page}: ${res.status} ${res.statusText}`,
        );
      }

      const body = (await res.json()) as ExportResponse;
      const records = body.data ?? [];

      for (const record of records) {
        try {
          const email = record.email
            ? record.email.toLowerCase().trim()
            : null;
          const phone = record.phone ? record.phone.trim() : null;

          // phone is required (NOT NULL + unique on wawu_users).
          if (!phone) {
            skipped++;
            continue;
          }

          const existing = await this.prisma.wawuUser.findFirst({
            where: {
              OR: [...(email ? [{ email }] : []), { phone }],
            },
          });
          if (existing) {
            skipped++;
            continue;
          }

          const user = await this.prisma.wawuUser.create({
            data: {
              email,
              phone,
              firstName: record.firstName,
              lastName: record.lastName,
              country: record.country,
              state: record.state,
              passwordHash: record.passwordHash ?? null,
              onboardingRef: record.onboardingRef ?? null,
              wawuafricaAppUserId: record.wawuafricaAppUserId ?? null,
              verificationTier: 'basic',
              trustScore: 0,
              status: 'active',
            },
          });
          created++;

          // Category B: no password yet → email a one-time activation link.
          if (!record.passwordHash && email) {
            const token = await this.tokens.signActivationToken(user.id);
            const activationUrl = `${appUrl}/activate?token=${token}`;
            await this.mail.sendActivation(email, activationUrl);
            activationEmailsQueued++;
          }
        } catch (err) {
          errors++;
          this.logger.error(
            `Failed to provision record (${record.email ?? record.phone ?? 'unknown'}): ${String(err)}`,
          );
        }
      }

      this.logger.log(
        `Page ${page}: created=${created} skipped=${skipped} activationEmailsQueued=${activationEmailsQueued} errors=${errors}`,
      );

      const next = body.pagination?.nextPage ?? null;
      if (!next) {
        break;
      }
      page = next;
    }

    this.logger.log(
      `Provisioning complete: created=${created} skipped=${skipped} activationEmailsQueued=${activationEmailsQueued} errors=${errors}`,
    );

    return { created, skipped, activationEmailsQueued };
  }
}
