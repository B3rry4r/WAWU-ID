import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WawuUser } from '@prisma/client';
import * as argon2 from 'argon2';
import { createHash, randomInt } from 'crypto';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  phoneVerificationConfig,
  type PhoneVerificationConfig,
} from './phone-verification.config';
import { RateLimiter } from './rate-limiter.service';
import {
  signupSequenceConfig,
  type SignupSequenceConfig,
} from './signup-sequence.config';
import {
  isDone,
  nextStep,
  STEP_COLUMN,
  stepsFor,
  type AfterPhoneStep,
  type ProgressRecord,
} from './signup-sequence';

/** Where a signed-in account stands in the sign-up sequence. */
export interface SignupProgressView {
  /** The next step, or `done`. */
  step: AfterPhoneStep | 'done';
  /** False for every account that did not come through the mobile sign-up: there is nothing to finish. */
  inSequence: boolean;
  /** 'user' or 'creator', or null when the account never said. */
  accountType: string | null;
  /** This account's steps after the phone code, in order. Empty when not in the sequence. */
  steps: AfterPhoneStep[];
  /** The account's email has been proven (a code mailed to it was entered). */
  emailProven: boolean;
}

/** What asking for an email code answers. */
export interface EmailCodeSent {
  /** The address the code went to: the account's own. */
  email: string;
  /** Seconds the code can be used for. */
  expiresIn: number;
  /** Seconds until another code can be asked for. */
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

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** A hash to check against when there is no live code, so the work is the same. */
let dummyHash: Promise<string> | undefined;
const decoyHash = () => (dummyHash ??= argon2.hash('no email code'));

/**
 * The sign-up sequence after the phone code (AUTH-05): where an account
 * stands, completing one step at a time and only the next one, and proving
 * the email with a mailed code (BACKEND_GAPS G-27: an email that was never
 * proven gets no reset mail, so a proven one gives the person a reset path).
 *
 * Every route here needs a session, which a mobile sign-up only has once its
 * phone code is confirmed, so the steps before (A3, A4) cannot be skipped by
 * calling these.
 */
@Injectable()
export class SignupSequenceService {
  private readonly logger = new Logger(SignupSequenceService.name);
  private readonly settings: SignupSequenceConfig;
  private readonly guesses: PhoneVerificationConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly limits: RateLimiter,
    private readonly mail: MailService,
    config: ConfigService,
  ) {
    this.settings = signupSequenceConfig(config);
    this.guesses = phoneVerificationConfig(config);
  }

  // ── where the account stands ───────────────────────────────────────────────

  async progress(user: WawuUser): Promise<SignupProgressView> {
    return this.view(user, await this.record(user));
  }

  /**
   * Complete `step`. Allowed only when it is the next step; a step already
   * done answers the progress as it is (a repeated tap changes nothing).
   */
  async complete(
    user: WawuUser,
    step: AfterPhoneStep,
  ): Promise<SignupProgressView> {
    // Made outside the transaction: a unique-key clash inside one would abort it.
    await this.record(user);
    return this.prisma.$transaction(async (tx) => {
      // One completion at a time per account, so two taps cannot both pass
      // the order check against the same state.
      await tx.$queryRaw`SELECT user_id FROM signup_progress WHERE user_id = ${user.id}::uuid FOR UPDATE`;
      const row = await tx.signupProgress.findUnique({
        where: { userId: user.id },
      });
      const account = await tx.wawuUser.findUniqueOrThrow({
        where: { id: user.id },
      });
      const finished = () =>
        problem(
          409,
          'SIGNUP_ALREADY_FINISHED',
          'Your sign-up is already finished.',
        );
      if (!row) throw finished();
      if (!stepsFor(account.accountType).includes(step)) {
        throw problem(
          409,
          'SIGNUP_STEP_OUT_OF_ORDER',
          'That step is not part of your sign-up.',
        );
      }
      if (isDone(step, account, row)) return this.view(account, row);
      if (row.completedAt) throw finished();
      if (nextStep(account, row) !== step) {
        throw problem(
          409,
          'SIGNUP_STEP_OUT_OF_ORDER',
          'Finish the earlier sign-up steps first.',
        );
      }

      const now = new Date();
      const after: ProgressRecord = { ...row, [STEP_COLUMN[step]]: now };
      const updated = await tx.signupProgress.update({
        where: { userId: user.id },
        data: {
          [STEP_COLUMN[step]]: now,
          ...(nextStep(account, after) === 'done' ? { completedAt: now } : {}),
        },
      });
      return this.view(account, updated);
    });
  }

