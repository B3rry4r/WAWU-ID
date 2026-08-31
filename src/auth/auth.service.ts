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
import { randomBytes, randomInt } from 'crypto';
import { normalizeGender } from '../common/gender.util';
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
  gender: string | null;
  occupation: string | null;
  verificationTier: string;
  trustScore: number;
  status: string;
}

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const PHONE_CHANGE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const EMAIL_VERIFY_TTL_MS = 5 * 60 * 1000; // 5 minutes, matches OtpService's phone-OTP TTL

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
      gender: user.gender ?? null,
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
        gender: normalizeGender(dto.gender),
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

    // Email/password accounts must confirm ownership of their address before
    // a session is issued -- this is the actual enforcement point for the
    // sign-up wizard's OTP step. Without this check here, emailVerified only
    // ever gated the wizard's own client-side flow (SignUpFlow delays its
    // signInUser() call until verifyOtp() succeeds): abandoning the wizard at
    // the OTP screen and then using /sign-in directly bypassed it completely,
    // since login() otherwise never looks at emailVerified at all. Scoped to
    // `user.email` so phone-only accounts (otpVerify()'s find-or-create path,
    // which never sets an email and so never goes through email
    // verification) are unaffected. Every account that already existed before
    // this gate went live was backfilled to emailVerified = true by migration
    // 20260816020000_backfill_email_verified_for_existing_users, so this only
    // ever blocks genuinely new, never-verified signups.
    if (user.email && !user.emailVerified) {
      throw new UnauthorizedException({
        statusCode: 403,
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Verify your email address before signing in.',
      });
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
        this.config.get<string>('SECURITY_URL') ?? `${appUrl}/forgot-password`;
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
  /**
   * Bulk identity lookup for a trusted sibling service.
   *
   * WAWU ID owns a person's name and their verification tier; the Hub API owns
   * their creator data. Rendering a list of creators therefore needs both, and
   * until now there was no way to ask for the identity half in bulk — which is
   * why the consumer app's creator lists were fabricated mock people rather
   * than the real accounts sitting in this table.
   *
   * Returns ONLY what a public creator card shows: display name and badge
   * tier. Deliberately not email, phone, gender, or anything else on the row —
   * a service key is not consent, and the caller does not need them to draw a
   * card. Unknown ids are omitted rather than returned as nulls, so the caller
   * distinguishes "no such user" from "user with no name".
   */
  async lookupPublicIdentities(ids: string[]): Promise<
    Array<{
      id: string;
      firstName: string | null;
      lastName: string | null;
      verificationTier: string;
    }>
  > {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];

    const users = await this.prisma.wawuUser.findMany({
      where: { id: { in: unique } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        verificationTier: true,
      },
    });

    return users.map((u) => ({
      id: u.id,
      firstName: u.firstName,
      lastName: u.lastName,
      verificationTier: u.verificationTier,
    }));
  }

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
   * Internal (X-Service-Key gated) phone-number correction. The hub proxies a
   * user's own phone update here (e.g. a wrong number entered at onboarding).
   * Phone is unique + NOT NULL on `wawu_users`, so we reject any number already
   * held by another account with a 409.
   *
   * NOTE: v1 performs a direct, uniqueness-checked update with no OTP step.
   * Verifying ownership of the new number via WhatsApp/SMS OTP is a planned
   * future enhancement (delivery not yet configured).
   */
  async updatePhone(userId: string, phone: string): Promise<UserResponse> {
    const trimmed = phone.trim();
    if (!/^\d+$/.test(trimmed) || trimmed.length < 7) {
      throw new BadRequestException(
        'phone must contain only digits and be at least 7 characters',
      );
    }

    const user = await this.prisma.wawuUser.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Ensure no OTHER user already holds this phone (unique constraint).
    const taken = await this.prisma.wawuUser.findFirst({
      where: { phone: trimmed, id: { not: userId } },
    });
    if (taken) {
      throw new ConflictException('Phone number already in use');
    }

    const updated = await this.prisma.wawuUser.update({
      where: { id: userId },
      data: { phone: trimmed },
    });

    return this.toUserResponse(updated);
  }

  /**
   * Internal (X-Service-Key gated) gender update. The hub proxies a user's own
   * profile gender edit here. Input is normalized to the canonical 'male'|'female'
   * (anything unrecognised -> null), so this can both SET and CLEAR gender.
   */
  async updateGender(
    userId: string,
    gender: string | null,
  ): Promise<UserResponse> {
    const user = await this.prisma.wawuUser.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const updated = await this.prisma.wawuUser.update({
      where: { id: userId },
      data: { gender: normalizeGender(gender) },
    });

    return this.toUserResponse(updated);
  }

  // ── phone change via email OTP (2-step) ─────────────────────────────────────

  /**
   * Step 1 of the verified phone-change flow. Validates the requested number,
   * ensures it is not already held by another account, then generates a 6-digit
   * code, stores its argon2 hash (+ the new phone + a 10-minute expiry) in a
   * PhoneChangeRequest — replacing any prior pending request for this user — and
   * EMAILS the code to the user's REGISTERED email. The code itself is never
   * returned (no leakage); the caller only learns that it was sent.
   */
  async requestPhoneChange(
    userId: string,
    newPhone: string,
  ): Promise<{ sent: true }> {
    const trimmed = newPhone.trim();
    if (!/^\d+$/.test(trimmed) || trimmed.length < 7) {
      throw new BadRequestException(
        'phone must contain only digits and be at least 7 characters',
      );
    }

    const user = await this.prisma.wawuUser.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (!user.email) {
      throw new BadRequestException(
        'No email on file to send the verification code to',
      );
    }

    // The new number must not already belong to another account (unique phone).
    const taken = await this.prisma.wawuUser.findFirst({
      where: { phone: trimmed, id: { not: userId } },
    });
    if (taken) {
      throw new ConflictException('Phone number already in use');
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const codeHash = await argon2.hash(code);

    // At most one pending request per user: drop any prior one before inserting.
    await this.prisma.$transaction([
      this.prisma.phoneChangeRequest.deleteMany({ where: { userId } }),
      this.prisma.phoneChangeRequest.create({
        data: {
          userId,
          newPhone: trimmed,
          codeHash,
          expiresAt: new Date(Date.now() + PHONE_CHANGE_TTL_MS),
        },
      }),
    ]);

    await this.mail.sendOtpCode(
      user.email,
      code,
      'verify your phone number change',
    );

    return { sent: true };
  }

  /**
   * Step 2 of the verified phone-change flow. Loads the latest non-expired
   * PhoneChangeRequest for the user, verifies the submitted code, re-checks
   * uniqueness of the new number, then updates the user's phone and consumes the
   * request. Returns the updated UserResponse. A bad/expired code is rejected.
   */
  async confirmPhoneChange(
    userId: string,
    code: string,
  ): Promise<UserResponse> {
    const request = await this.prisma.phoneChangeRequest.findFirst({
      where: { userId, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!request) {
      throw new UnauthorizedException('Invalid or expired verification code');
    }

    const valid = await argon2.verify(request.codeHash, code);
    if (!valid) {
      throw new UnauthorizedException('Invalid or expired verification code');
    }

    // Re-check uniqueness at confirm time — another account may have claimed the
    // number between request and confirm.
    const taken = await this.prisma.wawuUser.findFirst({
      where: { phone: request.newPhone, id: { not: userId } },
    });
    if (taken) {
      // Consume the now-unusable request so the user can start a fresh one.
      await this.prisma.phoneChangeRequest.deleteMany({ where: { userId } });
      throw new ConflictException('Phone number already in use');
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.wawuUser.update({
        where: { id: userId },
        data: { phone: request.newPhone },
      }),
      this.prisma.phoneChangeRequest.deleteMany({ where: { userId } }),
    ]);

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

  async otpStart(
    phone: string,
  ): Promise<{ message: string; expiresIn: number }> {
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

  // ── email verification ──────────────────────────────────────────────────────
  //
  // Confirms ownership of the email address a caller registered with. Not a
  // status gate (register() still issues a session immediately, and status
  // stays 'active' throughout -- see WawuUser.emailVerified's doc comment),
  // but login() DOES require it for email/password accounts (see login()'s
  // comment) -- otherwise the sign-up wizard's OTP step would only ever be
  // enforced by the wizard's own client-side flow, trivially skippable by
  // going to /auth/login directly with the same never-verified credentials.
  // A freshly generated 6-digit code, emailed via the same sendOtpCode()
  // template already used for the phone-change flow, checked against an
  // argon2 hash, no bypass (same "there is deliberately NO OTP bypass"
  // principle OtpService states for phone OTP -- it applies here too, for
  // the same reason).

  async emailVerifyStart(
    email: string,
  ): Promise<{ message: string; expiresIn: number }> {
    const user = await this.prisma.wawuUser.findUnique({ where: { email } });
    if (!user) {
      throw new NotFoundException('No account found with this email');
    }
    if (user.emailVerified) {
      return { message: 'Email already verified', expiresIn: 0 };
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const codeHash = await argon2.hash(code);

    // At most one pending code per user: drop any prior one before inserting
    // (mirrors requestPhoneChange's "replace, don't accumulate" pattern).
    await this.prisma.$transaction([
      this.prisma.emailVerificationCode.deleteMany({
        where: { userId: user.id },
      }),
      this.prisma.emailVerificationCode.create({
        data: {
          userId: user.id,
          codeHash,
          expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
        },
      }),
    ]);

    await this.mail.sendOtpCode(email, code, 'verify your email address');

    return { message: 'Verification code sent', expiresIn: 300 };
  }

  async emailVerifyConfirm(
    email: string,
    code: string,
  ): Promise<TokenPair & { user: UserResponse }> {
    const user = await this.prisma.wawuUser.findUnique({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('Invalid or expired code');
    }

    const pending = await this.prisma.emailVerificationCode.findFirst({
      where: { userId: user.id, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!pending || !(await argon2.verify(pending.codeHash, code))) {
      throw new UnauthorizedException('Invalid or expired code');
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.wawuUser.update({
        where: { id: user.id },
        data: { emailVerified: true },
      }),
      this.prisma.emailVerificationCode.delete({ where: { id: pending.id } }),
    ]);

    const pair = await this.tokens.issueTokens(updated);
    return { ...pair, user: this.toUserResponse(updated) };
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
  async activate(
    dto: ActivateDto,
  ): Promise<TokenPair & { user: UserResponse }> {
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

  /**
   * Emails a Pro Max creator their Ditto Music distribution link.
   *
   * Called service-to-service by the hub when the creator OPTS IN — never on
   * payment. The hub owns the plan and the opt-in record; WAWU ID owns the
   * address and the name, and is the only service here with a mail transport.
   *
   * Returns whether an address existed. A phone-OTP signup legitimately has no
   * email, and the caller needs to know that so it can show the link in the
   * app instead of reporting a message that was never sent.
   */
  async sendDittoInvite(
    userId: string,
    signupUrl: string,
    discountPercent: number,
  ): Promise<{ emailed: boolean }> {
    const user = await this.prisma.wawuUser.findUnique({
      where: { id: userId },
      select: { email: true, firstName: true },
    });
    if (!user?.email) return { emailed: false };
    await this.mail.sendDittoDistributionInvite(
      user.email,
      user.firstName,
      signupUrl,
      discountPercent,
    );
    return { emailed: true };
  }
}
