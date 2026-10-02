import {
  type Allowance,
  type GuessClaim,
  type GuessRules,
  RateLimiter,
} from '../auth/rate-limiter.service';

const DAY_MS = 24 * 3600 * 1000;

/**
 * The same rules as DbRateLimiter over a Map, for tests that run without a
 * database. The SQL itself is exercised by test/phone-signup.local.mjs. It is
 * only ever handed to a test module.
 */
export class MemoryRateLimiter extends RateLimiter {
  private readonly counters = new Map<
    string,
    { start: number; count: number }
  >();
  private readonly guesses = new Map<
    string,
    { run: number; lockedUntil: number | null; dayStart: number; day: number }
  >();

  hit(
    scope: string,
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<Allowance> {
    const now = Date.now();
    const id = `${scope}|${key}`;
    let c = this.counters.get(id);
    if (!c || c.start + windowSeconds * 1000 <= now)
      c = { start: now, count: 0 };
    c.count += 1;
    this.counters.set(id, c);
    return Promise.resolve({
      allowed: c.count <= limit,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((c.start + windowSeconds * 1000 - now) / 1000),
      ),
    });
  }

  isFull(
    scope: string,
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<Allowance> {
    const now = Date.now();
    const c = this.counters.get(`${scope}|${key}`);
    const end = c ? c.start + windowSeconds * 1000 : 0;
    if (!c || end <= now || c.count < limit) {
      return Promise.resolve({ allowed: true, retryAfterSeconds: 0 });
    }
    return Promise.resolve({
      allowed: false,
      retryAfterSeconds: Math.ceil((end - now) / 1000),
    });
  }

  release(scope: string, key: string): Promise<void> {
    const c = this.counters.get(`${scope}|${key}`);
    if (c) c.count = Math.max(0, c.count - 1);
    return Promise.resolve();
  }

  forget(scope: string, key: string): Promise<void> {
    this.counters.delete(`${scope}|${key}`);
    return Promise.resolve();
  }

  claimGuess(phone: string, rules: GuessRules): Promise<GuessClaim> {
    const now = Date.now();
    const g = this.guesses.get(phone) ?? {
      run: 0,
      lockedUntil: null,
      dayStart: now,
      day: 0,
    };
    if (now - g.dayStart >= DAY_MS) {
      g.dayStart = now;
      g.day = 0;
    }
    this.guesses.set(phone, g);
    if (g.lockedUntil && g.lockedUntil > now) {
      return Promise.resolve({
        allowed: false,
        retryAfterSeconds: Math.ceil((g.lockedUntil - now) / 1000),
      });
    }
    if (g.lockedUntil) {
      g.lockedUntil = null;
      g.run = 0;
    }
    if (g.day >= rules.dailyCap) {
      return Promise.resolve({
        allowed: false,
        retryAfterSeconds: Math.ceil((g.dayStart + DAY_MS - now) / 1000),
      });
    }
    g.run += 1;
    g.day += 1;
    const spent = g.run >= rules.maxRun;
    if (spent) g.lockedUntil = now + rules.lockoutSeconds * 1000;
    return Promise.resolve({ allowed: true, spent });
  }

  clearGuesses(phone: string): Promise<void> {
    this.guesses.delete(phone);
    return Promise.resolve();
  }
}
