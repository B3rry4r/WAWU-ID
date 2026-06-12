import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SafProvisionDto } from './dto/saf-provision.dto';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { TokensService } from '../auth/tokens.service';
import { PoliciesService } from '../policies/policies.service';

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
  private static readonly DEFAULT_API_URL = 'https://production.wawuafrica.com';
  // Frontend base for email links (activation/reset) — NOT the API host.
  private static readonly DEFAULT_APP_URL = 'https://wawuafrica.com';

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
    private readonly policies: PoliciesService,
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
    // Bake a production default so provisioning never crashes on an empty env;
    // a real WAWUAFRICA_API_URL still wins when configured.
    const baseUrl = (
      this.config.get<string>('WAWUAFRICA_API_URL') ||
      ProvisioningService.DEFAULT_API_URL
    ).replace(/\/+$/, '');
    const serviceKey = this.config.getOrThrow<string>('INTERNAL_SERVICE_KEY');

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

          const createdUser = await this.prisma.wawuUser.create({
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

          // Category B (password_hash IS NULL) users need to set a password.
          // Issue a one-time activation token and email a real activation link.
          if (!record.passwordHash && email) {
            await this.sendActivation(createdUser.id, email, record.firstName);
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

  /**
   * Synchronously provision a single SAF user. Creates the wawu_users record
   * and — when an email address is supplied — issues an activation token and
   * sends a password-creation email so the user can set their password.
   */
  async provisionSafUser(dto: SafProvisionDto): Promise<{ wawuId: string; activationToken: string }> {
    const email = dto.email ? dto.email.toLowerCase().trim() : null;
    const phone = dto.phone.trim();

    const existing = await this.prisma.wawuUser.findFirst({
      where: {
        OR: [...(email ? [{ email }] : []), { phone }],
      },
    });

    if (existing) {
      // Idempotent: the person already has a WAWU-ID — e.g. they were bulk-
      // provisioned from onboarding, or registered for SAF before. Return their
      // existing id so the SAF registration links to the same identity and the
      // QR / attendance scan resolve correctly. No activation email is sent
      // because the account (and any password) already exists.
      await this.recordSafConsent(existing.id);
      return { wawuId: existing.id, activationToken: '' };
    }

    const created = await this.prisma.wawuUser.create({
      data: {
        email,
        phone,
        firstName: dto.firstName ?? null,
        lastName: dto.lastName ?? null,
        country: 'Nigeria',
        passwordHash: null,
        verificationTier: 'basic',
        trustScore: 0,
        status: 'active',
      },
    });

    let activationToken = '';
    if (email) {
      activationToken = await this.tokens.issueActivationToken(created.id);
      // Email links must point at the FRONTEND, not this API. Prefer FRONTEND_URL;
      // APP_URL is a legacy fallback (it has historically been mis-set to the API).
      const appUrl = (
        this.config.get<string>('FRONTEND_URL') ||
        this.config.get<string>('APP_URL') ||
        'https://wawuafrica.com'
      ).replace(/\/+$/, '');
      const activationUrl = `${appUrl}/auth/activate?token=${activationToken}&email=${encodeURIComponent(email)}`;
      await this.mail.sendPasswordCreation(email, activationUrl, dto.firstName ?? null);
    }

    await this.recordSafConsent(created.id);
    return { wawuId: created.id, activationToken };
  }

  /**
   * Record privacy-policy consent for a SAF registrant. The SAF form captures
   * explicit consent, so provisioning the WAWU-ID account also writes the
   * consent ledger entry. Never throws — a consent-logging hiccup must not fail
   * the registration.
   */
  private async recordSafConsent(userId: string): Promise<void> {
    try {
      await this.policies.recordConsent(userId, 'privacy', 'saf');
    } catch (err) {
      this.logger.warn(`Could not record SAF consent for ${userId}: ${String(err)}`);
    }
  }

  /**
   * Delete a provisioned user by email or phone. Service-key guarded at the
   * controller; intended for test-data cleanup and admin removal. Refresh,
   * reset and activation token rows cascade-delete with the user.
   */
  async deleteSafUser(dto: {
    email?: string | null;
    phone?: string | null;
  }): Promise<{ deleted: number }> {
    const email = dto.email ? dto.email.toLowerCase().trim() : null;
    const phone = dto.phone ? dto.phone.trim() : null;
    if (!email && !phone) {
      return { deleted: 0 };
    }
    const result = await this.prisma.wawuUser.deleteMany({
      where: {
        OR: [...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])],
      },
    });
    return { deleted: result.count };
  }

  /**
   * Issue a one-time activation token for a freshly provisioned Category B user
   * and email them a real activation link via the mail service (Resend). The
   * MailService already logs a loud warning and skips delivery when
   * RESEND_API_KEY is unset, so this path is real and works the moment the key
   * is configured — without ever crashing the provisioning job.
   */
  private async sendActivation(
    userId: string,
    email: string,
    firstName?: string | null,
  ): Promise<void> {
    const rawToken = await this.tokens.issueActivationToken(userId);

    // The activation link points at the app's activation route, mirroring the
    // password-reset link shape (token + email so the route can identify the
    // account and consume the one-time token).
    const appUrl = (
      this.config.get<string>('FRONTEND_URL') ||
      this.config.get<string>('APP_URL') ||
      ProvisioningService.DEFAULT_APP_URL
    ).replace(/\/+$/, '');
    const activationUrl = `${appUrl}/auth/activate?token=${rawToken}&email=${encodeURIComponent(
      email,
    )}`;

    await this.mail.sendPasswordCreation(email, activationUrl, firstName);
  }
}
