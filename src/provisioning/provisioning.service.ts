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
  emailsQueued: number;
}

@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);
  private static readonly PER_PAGE = 500;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly tokens: TokensService,
    private readonly config: ConfigService,
  ) {}

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
    let emailsQueued = 0;
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
            const activationUrl = `${appUrl}/auth/activate?token=${token}`;
            await this.mail.sendActivation(email, activationUrl);
            emailsQueued++;
          }
        } catch (err) {
          errors++;
          this.logger.error(
            `Failed to provision record (${record.email ?? record.phone ?? 'unknown'}): ${String(err)}`,
          );
        }
      }

      this.logger.log(
        `Page ${page}: created=${created} skipped=${skipped} emailsQueued=${emailsQueued} errors=${errors}`,
      );

      const next = body.pagination?.nextPage ?? null;
      if (!next) {
        break;
      }
      page = next;
    }

    this.logger.log(
      `Provisioning complete: created=${created} skipped=${skipped} emailsQueued=${emailsQueued} errors=${errors}`,
    );

    return { created, skipped, emailsQueued };
  }
}