  // ── proving the email ──────────────────────────────────────────────────────

  /** Mail a code to the account's own email. Nothing else is ever mailed here. */
  async emailStart(user: WawuUser): Promise<EmailCodeSent> {
    const email = this.unprovenEmail(user);

    const gap = await this.limits.hit(
      'email-code-gap',
      user.id,
      1,
      this.settings.emailResendSeconds,
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
      'email-code-day',
      user.id,
      this.settings.emailPerDay,
      86400,
    );
    if (!day.allowed) {
      await this.limits.release('email-code-gap', user.id);
      throw problem(
        429,
        'RATE_LIMITED',
        'Too many requests. Try again later.',
        Math.max(1, day.retryAfterSeconds),
      );
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const now = new Date();
    const record = {
      emailHash: sha256(email),
      codeHash: await argon2.hash(code),
      expiresAt: new Date(
        now.getTime() + this.settings.emailCodeTtlSeconds * 1000,
      ),
      lastSentAt: now,
      usedAt: null,
    };
    await this.prisma.signupEmailCode.upsert({
      where: { userId: user.id },
      create: { userId: user.id, ...record },
      update: record,
    });
    await this.mail.sendOtpCode(email, code, 'confirm your email address');
    return {
      email,
      expiresIn: this.settings.emailCodeTtlSeconds,
      resendIn: this.settings.emailResendSeconds,
    };
  }

  /**
   * Check the mailed code. Right: the email is proven and the email step is
   * done. The same right code sent again while it lives (a double tap, at
   * once or after) gets the same success; any other code once the email is
   * proven gets EMAIL_ALREADY_PROVEN, as before.
   */
  async emailConfirm(
    user: WawuUser,
    code: string,
  ): Promise<SignupProgressView> {
    if (user.email && user.emailVerified) {
      if (await this.repeatOfProof(user, code)) return this.progress(user);
    }
    const email = this.unprovenEmail(user);

    // The guess is taken before the code is looked at, so parallel guesses
    // share one budget. Same rules as the phone code.
    const claim = await this.limits.claimGuess(`email:${user.id}`, {
      maxRun: this.guesses.maxWrongCodes,
      lockoutSeconds: this.guesses.lockoutSeconds,
      dailyCap: this.guesses.dailyWrongCap,
    });
    if (!claim.allowed) throw this.locked(claim.retryAfterSeconds);

    const row = await this.prisma.signupEmailCode.findUnique({
      where: { userId: user.id },
    });
    // A code proves only the address it was sent to, only while it lives,
    // and only once.
    const live =
      !!row &&
      !row.usedAt &&
      row.expiresAt > new Date() &&
      row.emailHash === sha256(email);
    const right = await argon2.verify(
      live ? row.codeHash : await decoyHash(),
      code,
    );
    if (!live || !right) {
      const repeat = await this.parallelProof(user, code);
      if (repeat) return repeat;
      throw claim.spent
        ? this.locked(this.guesses.lockoutSeconds)
        : problem(400, 'EMAIL_CODE_INVALID', "That code isn't right");
    }

    const proven = await this.prisma.$transaction(async (tx) => {
      const used = await tx.signupEmailCode.updateMany({
        where: { userId: user.id, codeHash: row.codeHash, usedAt: null },
        data: { usedAt: new Date() },
      });
      // Proven only if the account still holds that address unproven: an
      // email that moved to another account meanwhile is not marked here.
      const marked = await tx.wawuUser.updateMany({
        where: { id: user.id, email, emailVerified: false },
        data: { emailVerified: true },
      });
      if (used.count === 0 || marked.count === 0) return null;
      return tx.wawuUser.findUniqueOrThrow({ where: { id: user.id } });
    });
    if (!proven) {
      const repeat = await this.parallelProof(user, code);
      if (repeat) return repeat;
      throw problem(400, 'EMAIL_CODE_INVALID', "That code isn't right");
    }
    await this.limits.clearGuesses(`email:${user.id}`);
    return this.progress(proven);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Did this very code just prove this account's email (and does it still live)? */
  private async repeatOfProof(user: WawuUser, code: string): Promise<boolean> {
    const row = await this.prisma.signupEmailCode.findUnique({
      where: { userId: user.id },
    });
    if (
      !row?.usedAt ||
      !user.email ||
      row.expiresAt <= new Date() ||
      row.emailHash !== sha256(user.email)
    ) {
      return false;
    }
    return argon2.verify(row.codeHash, code);
  }

  /**
   * A tap that lost the race to a parallel tap carrying the same right code:
   * the account is proven now, so it answers the same success. The guess it
   * took is given back with the rest.
   */
  private async parallelProof(
    user: WawuUser,
    code: string,
  ): Promise<SignupProgressView | null> {
    const now = await this.prisma.wawuUser.findUniqueOrThrow({
      where: { id: user.id },
    });
    if (!now.emailVerified || !(await this.repeatOfProof(now, code))) {
      return null;
    }
    await this.limits.clearGuesses(`email:${user.id}`);
    return this.progress(now);
  }

  /**
   * The account's record in the sequence. An account is in the sequence when
   * it came through the mobile sign-up, which is exactly when its phone was
   * proven (`phone_verified_at`: only POST /auth/phone/verify/confirm sets
   * it). Its record is made the first time it is asked for. Every other
   * account (web, legacy, phone-only) has none and gets none.
   */
  private async record(user: WawuUser) {
    const read = () =>
      this.prisma.signupProgress.findUnique({ where: { userId: user.id } });
    const row = await read();
    if (row || !user.phoneVerifiedAt) return row;
    try {
      return await this.prisma.signupProgress.upsert({
        where: { userId: user.id },
        create: { userId: user.id },
        update: {},
      });
    } catch (err) {
      // Two first calls at once (a double tap, a cold start racing the step
      // after A4): Prisma's upsert reads then inserts, so the slower one hits
      // the primary key. The faster one made the record; read it.
      if ((err as { code?: string }).code !== 'P2002') throw err;
      return read();
    }
  }

  private unprovenEmail(user: WawuUser): string {
    if (!user.email) {
      throw problem(409, 'EMAIL_NOT_SET', 'There is no email on this account.');
    }
    if (user.emailVerified) {
      throw problem(
        409,
        'EMAIL_ALREADY_PROVEN',
        'This email is already confirmed.',
      );
    }
    return user.email;
  }

  private locked(retryAfterSeconds: number): HttpException {
    return problem(
      429,
      'EMAIL_CODE_LOCKED',
      'Too many wrong codes. Wait before trying again.',
      Math.max(1, retryAfterSeconds),
    );
  }

  private view(
    user: WawuUser,
    row: (ProgressRecord & { completedAt: Date | null }) | null,
  ): SignupProgressView {
    const accountType = user.accountType ?? null;
    const emailProven = !!user.email && user.emailVerified;
    if (!row) {
      return {
        step: 'done',
        inSequence: false,
        accountType,
        steps: [],
        emailProven,
      };
    }
    return {
      step: row.completedAt ? 'done' : nextStep(user, row),
      inSequence: true,
      accountType,
      steps: stepsFor(accountType),
      emailProven,
    };
  }
}
