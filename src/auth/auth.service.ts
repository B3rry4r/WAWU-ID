import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WawuUser } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';
import { MailService } from '../mail/mail.service';
import { OtpService } from '../otp/otp.service';
import { PrismaService } from '../prisma/prisma.service';
import { ActivateDto } from './dto/activate.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { TokenPair, TokensService } from './tokens.service';

export interface UserResponse {
  id: string;
  fullName: string;
  email: string | null;
  phone: string;
  country: string | null;
  state: string | null;
  occupation: string | null;
  verificationTier: string;
  trustScore: number;
  status: string;
}

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    private readonly otp: OtpService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  // ── helpers ────────────────────────────────────────────────────────────────

  private splitName(fullName: string): { firstName: string; lastName: string } {
    const parts = fullName.trim().split(/\s+/);
    const firstName = parts.shift() ?? '';
    return { firstName, lastName: parts.join(' ') };
  }

  private toUserResponse(
    user: WawuUser,
    occupation: string | null = null,
  ): UserResponse {
    return {
      id: user.id,
      fullName: [user.firstName, user.lastName].filter(Boolean).join(' '),
      email: user.email,
      phone: user.phone,
      country: user.country,
      state: user.state ?? null,
      occupation,
      verificationTier: user.verificationTier,
      trustScore: user.trustScore,
      status: user.status,
    };
  }

  // ── email + password ────────────────────────────────────────────────────────

  async register(
    dto: RegisterDto,
  ): Promise<TokenPair & { user: UserResponse }> {
    const email = dto.email.toLowerCase().trim();

    const existing = await this.prisma.wawuUser.findFirst({
      where: { OR: [{ email }, { phone: dto.phone }] },
    });
    if (existing) {
      throw new ConflictException(
        'An account with this email or phone already exists',
      );
    }

    const { firstName, lastName } = this.splitName(dto.fullName);
    const user = await this.prisma.wawuUser.create({
      data: {
        email,
        phone: dto.phone,
        firstName,
        lastName,
        country: dto.country,
        state: dto.state ?? null,
        passwordHash: await argon2.hash(dto.password),
        verificationTier: 'basic',
        trustScore: 0,
        status: 'active',
      },
    });

    // Fire-and-forget the branded WAWUAfrica welcome email; never block or fail
    // registration on mail delivery (MailService already swallows send errors).
    if (user.email) {
      void this.mail.sendWelcome(user.email, user.firstName);
    }

    const pair = await this.tokens.issueTokens(user);
    return { ...pair, user: this.toUserResponse(user, dto.occupation ?? null) };
  }

  async login(dto: LoginDto): Promise<TokenPair & { user: UserResponse }> {
    const user = await this.prisma.wawuUser.findFirst({
      where: {
        OR: [
          { email: dto.identifier.toLowerCase().trim() },
          { phone: dto.identifier.trim() },
        ],
      },
    });

    if (!user) {
      // Intentional, by-design identifier-existence signal (404 +
      // USER_NOT_IN_WAWUID) vs. the generic 401 for a wrong password below.
      // Clients (WAWUAfrica-API et al.) branch on USER_NOT_IN_WAWUID to drive
      // their signup/redirect flows, so this distinction must be preserved.
      throw new UnauthorizedException({
        statusCode: 404,
        code: 'USER_NOT_IN_WAWUID',
        message: 'No account found with this email or phone number.',
      });
    }
    if (!user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Fire-and-forget login-alert email. CTA points at the account-security
    // page (env-overridable, defaults to the reset-password route on APP_URL).
    if (user.email) {
      const appUrl = (
        this.config.get<string>('FRONTEND_URL') ??
        this.config.get<string>('APP_URL') ??
        ''
      ).replace(/\/+$/, '');
      // No /auth prefix: the frontend's (auth) route group is stripped from the
      // URL, so the live route is /forgot-password (not /auth/forgot-password).
      const secureUrl =
        this.config.get<string>('SECURITY_URL') ??
        `${appUrl}/forgot-password`;
      void this.mail.sendLoginAlert(user.email, secureUrl, user.firstName);
    }

    const pair = await this.tokens.issueTokens(user);
    return { ...pair, user: this.toUserResponse(user) };
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    return this.tokens.rotateRefreshToken(refreshToken);
  }

  // ── internal: tier management (X-Service-Key gated) ─────────────────────────

  /**
   * Stamp a user's verification tier (admin/partner provisioning path).
   * Only ever ELEVATES to a trusted tier — this path can never downgrade an
   * account to `basic` (or any non-trusted tier). Takes effect on the next
   * token refresh; already-issued JWTs keep their old tier until then.
   */
  async updateVerificationTier(
    userId: string,
    tier: string,
  ): Promise<UserResponse> {
    const ALLOWED = [
      'certified_professional',
      'trusted_partner',
      'official',
    ] as const;
    type AllowedTier = (typeof ALLOWED)[number];
    if (!ALLOWED.includes(tier as AllowedTier)) {
      throw new BadRequestException(
        `verificationTier must be one of: ${ALLOWED.join(', ')}`,
      );
    }

    const user = await this.prisma.wawuUser.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const updated = await this.prisma.wawuUser.update({
      where: { id: userId },
      data: { verificationTier: tier as AllowedTier },
    });

    // Elevation to a trusted tier = account approved. Fire-and-forget the
    // branded "Account Approved" email (never block the tier update on mail).
    if (updated.email) {
      void this.mail.sendAccountApproved(updated.email, updated.firstName);
    }

    return this.toUserResponse(updated);
  }

  /**
   * Internal (X-Service-Key gated) trust-score update. Called by the Hub to keep
   * a user's authoritative trust score in sync. Score is clamped to [0, 100].
   */
  async updateTrustScore(
    userId: string,
    trustScore: number,
  ): Promise<UserResponse> {
    if (!Number.isInteger(trustScore) || trustScore < 0 || trustScore > 100) {
      throw new BadRequestException(
        'trustScore must be an integer between 0 and 100',
      );
    }

    const user = await this.prisma.wawuUser.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const updated = await this.prisma.wawuUser.update({
      where: { id: userId },
      data: { trustScore },
    });

    return this.toUserResponse(updated);
  }

  /**
   * Internal (X-Service-Key gated) account removal. Used to purge residual
   * or test accounts on request from WAWUAfrica-API ops tooling.
   *
   * Two modes:
   *   • hard delete (default) — removes the row entirely; related refresh and
   *     reset tokens cascade away via the schema's onDelete: Cascade.
   *   • anonymize — keeps the row (preserves cross-platform reference links and
   *     foreign-key integrity) but scrubs PII, marks the account `banned`, and
   *     revokes all sessions/reset tokens.
   */
  async deleteUser(
    userId: string,
    mode: 'hard' | 'anonymize' = 'hard',
  ): Promise<{ id: string; status: string; deleted: boolean }> {
    const user = await this.prisma.wawuUser.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (mode === 'anonymize') {
      const scrubbed = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.wawuUser.update({
          where: { id: userId },
          data: {
            email: null,
            phone: `deleted:${userId}`,
            firstName: null,
            lastName: null,
            country: null,
            state: null,
            passwordHash: null,
            // Terminal state for a finalized account: `banned` (a finalized,
            // PII-scrubbed account is permanently barred). Stamp deletedAt so
            // the row is unambiguously a deleted account, not just a ban.
            status: 'banned',
            deletedAt: new Date(),
          },
        });
        await tx.refreshToken.deleteMany({ where: { userId } });
        await tx.passwordResetToken.deleteMany({ where: { userId } });
        return updated;
      });
      return { id: scrubbed.id, status: scrubbed.status, deleted: false };
    }

    // Hard delete — refresh/reset tokens cascade via the schema relations.
    await this.prisma.wawuUser.delete({ where: { id: userId } });
    return { id: userId, status: 'deleted', deleted: true };
  }

  /**
   * Internal (X-Service-Key gated) start of the cross-ecosystem deletion flow.
   * Marks the account `pending_deletion`, stamps `deletedAt`, and revokes ALL
   * active sessions + password-reset tokens (same revocation as the anonymize
   * path). The hub finalizes the deletion ~48h later via deleteUser(anonymize).
   *
   * Idempotent: re-marking an account that is already pending_deletion just
   * refreshes deletedAt and re-revokes tokens — it never throws on repeat calls.
   */
  async markPendingDeletion(
    userId: string,
  ): Promise<{ id: string; status: string }> {
    const user = await this.prisma.wawuUser.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.wawuUser.update({
        where: { id: userId },
        data: {
          status: 'pending_deletion',
          deletedAt: new Date(),
        },
      });
      // Same revocation the anonymize path uses: drop every session + reset token.
      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.passwordResetToken.deleteMany({ where: { userId } });
      return u;
    });

    return { id: updated.id, status: updated.status };
  }

  // ── OTP (phone) ───────────────────────────────────────────────────────────────

  async otpStart(phone: string): Promise<{ message: string; expiresIn: number }> {
    await this.otp.generateAndSend(phone);
    return { message: 'OTP sent', expiresIn: 300 };
  }

  async otpVerify(
    phone: string,
    code: string,
  ): Promise<TokenPair & { user: UserResponse }> {
    const ok = await this.otp.verify(phone, code);
    if (!ok) {
      throw new UnauthorizedException('Invalid or expired OTP');
    }

    // Find or create a phone-only user (e.g. WAWUBasket-style signup).
    let user = await this.prisma.wawuUser.findUnique({ where: { phone } });
    if (!user) {
      user = await this.prisma.wawuUser.create({
        data: {
          phone,
          verificationTier: 'basic',
          trustScore: 0,
          status: 'active',
        },
      });
    }

    const pair = await this.tokens.issueTokens(user);
    return { ...pair, user: this.toUserResponse(user) };
  }

  // ── password reset + activation ────────────────────────────────────────────

  /** Always responds the same way to avoid leaking which accounts exist. */
  async forgotPassword(
    identifier: string,
    method: 'sms' | 'email' = 'sms',
  ): Promise<{ message: string }> {
    const user = await this.prisma.wawuUser.findFirst({
      where: {
        OR: [
          { email: identifier.toLowerCase().trim() },
          { phone: identifier.trim() },
        ],
      },
    });

    if (user) {
      if (method === 'email' && user.email) {
        // Web hub: email a one-time reset link via Resend.
        const rawToken = randomBytes(32).toString('hex');
        await this.prisma.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash: await argon2.hash(rawToken),
            expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
          },
        });

        const appUrl =
          this.config.get<string>('FRONTEND_URL') ??
          this.config.get<string>('APP_URL') ??
          '';
        // No /auth prefix — the frontend serves /reset-password via the (auth)
        // route group, which Next.js strips from the URL (/auth/... 404s).
        const resetUrl = `${appUrl}/reset-password?token=${rawToken}&email=${encodeURIComponent(user.email)}`;
        await this.mail.sendPasswordReset(user.email, resetUrl, user.firstName);
      } else if (user.phone) {
        // Mobile apps: send a 6-digit reset code over WhatsApp.
        await this.otp.generateAndSend(user.phone);
      }
    }

    return { message: 'If an account exists, a reset code has been sent.' };
  }

  /**
   * Resets a password via one of two paths:
   *   • SMS-code (mobile)  → { identifier, code, newPassword } — returns a
   *     fresh session so the device is signed straight in.
   *   • Email-link (web)   → { token, email, password } — returns a message;
   *     the web app then redirects to the login screen.
   */
  async resetPassword(
    dto: ResetPasswordDto,
  ): Promise<{ message: string } | (TokenPair & { user: UserResponse })> {
    if (dto.identifier && dto.code && dto.newPassword) {
      return this.resetPasswordBySms(dto.identifier, dto.code, dto.newPassword);
    }
    if (dto.token && dto.email && dto.password) {
      return this.resetPasswordByToken(dto.token, dto.email, dto.password);
    }
    throw new BadRequestException(
      'Provide either { identifier, code, newPassword } or { token, email, password }',
    );
  }

  private async resetPasswordBySms(
    identifier: string,
    code: string,
    newPassword: string,
  ): Promise<TokenPair & { user: UserResponse }> {
    const user = await this.prisma.wawuUser.findFirst({
      where: {
        OR: [
          { email: identifier.toLowerCase().trim() },
          { phone: identifier.trim() },
        ],
      },
    });
    // Same error whether the user or the code is wrong — never leak existence.
    if (!user) {
      throw new UnauthorizedException('Invalid or expired reset code');
    }

    const ok = await this.otp.verify(user.phone, code);
    if (!ok) {
      throw new UnauthorizedException('Invalid or expired reset code');
    }

    const updated = await this.prisma.wawuUser.update({
      where: { id: user.id },
      data: { passwordHash: await argon2.hash(newPassword) },
    });
    // Invalidate every other active session for this user.
    await this.prisma.refreshToken.deleteMany({ where: { userId: user.id } });

    const pair = await this.tokens.issueTokens(updated);
    return { ...pair, user: this.toUserResponse(updated) };
  }

  private async resetPasswordByToken(
    token: string,
    rawEmail: string,
    password: string,
  ): Promise<{ message: string }> {
    const email = rawEmail.toLowerCase().trim();
    const user = await this.prisma.wawuUser.findUnique({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('Invalid or expired reset token');
    }

    const records = await this.prisma.passwordResetToken.findMany({
      where: { userId: user.id },
    });
    let matched: (typeof records)[number] | undefined;
    for (const record of records) {
      if (await argon2.verify(record.tokenHash, token)) {
        matched = record;
        break;
      }
    }
    if (!matched || matched.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Invalid or expired reset token');
    }

    await this.prisma.$transaction([
      this.prisma.wawuUser.update({
        where: { id: user.id },
        data: { passwordHash: await argon2.hash(password) },
      }),
      // Invalidate all reset tokens and active sessions for this user.
      this.prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }),
      this.prisma.refreshToken.deleteMany({ where: { userId: user.id } }),
    ]);

    return { message: 'Password reset successfully' };
  }

  /** One-time activation for Category B users: set a password via emailed token. */
  async activate(dto: ActivateDto): Promise<TokenPair & { user: UserResponse }> {
    const email = dto.email.toLowerCase().trim();
    const user = await this.prisma.wawuUser.findUnique({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('Invalid or expired activation token');
    }
    if (user.passwordHash) {
      throw new BadRequestException('Account already activated');
    }

    // Match + consume the persisted one-time token (throws if invalid/expired).
    await this.tokens.verifyActivationToken(user.id, dto.activationToken);

    const [updated] = await this.prisma.$transaction([
      this.prisma.wawuUser.update({
        where: { id: user.id },
        data: { passwordHash: await argon2.hash(dto.password) },
      }),
      // One-time: invalidate every activation token for this user once used.
      this.prisma.activationToken.deleteMany({ where: { userId: user.id } }),
    ]);

    const pair = await this.tokens.issueTokens(updated);
    return { ...pair, user: this.toUserResponse(updated) };
  }
}
