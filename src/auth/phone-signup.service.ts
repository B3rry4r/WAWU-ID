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
import { randomInt } from 'crypto';
import { normalisePhone, phoneVariants } from '../common/phone.util';
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

/**
 * Mobile sign-up with a phone code (AUTH-03).
 *
 * `signup` creates the account and texts a 6-digit code to the phone. It
 * issues NO session: the person gets one from `confirm`, once the code is
 * right. The routes here act ONLY on a pending sign-up: an account created by
 * `signup` that has a live `phone_verifications` row and has not proven its
 * phone. No other account, however old, can be texted or confirmed through
 * them, so a code never mints a session for an account that did not come from
 * sign-up.
 *
 * `start` and `confirm` answer the same way for a number nobody registered, a
 * number that is registered but not pending, and one that is pending, and do
 * the same work (a hash, a counter) in each case.
 */
@Injectable()
export class PhoneSignupService {
  private readonly logger = new Logger(PhoneSignupService.name);
  private readonly settings: PhoneVerificationConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    config: ConfigService,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    private readonly limits: RateLimiter,
  ) {
    this.settings = phoneVerificationConfig(config);
  }

  // ── sign up ────────────────────────────────────────────────────────────────

  async signup(dto: SignupDto, address: string): Promise<PhoneCodeSent> {
    const phone = this.requirePhone(dto.phone);
    this.requireProvider();
    await this.throttleSend(address, phone);

    const email = dto.email.toLowerCase().trim();
    const code = this.newCode();
    const codeHash = await argon2.hash(code);
    const passwordHash = await argon2.hash(dto.password);
    const now = new Date();
    const variants = phoneVariants(phone);

    try {
      await this.prisma.$transaction(async (tx) => {
        const clashes = await tx.wawuUser.findMany({
          where: { OR: [{ email }, { phone: { in: variants } }] },
          include: { phoneVerification: true },
        });
        for (const other of clashes) {
          if (other.phoneVerification && !other.phoneVerifiedAt) {
            // An unproven sign-up holds nothing: a newer sign-up takes its
            // email and phone, and it is gone.
            await tx.wawuUser.deleteMany({ where: { id: other.id } });
          } else if (
            other.email === email &&
            !variants.includes(other.phone) &&
            other.phoneVerifiedAt &&
            !other.emailVerified
          ) {
            // A mobile account whose email nobody ever proved. The email is
            // only a claim there, so the person who is signing up with it now
            // takes it; the other account keeps its proven phone and signs
            // in with that.
            await tx.wawuUser.update({
              where: { id: other.id },
              data: { email: null },
            });
          } else {
            throw new ConflictException(SAME_ACCOUNT);
          }
        }

        await tx.wawuUser.create({
          data: {
            email,
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
      // Nothing was delivered: the person may ask again at once.
      await this.limits.forget('sms-phone-gap', phone);
      throw problem(
        503,
        'SMS_SEND_FAILED',
        'We could not send the code. Try again in a moment.',
      );
    }
    return this.shape(phone);
  }

  /**
   * Send another code to a pending sign-up. Anything else (an unknown number,
   * a registered one that is not pending, a proven one) gets the same answer
   * and no text.
   */
  async start(rawPhone: string, address: string): Promise<PhoneCodeSent> {
    const phone = this.requirePhone(rawPhone);
    this.requireProvider();
    await this.throttleSend(address, phone);

    const code = this.newCode();
    const codeHash = await argon2.hash(code);
    const pending = await this.findPending(phone);
    if (pending) {
      const now = new Date();
      await this.prisma.phoneVerification.update({
        where: { id: pending.id },
        data: {
          codeHash,
          expiresAt: this.codeExpiry(now),
          lastSentAt: now,
        },
      });
      // Not awaited: the answer must not take longer for a number that is
      // pending than for one that is not.
      void this.deliver(phone, code).catch((err: unknown) => {
        this.logger.error(`Sign-up code was not sent: ${String(err)}`);
      });
    }
    return this.shape(phone);
  }

  // ── confirm ────────────────────────────────────────────────────────────────

  /** Check the code. Right: the phone is proven and a session is issued. */
  async confirm(
    rawPhone: string,
    code: string,
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

    // The guess is taken before the code is looked at, for every number alike,
    // so parallel guesses share one budget and an unknown number runs out of
    // guesses exactly as a pending one does.
    const claim = await this.limits.claimGuess(phone, {
      maxRun: this.settings.maxWrongCodes,
      lockoutSeconds: this.settings.lockoutSeconds,
      dailyCap: this.settings.dailyWrongCap,
    });
    if (!claim.allowed) throw this.locked(claim.retryAfterSeconds);

    const pending = await this.findPending(phone);
    const live = !!pending && pending.expiresAt > new Date();
    const right = await argon2.verify(
      live ? pending.codeHash : await decoyHash(),
      code,
    );

    if (!live || !right) {
      throw claim.spent
        ? this.locked(this.settings.lockoutSeconds)
        : WRONG_CODE();
    }

    const proven = await this.prisma.$transaction(async (tx) => {
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
      return tx.wawuUser.update({
        where: { id: pending.userId },
        data: { phoneVerifiedAt: new Date() },
      });
    });
    await this.limits.clearGuesses(phone);
    return this.auth.sessionFor(proven);
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
   * The limits on asking for a text. Every one of them counts the request
   * whatever the number is, so none of them can tell a registered number from
   * an unregistered one.
   */
  private async throttleSend(address: string, phone: string): Promise<void> {
    const c = this.settings;
    const ip = await this.limits.hit('sms-ip', address, c.ipPerHour, 3600);
    if (!ip.allowed) throw this.busy(ip.retryAfterSeconds);

    const gap = await this.limits.hit(
      'sms-phone-gap',
      phone,
      1,
      c.resendSeconds,
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
      c.phonePerDay,
      86400,
    );
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
      retryAfterSeconds,
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

  /** The pending sign-up for this number: a live row, the phone not proven, not expired. */
  private async findPending(phone: string): Promise<Pending | null> {
    const users = await this.prisma.wawuUser.findMany({
      where: { phone: { in: phoneVariants(phone) } },
      include: { phoneVerification: true },
    });
    const now = new Date();
    for (const user of users) {
      const row = user.phoneVerification;
      if (
        row &&
        !user.phoneVerifiedAt &&
        row.phone === phone &&
        row.signupExpiresAt > now
      ) {
        return { ...row, user };
      }
    }
    return null;
  }

  private async deliver(phone: string, code: string): Promise<void> {
    await this.limits.hit('sms-global', 'all', Number.MAX_SAFE_INTEGER, 86400);
    const minutes = Math.max(1, Math.round(this.settings.codeTtlSeconds / 60));
    await this.sms.send(
      phone,
      `Your WAWU code is ${code}. It expires in ${minutes} minutes. Do not share it with anyone.`,
    );
  }
}
