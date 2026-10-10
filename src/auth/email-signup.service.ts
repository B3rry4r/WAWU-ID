import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PhoneVerification, WawuUser } from '@prisma/client';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomInt, randomUUID } from 'crypto';
import { normalisePhone, phoneVariants } from '../common/phone.util';
import { MailSendError, MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService, type UserResponse } from './auth.service';
import type { SignupDto } from './dto/signup.dto';
import { maskEmail } from './mask-email';
import {
  phoneVerificationConfig,
  type PhoneVerificationConfig,
} from './phone-verification.config';
import {
  problem,
  type SignupResume,
  type SignupStarted,
} from './phone-signup.service';
import { RateLimiter } from './rate-limiter.service';
import { releasedPhoneFor } from './released-phone';
import {
  applyClashPlan,
  numberHeld,
  planClashes,
  SAME_ACCOUNT,
} from './unproven-phone';
import {
  signupSequenceConfig,
  type SignupSequenceConfig,
} from './signup-sequence.config';
import type { TokenPair } from './tokens.service';

/** What A4 needs to draw the code step when the code was mailed. */
export interface EmailSignupCodeSent {
  /** The number as stored, so the next call can send exactly this. */
  phone: string;
  /** Seconds the code can be used for. */
  expiresIn: number;
  /** Seconds until another code can be requested. */
  resendIn: number;
  channel: 'email';
}

/** What sign-up answers when the code was mailed (the `attempt` secret is shown once). */
export type EmailSignupStarted = Omit<SignupStarted, 'emailCodeRequired'> & {
  emailCodeRequired: false;
  channel: 'email';
  /** Where the code went, written so a bystander cannot use it: a•••@example.com. */
  maskedEmail: string;
  /**
   * Present (true) only when the number typed was NOT saved to this account
   * because another account holds it (an account that only typed it). The
   * account is made without a phone; the person adds and proves one later.
   */
  phoneNotSaved?: true;
};

const WRONG_CODE = () =>
  problem(400, 'EMAIL_CODE_INVALID', "That code isn't right");

/** A hash to check against when there is nothing real to check, so the work is the same. */
let dummyHash: Promise<string> | undefined;
const decoyHash = () => (dummyHash ??= argon2.hash('no pending sign-up'));

type Pending = PhoneVerification & { user: WawuUser };

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** The address a pending sign-up's code was mailed to: the one it is about to own. */
const addressOf = (pending: Pending): string =>
  (pending.claimEmail ?? pending.user.email) as string;

/**
 * Mobile sign-up whose required check is a code mailed to the email (AUTH-07,
 * DECISIONS R-39). Used while SIGNUP_VERIFY_CHANNEL is `email`. The default is `phone`; the
 * owner switches to `email` after the app build with email codes is out and
 * Resend is confirmed in production.
 *
 * It is PhoneSignupService's sign-up with the channel changed and nothing else:
 * `signup` creates the account, mails a 6-digit code and returns an `attempt`
 * secret, with no session; `start` mails another; `confirm` checks the code and
 * issues the first session. The secret, the wrong-code rules (four in a row
 * start the wait, a daily cap), the 60 s resend gap, the per-address, per-email
 * and daily limits and the 24-hour life of an unproven sign-up are the phone
 * code's, from the same config, so there is one set of figures for the owner.
 *
 * What differs is what a right code proves. It proves the EMAIL, so the account
 * is made `emailVerified` and is in the sign-up sequence from this moment (its
 * `signup_progress` row is created here). The phone is stored and is NOT
 * proven: `phone_verified_at` stays empty, so nothing treats the number as
 * confirmed. Nothing is texted and the SmsProvider is not used.
 *
 * `start` and `confirm` answer the same way for an email nobody registered, a
 * registered one that is not pending, and a secret that is wrong, and do the
 * same work in each case, like the phone routes. They act only on rows whose
 * `channel` is `email`; the phone routes never see those rows.
 */
