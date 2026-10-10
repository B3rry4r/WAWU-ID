import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PhoneVerification, WawuUser } from '@prisma/client';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomInt } from 'crypto';
import { normalisePhone, phoneVariants } from '../common/phone.util';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { SMS_PROVIDER, SmsSendError } from '../sms/sms.provider';
import type { SmsProvider } from '../sms/sms.provider';
import { AuthService, type UserResponse } from './auth.service';
import type { SignupDto } from './dto/signup.dto';
import {
  phoneVerificationConfig,
  type PhoneVerificationConfig,
} from './phone-verification.config';
import { RateLimiter } from './rate-limiter.service';
import {
  signupSequenceConfig,
  type SignupSequenceConfig,
} from './signup-sequence.config';
import type { TokenPair } from './tokens.service';

/** What the sign-up screen needs to draw the code step and its countdown. */
export interface PhoneCodeSent {
  /** The number as stored, so the next call can send exactly this. */
  phone: string;
  /** Seconds the code can be used for. */
  expiresIn: number;
  /** Seconds until another code can be requested. */
  resendIn: number;
}

/**
 * Where a sign-up stands before its phone code (AUTH-05), for an app that was
 * closed in the middle: `phone` while the sign-up this secret belongs to can
 * still be confirmed, `details` when there is none (never made, replaced by a
 * newer sign-up, expired, or already confirmed): start again at A3, or sign in.
 */
export type SignupResume =
  | {
      step: 'phone';
      /** The number as stored. */
      phone: string;
      /** Seconds the last code sent can still be used for (0: ask for a new one). */
      expiresIn: number;
      /** Seconds until another code can be asked for (0: now). */
      resendIn: number;
      /** The confirm call must also carry the code mailed to the email. */
      emailCodeRequired: boolean;
      /** 'user' or 'creator' as sent with the sign-up, or null. */
      accountType: string | null;
    }
  | { step: 'details' };

/** What sign-up answers: the above, plus the secret that ties the next calls to this sign-up. */
export interface SignupStarted extends PhoneCodeSent {
  /**
   * Unguessable, shown once. `phone/verify/start` and `phone/verify/confirm`
   * need it together with the phone, so a code only works in the sign-up that
   * asked for it. The app keeps it with the screen state and sends it back.
   */
  attempt: string;
  /** True when the email is held by another account: the confirm call must also carry `emailCode`. */
  emailCodeRequired: boolean;
}

function problem(
  status: number,
  code: string,
  message: string,
  retryAfterSeconds?: number,
): HttpException {
  return new HttpException(
    {
      statusCode: status,
      code,
      message,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    },
    status,
  );
}

const WRONG_CODE = () =>
  problem(400, 'PHONE_CODE_INVALID', "That code isn't right");

const SAME_ACCOUNT = 'An account with this email or phone already exists';

/** A hash to check against when there is nothing real to check, so the work is the same. */
let dummyHash: Promise<string> | undefined;
const decoyHash = () => (dummyHash ??= argon2.hash('no pending sign-up'));

type Pending = PhoneVerification & { user: WawuUser };

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/**
 * Mobile sign-up with a phone code (AUTH-03).
 *
 * `signup` creates the account, texts a 6-digit code to the phone and returns
 * an `attempt` secret. It issues NO session: the person gets one from
 * `confirm`, once the code is right. The phone routes act ONLY on a pending
 * sign-up and only for whoever holds that sign-up's `attempt`: with the
 * secret missing or wrong they answer as they would for any number, touch no
 * counter, and a code texted for one sign-up cannot be redeemed in another
 * (a later sign-up for the same number replaces the pending one and the
 * replaced one's secret stops working).
 *
 * `start` and `confirm` answer the same way for a number nobody registered, a
 * number that is registered but not pending, and a secret that is wrong, and
 * do the same work (a hash) in each case.
 */
