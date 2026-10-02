import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** The answer to "may this go ahead", and if not, how long to wait. */
export interface Allowance {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface GuessRules {
  /** Wrong codes in a row that start a wait. */
  maxRun: number;
  lockoutSeconds: number;
  /** Wrong codes a number can take per day. */
  dailyCap: number;
}

export type GuessClaim =
  | { allowed: false; retryAfterSeconds: number }
  | {
      allowed: true;
      /** This guess uses the last one in the run: if it is wrong, the wait starts. */
      spent: boolean;
    };

/**
 * Counters that every instance shares, because they live in the database.
 * Abstract so a test can hand the service an in-memory one; production uses
 * DbRateLimiter.
 */
export abstract class RateLimiter {
  /** Count one use of `scope`/`key` in a fixed window; deny past `limit`. */
  abstract hit(
    scope: string,
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<Allowance>;

  /** Has `scope`/`key` already used `limit` in its current window? Counts nothing. */
  abstract isFull(
    scope: string,
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<Allowance>;

  /** Give back one use (a text that was reserved and never went out). */
  abstract release(scope: string, key: string): Promise<void>;

  /** Forget a counter (a text that was never delivered is not held against the person). */
  abstract forget(scope: string, key: string): Promise<void>;

  /**
   * Take one wrong-code guess for a phone number, atomically. Denied while the
   * wait is running and once the day's cap is spent.
   */
  abstract claimGuess(phone: string, rules: GuessRules): Promise<GuessClaim>;

  /** The code was right: the number starts clean. */
  abstract clearGuesses(phone: string): Promise<void>;
}

const DAY_MS = 24 * 3600 * 1000;

/** The shared counters, on Postgres. */
@Injectable()
export class DbRateLimiter extends RateLimiter {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async hit(
    scope: string,
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<Allowance> {
    // One statement, so parallel requests cannot both read the same count.
    // The clock is the database's, in UTC to match Prisma's TIMESTAMP columns.
    const rows = await this.prisma.$queryRaw<
      Array<{ count: number; retry: number }>
    >`
      INSERT INTO rate_counters (scope, key, window_start, count)
      VALUES (${scope}, ${key}, now() AT TIME ZONE 'UTC', 1)
      ON CONFLICT (scope, key) DO UPDATE SET
        count = CASE
          WHEN rate_counters.window_start <= (now() AT TIME ZONE 'UTC') - make_interval(secs => ${windowSeconds}::double precision)
          THEN 1 ELSE rate_counters.count + 1 END,
        window_start = CASE
          WHEN rate_counters.window_start <= (now() AT TIME ZONE 'UTC') - make_interval(secs => ${windowSeconds}::double precision)
          THEN now() AT TIME ZONE 'UTC' ELSE rate_counters.window_start END
      RETURNING count,
        EXTRACT(EPOCH FROM (window_start + make_interval(secs => ${windowSeconds}::double precision) - (now() AT TIME ZONE 'UTC')))::double precision AS retry`;
    const { count, retry } = rows[0];
    return {
      allowed: count <= limit,
      retryAfterSeconds: Math.max(1, Math.ceil(retry)),
    };
  }

  async isFull(
    scope: string,
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<Allowance> {
    const rows = await this.prisma.$queryRaw<
      Array<{ count: number; retry: number }>
    >`
      SELECT count,
        EXTRACT(EPOCH FROM (window_start + make_interval(secs => ${windowSeconds}::double precision) - (now() AT TIME ZONE 'UTC')))::double precision AS retry
      FROM rate_counters
      WHERE scope = ${scope} AND key = ${key}`;
    const row = rows[0];
    if (!row || row.retry <= 0 || row.count < limit) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return { allowed: false, retryAfterSeconds: Math.ceil(row.retry) };
  }

  async release(scope: string, key: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE rate_counters SET count = GREATEST(count - 1, 0)
      WHERE scope = ${scope} AND key = ${key}`;
  }

  async forget(scope: string, key: string): Promise<void> {
    await this.prisma.rateCounter.deleteMany({ where: { scope, key } });
  }

  async claimGuess(phone: string, rules: GuessRules): Promise<GuessClaim> {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      // Not Prisma's upsert: that is a read then an insert, and two parallel
      // first guesses would both insert.
      await tx.$executeRaw`
        INSERT INTO phone_guess_budgets (phone, run_count, day_start, day_count, updated_at)
        VALUES (${phone}, 0, ${now}, 0, ${now})
        ON CONFLICT (phone) DO NOTHING`;
      // Serialise parallel guesses for this number on the row lock.
      await tx.$queryRaw`SELECT phone FROM phone_guess_budgets WHERE phone = ${phone} FOR UPDATE`;
      const row = await tx.phoneGuessBudget.findUniqueOrThrow({
        where: { phone },
      });

      let { runCount, lockedUntil, dayStart, dayCount } = row;
      if (now.getTime() - dayStart.getTime() >= DAY_MS) {
        dayStart = now;
        dayCount = 0;
      }
      if (lockedUntil && lockedUntil > now) {
        return {
          allowed: false as const,
          retryAfterSeconds: Math.ceil(
            (lockedUntil.getTime() - now.getTime()) / 1000,
          ),
        };
      }
      if (lockedUntil) {
        lockedUntil = null;
        runCount = 0;
      }
      if (dayCount >= rules.dailyCap) {
        return {
          allowed: false as const,
          retryAfterSeconds: Math.ceil(
            (dayStart.getTime() + DAY_MS - now.getTime()) / 1000,
          ),
        };
      }

      runCount += 1;
      dayCount += 1;
      const spent = runCount >= rules.maxRun;
      if (spent) {
        lockedUntil = new Date(now.getTime() + rules.lockoutSeconds * 1000);
      }
      await tx.phoneGuessBudget.update({
        where: { phone },
        data: { runCount, lockedUntil, dayStart, dayCount },
      });
      return { allowed: true as const, spent };
    });
  }

  async clearGuesses(phone: string): Promise<void> {
    await this.prisma.phoneGuessBudget.deleteMany({ where: { phone } });
  }
}