@Injectable()
export class EmailSignupService {
  private readonly logger = new Logger(EmailSignupService.name);
  private readonly settings: PhoneVerificationConfig;
  private readonly sequence: SignupSequenceConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    config: ConfigService,
    private readonly limits: RateLimiter,
    private readonly mail: MailService,
  ) {
    this.settings = phoneVerificationConfig(config);
    this.sequence = signupSequenceConfig(config);
  }

  // ── sign up ────────────────────────────────────────────────────────────────

  async signup(dto: SignupDto, address: string): Promise<EmailSignupStarted> {
    const phone = this.requirePhone(dto.phone);
    const email = dto.email.toLowerCase().trim();
    this.requireTransport();
    await this.gateAddress(address);

    // A mail is reserved before anything is written, and given back if the
    // sign-up does not end in one.
    const reserved: Array<[string, string]> = [];
    const reserve = async (
      scope: string,
      key: string,
      limit: number,
      window: number,
    ) => {
      const out = await this.limits.hit(scope, key, limit, window);
      reserved.push([scope, key]);
      return out;
    };
    const giveBack = () =>
      Promise.all(
        reserved.map(([scope, key]) => this.limits.release(scope, key)),
      );

    const gap = await reserve(
      'signup-mail-gap',
      email,
      1,
      this.settings.resendSeconds,
    );
    if (!gap.allowed) {
      await giveBack();
      throw problem(
        429,
        'EMAIL_CODE_RESEND_TOO_SOON',
        'Wait before asking for another code.',
        gap.retryAfterSeconds,
      );
    }
    const day = await reserve(
      'signup-mail-day',
      email,
      this.settings.phonePerDay,
      86400,
    );
    const all = await reserve(
      'signup-mail-global',
      'all',
      this.settings.globalPerDay,
      86400,
    );
    if (!day.allowed || !all.allowed) {
      await giveBack();
      throw this.busy(
        Math.max(
          day.allowed ? 0 : day.retryAfterSeconds,
          all.allowed ? 0 : all.retryAfterSeconds,
        ),
      );
    }

    const code = this.newCode();
    const codeHash = await argon2.hash(code);
    const passwordHash = await argon2.hash(dto.password);
    const attempt = randomBytes(32).toString('base64url');
    const now = new Date();
    const variants = phoneVariants(phone);
    const id = randomUUID();
    let claim = false;
    let held = false;

    try {
      await this.prisma.$transaction(async (tx) => {
        claim = false;
        held = false;
        const clashes = await tx.wawuUser.findMany({
          where: { OR: [{ email }, { phone: { in: variants } }] },
          include: { phoneVerification: true, signupProgress: true },
        });
        // What is in the way is decided first and changed after, so a sign-up
        // refused for one clash changes nothing for another. A mailed sign-up
        // proves no number, so it never takes one from an account that only
        // typed it: it goes ahead without the number (see unproven-phone.ts).
        const plan = planClashes(clashes, email, variants);
        claim = plan.claimEmail;
        held = numberHeld(plan);
        await applyClashPlan(tx, plan);

        await tx.wawuUser.create({
          data: {
            id,
            email: claim ? null : email,
            // The sign-up row below keeps the number typed, so the next calls
            // find this sign-up by it; the account holds it only when nobody
            // else does.
            phone: held ? releasedPhoneFor(id) : phone,
            passwordHash,
            occupation: dto.occupation?.trim() || null,
            accountType: dto.accountType ?? null,
            verificationTier: 'basic',
            trustScore: 0,
            status: 'active',
            phoneVerification: {
              create: {
                phone,
                channel: 'email',
                codeHash,
                attemptHash: sha256(attempt),
                claimEmail: claim ? email : null,
                expiresAt: this.codeExpiry(now),
                lastSentAt: now,
                signupExpiresAt: new Date(
                  now.getTime() + this.settings.pendingSignupSeconds * 1000,
                ),
              },
            },
          },
        });
      });
    } catch (err) {
      await giveBack();
      // Two sign-ups for the same email or phone at once: one wins, the other
      // is told the account exists.
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException(SAME_ACCOUNT);
      }
      throw err;
    }

    try {
      await this.deliver(email, code);
    } catch (err) {
      if (!(err instanceof MailSendError)) throw err;
      this.logger.error(`Sign-up code was not mailed: ${err.message}`);
      // Nothing was delivered: the mail is given back and the person may ask again at once.
      await giveBack();
      await this.limits.forget('signup-mail-gap', email);
      // The secret was never handed out, so nobody can confirm this sign-up:
      // it is removed, and no pending row is left holding a number or an email.
      await this.discard(id);
      throw problem(
        503,
        'EMAIL_SEND_FAILED',
        'We could not send the code. Try again in a moment.',
      );
    }
    return {
      ...this.shape(phone),
      attempt,
      emailCodeRequired: false,
      maskedEmail: maskEmail(email),
      ...(held ? { phoneNotSaved: true as const } : {}),
    };
  }

  /**
   * Mail another code to a pending sign-up, for whoever holds its `attempt`.
   * Anything else (an unknown number, a registered one that is not pending, a
   * proven one, a wrong or old secret) gets the same answer and no mail, and
   * spends nothing but the caller's own address allowance.
   */
  async start(
    rawPhone: string,
    attempt: string,
    address: string,
  ): Promise<EmailSignupCodeSent> {
    const phone = this.requirePhone(rawPhone);
    this.requireTransport();
    await this.gateAddress(address);

    const code = this.newCode();
    const codeHash = await argon2.hash(code);
    const pending = await this.findByAttempt(phone, attempt);
    if (!pending) return this.shape(phone);
    const email = addressOf(pending);

    const gap = await this.limits.hit(
      'signup-mail-gap',
      email,
      1,
      this.settings.resendSeconds,
    );
    if (!gap.allowed) {
      throw problem(
        429,
        'EMAIL_CODE_RESEND_TOO_SOON',
        'Wait before asking for another code.',
        gap.retryAfterSeconds,
      );
    }
    const day = await this.limits.hit(
      'signup-mail-day',
      email,
      this.settings.phonePerDay,
      86400,
    );
    if (!day.allowed) {
      await this.limits.release('signup-mail-gap', email);
      throw this.busy(day.retryAfterSeconds);
    }
    const all = await this.limits.hit(
      'signup-mail-global',
      'all',
      this.settings.globalPerDay,
      86400,
    );
    if (!all.allowed) {
      await this.limits.release('signup-mail-gap', email);
      await this.limits.release('signup-mail-day', email);
      throw this.busy(all.retryAfterSeconds);
    }

    const now = new Date();
    const previous = {
      codeHash: pending.codeHash,
      expiresAt: pending.expiresAt,
      lastSentAt: pending.lastSentAt,
    };
    await this.prisma.phoneVerification.update({
      where: { id: pending.id },
      data: {
        codeHash,
        expiresAt: this.codeExpiry(now),
        lastSentAt: now,
      },
    });
    // Waited for, like the sign-up's mail: the person is never told a code was
    // sent that was not. Only someone holding a live secret reaches this line,
    // so how long it takes tells nobody anything they do not already know.
    try {
      await this.deliver(email, code);
    } catch (err) {
      if (!(err instanceof MailSendError)) throw err;
      this.logger.error(`Sign-up code was not mailed: ${err.message}`);
      // Nothing was delivered: the code that was live stays live, the three
      // reserved mails are given back, and the person may ask again at once.
      await this.prisma.phoneVerification.update({
        where: { id: pending.id },
        data: previous,
      });
      await this.limits.release('signup-mail-gap', email);
      await this.limits.release('signup-mail-day', email);
      await this.limits.release('signup-mail-global', 'all');
      await this.limits.forget('signup-mail-gap', email);
      throw problem(
        503,
        'EMAIL_SEND_FAILED',
        'We could not send the code. Try again in a moment.',
      );
    }
    return this.shape(phone);
  }

  // ── confirm ────────────────────────────────────────────────────────────────

  /** Check the code. Right: the email is proven and a session is issued. */
  async confirm(
    rawPhone: string,
    attempt: string,
    code: string,
    address: string,
  ): Promise<TokenPair & { user: UserResponse }> {
    const phone = normalisePhone(rawPhone);
    if (!phone || !phone.startsWith(this.settings.allowedPhonePrefix)) {
      throw WRONG_CODE();
    }
    const gate = await this.limits.hit(
      'signup-mail-confirm-ip',
      address,
      this.settings.confirmIpPerHour,
      3600,
    );
    if (!gate.allowed) throw this.busy(gate.retryAfterSeconds);

    const pending = await this.findByAttempt(phone, attempt);
    if (!pending) {
      // No such sign-up for this secret: the same work and the same answer as
      // a wrong code, and nothing of the address's is spent.
      await argon2.verify(await decoyHash(), code);
      throw WRONG_CODE();
    }
    const email = addressOf(pending);
    const budget = `signup-email:${email}`;

    // The guess is taken before the code is looked at, so parallel guesses
    // share one budget.
    const claim = await this.limits.claimGuess(budget, {
      maxRun: this.settings.maxWrongCodes,
      lockoutSeconds: this.settings.lockoutSeconds,
      dailyCap: this.settings.dailyWrongCap,
    });
    if (!claim.allowed) throw this.locked(claim.retryAfterSeconds);

    const live = pending.expiresAt > new Date();
    const right = await argon2.verify(
      live ? pending.codeHash : await decoyHash(),
      code,
    );
    if (!live || !right) {
      throw claim.spent
        ? this.locked(this.settings.lockoutSeconds)
        : WRONG_CODE();
    }

    let proven: WawuUser;
    try {
      proven = await this.prisma.$transaction(async (tx) => {
        // Whoever deletes the row first wins; a second request with the same
        // code finds it gone and is told so, rather than failing.
        const taken = await tx.phoneVerification.deleteMany({
          where: { id: pending.id },
        });
        if (taken.count === 0) {
          throw problem(
            409,
            'EMAIL_ALREADY_CONFIRMED',
            'That code has already been used',
          );
        }
        if (pending.claimEmail) {
          // The person proved the mailbox, so the email moves to them. Only an
          // account that never proved it gives it up, and it keeps its phone.
          await tx.wawuUser.updateMany({
            where: {
              email: pending.claimEmail,
              emailVerified: false,
              phoneVerifiedAt: { not: null },
              id: { not: pending.userId },
            },
            data: { email: null },
          });
        }
        const user = await tx.wawuUser.update({
          where: { id: pending.userId },
          data: {
            emailVerified: true,
            ...(pending.claimEmail ? { email: pending.claimEmail } : {}),
          },
        });
        // In the sign-up sequence from now on. The sequence made this row for
        // a phone-proven account the first time it was asked; this account has
        // no proven phone, so it is made here.
        await tx.signupProgress.create({ data: { userId: user.id } });
        return user;
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException(SAME_ACCOUNT);
      }
      throw err;
    }
    await this.limits.clearGuesses(budget);
    return this.auth.sessionFor(proven);
  }

  // ── resume ─────────────────────────────────────────────────────────────────

  /**
   * Where the sign-up this secret belongs to stands, for an app that was
   * closed between A3 and A4. Sends nothing and changes nothing. The answer
   * depends only on whether the caller holds a live secret for this number,
   * which nobody but the person who signed up can: a made-up secret, a
   * replaced one, an expired one, a confirmed one and one whose code went by
   * another channel all answer `details`, after the same single lookup.
   */
  async resume(
    rawPhone: string,
    attempt: string,
    address: string,
  ): Promise<SignupResume> {
    const gate = await this.limits.hit(
      'resume-ip',
      address,
      this.sequence.resumeIpPerHour,
      3600,
    );
    if (!gate.allowed) throw this.busy(gate.retryAfterSeconds);

    const phone = normalisePhone(rawPhone);
    const pending =
      phone && phone.startsWith(this.settings.allowedPhonePrefix)
        ? await this.findByAttempt(phone, attempt)
        : null;
    if (!pending) return { step: 'details' };

    const now = Date.now();
    const seconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000));
    return {
      step: 'phone',
      phone: pending.phone,
      expiresIn: seconds(pending.expiresAt.getTime() - now),
      resendIn: seconds(
        pending.lastSentAt.getTime() + this.settings.resendSeconds * 1000 - now,
      ),
      emailCodeRequired: false,
      accountType: pending.user.accountType ?? null,
      channel: 'email',
      maskedEmail: maskEmail(addressOf(pending)),
      // The account was made without the number typed (another account holds it).
      ...(pending.user.phone !== pending.phone
        ? { phoneNotSaved: true as const }
        : {}),
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * The number in the one form we keep, or a 400 that depends only on what was
   * typed. Sign-up stays for Nigerian numbers (R-36): the number is used later
   * by wallet and identity checks that are Nigerian only.
   */
  private requirePhone(raw: string): string {
    const phone = normalisePhone(raw);
    if (!phone) {
      throw problem(400, 'PHONE_INVALID', 'Enter a valid phone number');
    }
    if (!phone.startsWith(this.settings.allowedPhonePrefix)) {
      throw problem(
        400,
        'PHONE_NOT_SUPPORTED',
        'We can only accept Nigerian phone numbers right now',
      );
    }
    return phone;
  }

  private requireTransport(): void {
    if (!this.mail.isConfigured()) {
      throw problem(
        503,
        'EMAIL_NOT_CONFIGURED',
        'Email is not available right now. Try again later.',
      );
    }
  }

  /**
   * The limits every caller meets whatever the email is: its address's share
   * (an hour and a day) and a look at whether the day's budget for the whole
   * service is already spent. Nothing here depends on whose email it is.
   */
  private async gateAddress(address: string): Promise<void> {
    const c = this.settings;
    const hour = await this.limits.hit(
      'signup-mail-ip',
      address,
      c.ipPerHour,
      3600,
    );
    if (!hour.allowed) throw this.busy(hour.retryAfterSeconds);
    const day = await this.limits.hit(
      'signup-mail-ip-day',
      address,
      c.ipPerDay,
      86400,
    );
    if (!day.allowed) throw this.busy(day.retryAfterSeconds);
    const all = await this.limits.isFull(
      'signup-mail-global',
      'all',
      c.globalPerDay,
      86400,
    );
    if (!all.allowed) throw this.busy(all.retryAfterSeconds);
  }

  private busy(retryAfterSeconds: number): HttpException {
    return problem(
      429,
      'RATE_LIMITED',
      'Too many requests. Try again later.',
      Math.max(1, retryAfterSeconds),
    );
  }

  private locked(retryAfterSeconds: number): HttpException {
    return problem(
      429,
      'EMAIL_CODE_LOCKED',
      'Too many wrong codes. Wait before trying again.',
      Math.max(1, retryAfterSeconds),
    );
  }

  private newCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  /** A mailed code lives as long as the mail says it does (10 minutes). */
  private codeExpiry(from: Date): Date {
    return new Date(from.getTime() + this.sequence.emailCodeTtlSeconds * 1000);
  }

  private shape(phone: string): EmailSignupCodeSent {
    return {
      phone,
      expiresIn: this.sequence.emailCodeTtlSeconds,
      resendIn: this.settings.resendSeconds,
      channel: 'email',
    };
  }

  /** The pending sign-up this secret belongs to, if it is for this number, mailed, not proven and not expired. */
  private async findByAttempt(
    phone: string,
    attempt: string,
  ): Promise<Pending | null> {
    const row = await this.prisma.phoneVerification.findUnique({
      where: { attemptHash: sha256(attempt) },
      include: { user: true },
    });
    if (
      !row ||
      row.channel !== 'email' ||
      row.user.emailVerified ||
      row.phone !== phone ||
      row.signupExpiresAt <= new Date()
    ) {
      return null;
    }
    return row;
  }

  /**
   * Removes a sign-up whose mail was refused. Only a row that nobody has
   * confirmed is touched, and only by its own id; if the removal itself fails
   * the person is still told the mail was refused, and the row is the kind a
   * newer sign-up replaces anyway.
   */
  private async discard(userId: string): Promise<void> {
    try {
      await this.prisma.wawuUser.deleteMany({
        where: { id: userId, emailVerified: false, phoneVerifiedAt: null },
      });
    } catch (err) {
      this.logger.error(
        `A sign-up whose code was not mailed could not be removed: ${String(err)}`,
      );
    }
  }

  /** The code goes by mail, and a mail that was not handed over is an error, never a quiet "sent". */
  private async deliver(email: string, code: string): Promise<void> {
    await this.mail.sendOtpCode(email, code, 'verify your email address', true);
  }
}