@Injectable()
export class PhoneSignupService {
  private readonly logger = new Logger(PhoneSignupService.name);
  private readonly settings: PhoneVerificationConfig;
  private readonly sequence: SignupSequenceConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    config: ConfigService,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    private readonly limits: RateLimiter,
    private readonly mail: MailService,
  ) {
    this.settings = phoneVerificationConfig(config);
    this.sequence = signupSequenceConfig(config);
  }

  // ── sign up ────────────────────────────────────────────────────────────────

  async signup(dto: SignupDto, address: string): Promise<SignupStarted> {
    const phone = this.requirePhone(dto.phone);
    this.requireProvider();
    await this.gateAddress(address);

    // A text is reserved before anything is written, and given back if the
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
      'sms-phone-gap',
      phone,
      1,
      this.settings.resendSeconds,
    );
    if (!gap.allowed) {
      await giveBack();
      throw problem(
        429,
        'PHONE_CODE_RESEND_TOO_SOON',
        'Wait before asking for another code.',
        gap.retryAfterSeconds,
      );
    }
    const day = await reserve(
      'sms-phone-day',
      phone,
      this.settings.phonePerDay,
      86400,
    );
    const all = await reserve(
      'sms-global',
      'all',
      this.settings.globalPerDay,
      86400,
    );
    if (!day.allowed || !all.allowed) {
      await giveBack();
      throw this.busy(
        Math.max(
          day.retryAfterSeconds,
          all.allowed ? 0 : all.retryAfterSeconds,
        ),
      );
    }

    const email = dto.email.toLowerCase().trim();
    const code = this.newCode();
    const codeHash = await argon2.hash(code);
    const passwordHash = await argon2.hash(dto.password);
    const attempt = randomBytes(32).toString('base64url');
    const emailCode = this.newCode();
    const emailCodeHash = await argon2.hash(emailCode);
    const now = new Date();
    const variants = phoneVariants(phone);
    let claim = false;

    try {
      await this.prisma.$transaction(async (tx) => {
        claim = false;
        const clashes = await tx.wawuUser.findMany({
          where: { OR: [{ email }, { phone: { in: variants } }] },
          include: { phoneVerification: true },
        });
        for (const other of clashes) {
          if (other.phoneVerification && !other.phoneVerifiedAt) {
            // An unproven sign-up holds nothing: a newer sign-up takes its
            // email and phone, and it is gone, together with its secret.
            await tx.wawuUser.deleteMany({ where: { id: other.id } });
          } else if (
            other.email === email &&
            !variants.includes(other.phone) &&
            other.phoneVerifiedAt &&
            !other.emailVerified
          ) {
            // A mobile account holds this email without having proven it. It
            // keeps the email: nothing is taken from it here. This sign-up
            // gets the email only if its person also enters the code mailed
            // to it (see confirm).
            claim = true;
          } else {
            throw new ConflictException(SAME_ACCOUNT);
          }
        }

        await tx.wawuUser.create({
          data: {
            email: claim ? null : email,
            phone,
            passwordHash,
            occupation: dto.occupation?.trim() || null,
            accountType: dto.accountType ?? null,
            verificationTier: 'basic',
            trustScore: 0,
            status: 'active',
            phoneVerification: {
              create: {
                phone,
                codeHash,
                attemptHash: sha256(attempt),
                claimEmail: claim ? email : null,
                emailCodeHash: claim ? emailCodeHash : null,
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
      await this.deliver(phone, code);
    } catch (err) {
      if (!(err instanceof SmsSendError)) throw err;
      this.logger.error(`Sign-up code was not sent: ${err.message}`);
      // Nothing was delivered: the text is given back and the person may ask again at once.
      await giveBack();
      await this.limits.forget('sms-phone-gap', phone);
      throw problem(
        503,
        'SMS_SEND_FAILED',
        'We could not send the code. Try again in a moment.',
      );
    }
    if (claim) await this.mailEmailCode(email, emailCode);
    return { ...this.shape(phone), attempt, emailCodeRequired: claim };
  }

  /**
   * Send another code to a pending sign-up, for whoever holds its `attempt`.
   * Anything else (an unknown number, a registered one that is not pending, a
   * proven one, a wrong or old secret) gets the same answer and no text, and
   * spends nothing but the caller's own address allowance.
   */
  async start(
    rawPhone: string,
    attempt: string,
    address: string,
  ): Promise<PhoneCodeSent> {
    const phone = this.requirePhone(rawPhone);
    this.requireProvider();
    await this.gateAddress(address);

    const code = this.newCode();
    const codeHash = await argon2.hash(code);
    const pending = await this.findByAttempt(phone, attempt);
    if (!pending) return this.shape(phone);

    const gap = await this.limits.hit(
      'sms-phone-gap',
      phone,
      1,
      this.settings.resendSeconds,
    );
    if (!gap.allowed) {
      throw problem(
        429,
        'PHONE_CODE_RESEND_TOO_SOON',
        'Wait before asking for another code.',
        gap.retryAfterSeconds,
      );
    }
    const day = await this.limits.hit(
      'sms-phone-day',
      phone,
      this.settings.phonePerDay,
      86400,
    );
    if (!day.allowed) {
      await this.limits.release('sms-phone-gap', phone);
      throw this.busy(day.retryAfterSeconds);
    }
    const all = await this.limits.hit(
      'sms-global',
      'all',
      this.settings.globalPerDay,
      86400,
    );
    if (!all.allowed) {
      await this.limits.release('sms-phone-gap', phone);
      await this.limits.release('sms-phone-day', phone);
      throw this.busy(all.retryAfterSeconds);
    }

    const now = new Date();
    const emailCode = this.newCode();
    await this.prisma.phoneVerification.update({
      where: { id: pending.id },
      data: {
        codeHash,
        expiresAt: this.codeExpiry(now),
        lastSentAt: now,
        ...(pending.claimEmail
          ? { emailCodeHash: await argon2.hash(emailCode) }
          : {}),
      },
    });
    // Not awaited: the answer must not take longer for a real sign-up than for
    // a made-up one.
    void this.deliver(phone, code).catch(async (err: unknown) => {
      this.logger.error(`Sign-up code was not sent: ${String(err)}`);
      await this.limits.release('sms-global', 'all');
    });
    if (pending.claimEmail) {
      void this.mailEmailCode(pending.claimEmail, emailCode);
    }
    return this.shape(phone);
  }

  // ── confirm ────────────────────────────────────────────────────────────────

  /** Check the code. Right: the phone is proven and a session is issued. */
  async confirm(
    rawPhone: string,
    attempt: string,
    code: string,
    emailCode: string | undefined,
    address: string,
  ): Promise<TokenPair & { user: UserResponse }> {
    const phone = normalisePhone(rawPhone);
    if (!phone || !phone.startsWith(this.settings.allowedPhonePrefix)) {
      throw WRONG_CODE();
    }
    const gate = await this.limits.hit(
      'confirm-ip',
      address,
      this.settings.confirmIpPerHour,
      3600,
    );
    if (!gate.allowed) throw this.busy(gate.retryAfterSeconds);

    const pending = await this.findByAttempt(phone, attempt);
    if (!pending) {
      // No such sign-up for this secret: the same work and the same answer as
      // a wrong code, and nothing of the number's is spent.
      await argon2.verify(await decoyHash(), code);
      throw WRONG_CODE();
    }

    // The guess is taken before the code is looked at, so parallel guesses
    // share one budget.
    const claim = await this.limits.claimGuess(phone, {
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
    const emailRight = pending.claimEmail
      ? !!emailCode &&
        (await argon2.verify(
          pending.emailCodeHash ?? (await decoyHash()),
          emailCode,
        ))
      : true;

    if (!live || !right || !emailRight) {
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
            'PHONE_ALREADY_CONFIRMED',
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
        return tx.wawuUser.update({
          where: { id: pending.userId },
          data: {
            phoneVerifiedAt: new Date(),
            // The number the code went to: the token vouches for the phone
            // only while the account still holds it (JOIN-03 round 2, D1).
            phoneVerifiedFor: pending.phone,
            ...(pending.claimEmail ? { email: pending.claimEmail } : {}),
          },
        });
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException(SAME_ACCOUNT);
      }
      throw err;
    }
    await this.limits.clearGuesses(phone);
    return this.auth.sessionFor(proven);
  }

  // ── resume ─────────────────────────────────────────────────────────────────

  /**
   * Where the sign-up this secret belongs to stands, for an app that was
   * closed between A3 and A4 (AUTH-05). Sends nothing and changes nothing. The
   * answer depends only on whether the caller holds a live secret for this
   * number, which nobody but the person who signed up can: a made-up secret,
   * a replaced one, an expired one and a confirmed one all answer `details`,
   * after the same single lookup by the secret's hash.
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
      emailCodeRequired: !!pending.claimEmail,
      accountType: pending.user.accountType ?? null,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** The number in the one form we text, or a 400 that depends only on what was typed. */
  private requirePhone(raw: string): string {
    const phone = normalisePhone(raw);
    if (!phone) {
      throw problem(400, 'PHONE_INVALID', 'Enter a valid phone number');
    }
    if (!phone.startsWith(this.settings.allowedPhonePrefix)) {
      throw problem(
        400,
        'PHONE_NOT_SUPPORTED',
        'We can only send codes to Nigerian phone numbers right now',
      );
    }
    return phone;
  }

  private requireProvider(): void {
    if (!this.sms.isConfigured()) {
      throw problem(
        503,
        'SMS_NOT_CONFIGURED',
        'Text messages are not available right now. Try again later.',
      );
    }
  }

  /**
   * The limits every caller meets whatever the number is: its address's share
   * (an hour and a day) and a look at whether the day's budget for the whole
   * service is already spent. Nothing here depends on whose number it is.
   */
  private async gateAddress(address: string): Promise<void> {
    const c = this.settings;
    const hour = await this.limits.hit('sms-ip', address, c.ipPerHour, 3600);
    if (!hour.allowed) throw this.busy(hour.retryAfterSeconds);
    const day = await this.limits.hit('sms-ip-day', address, c.ipPerDay, 86400);
    if (!day.allowed) throw this.busy(day.retryAfterSeconds);
    const all = await this.limits.isFull(
      'sms-global',
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
      'PHONE_CODE_LOCKED',
      'Too many wrong codes. Wait before trying again.',
      Math.max(1, retryAfterSeconds),
    );
  }

  private newCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  private codeExpiry(from: Date): Date {
    return new Date(from.getTime() + this.settings.codeTtlSeconds * 1000);
  }

  private shape(phone: string): PhoneCodeSent {
    return {
      phone,
      expiresIn: this.settings.codeTtlSeconds,
      resendIn: this.settings.resendSeconds,
    };
  }

  /** The pending sign-up this secret belongs to, if it is for this number, not proven and not expired. */
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
      row.user.phoneVerifiedAt ||
      row.phone !== phone ||
      row.signupExpiresAt <= new Date()
    ) {
      return null;
    }
    return row;
  }

  private async deliver(phone: string, code: string): Promise<void> {
    const minutes = Math.max(1, Math.round(this.settings.codeTtlSeconds / 60));
    await this.sms.send(
      phone,
      `Your WAWU code is ${code}. It expires in ${minutes} minutes. Do not share it with anyone.`,
    );
  }

  private async mailEmailCode(email: string, code: string): Promise<void> {
    try {
      await this.mail.sendOtpCode(email, code, 'verify your email address');
    } catch (err) {
      this.logger.error(`Email code was not sent: ${String(err)}`);
    }
  }
}
