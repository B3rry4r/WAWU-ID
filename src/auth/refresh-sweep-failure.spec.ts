/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- an in-memory stand-in for the few Prisma calls, rows are untyped by design */
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { WawuUser } from '@prisma/client';
import { generateKeyPairSync, randomUUID } from 'crypto';
import { MemoryRateLimiter } from '../testing/memory-rate-limiter';
import { SessionSecurityService } from './session-security.service';
import { TokensService } from './tokens.service';

type Row = Record<string, any>;

const pair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const ABORTED =
  'current transaction is aborted, commands ignored until end of transaction block';

/**
 * FIX-13 (AUTH-08 follow-up F-1): the sweep of expired refresh-token records
 * never fails a sign-in, a refresh or a sign-out.
 *
 * The stand-in below behaves like Postgres where it matters here: once a
 * statement fails inside a transaction, the transaction is aborted, every
 * statement after it fails ("current transaction is aborted"), and the work
 * done in it is rolled back. A swallowed error inside the transaction does not
 * save it, which is exactly how a failing sweep used to turn a refresh into a
 * 500. It also records, per statement, whether it ran inside a transaction.
 */
function fakePrisma() {
  const users = new Map<string, Row>();
  let rows: Row[] = [];
  let seq = 0;
  const locks = new Map<string, Promise<void>>();
  /** Every refreshToken statement, with where it ran. */
  const log: Array<{ op: string; inTx: boolean; where: Row }> = [];
  /** Set by a spec: a statement for which this returns an error message fails. */
  let fail: ((op: string, where: Row) => string | undefined) | undefined;

  const matches = (r: Row, where: Row) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        const t = (r[k] as Date).getTime();
        if ('gt' in v && !(t > v.gt.getTime())) return false;
        if ('lte' in v && !(t <= v.lte.getTime())) return false;
        return true;
      }
      return (r[k] ?? null) === v;
    });

  const build = (scope: { inTx: boolean; aborted?: boolean }) => {
    const run = <T>(op: string, where: Row, body: () => T): Promise<T> => {
      log.push({ op, inTx: scope.inTx, where });
      if (scope.aborted) return Promise.reject(new Error(ABORTED));
      const message = fail?.(op, where);
      if (message) {
        if (scope.inTx) scope.aborted = true;
        return Promise.reject(new Error(message));
      }
      return Promise.resolve(body());
    };
    return {
      wawuUser: {
        findUnique: ({ where }: Row) =>
          Promise.resolve(
            users.has(where.id) ? { ...users.get(where.id) } : null,
          ),
      },
      phoneVerification: { findUnique: () => Promise.resolve(null) },
      refreshToken: {
        create: ({ data }: Row) =>
          run('create', data, () => {
            rows.push({ id: `r${++seq}`, jti: null, ...data });
          }),
        findMany: ({ where, take }: Row) =>
          run('findMany', where, () => {
            const found = rows.filter((r) => matches(r, where));
            return take ? found.slice(0, take) : found;
          }),
        deleteMany: ({ where }: Row) =>
          run('deleteMany', where, () => {
            const before = rows.length;
            rows = rows.filter((r) => !matches(r, where));
            return { count: before - rows.length };
          }),
      },
    };
  };

  const api: any = {
    users,
    log,
    get rows() {
      return rows;
    },
    set rows(v: Row[]) {
      rows = v;
    },
    failWhen: (f: typeof fail) => {
      fail = f;
    },
    ...build({ inTx: false }),
    $transaction: async (fn: (tx: unknown) => unknown) => {
      const scope: { inTx: boolean; aborted: boolean } = {
        inTx: true,
        aborted: false,
      };
      const snapshot = rows.map((r) => ({ ...r }));
      const held: Array<() => void> = [];
      const tx: any = {
        ...build(scope),
        $queryRaw: async (_s: unknown, userId: string) => {
          while (locks.get(userId)) await locks.get(userId);
          let release!: () => void;
          locks.set(userId, new Promise<void>((r) => (release = r)));
          held.push(() => {
            locks.delete(userId);
            release();
          });
        },
      };
      try {
        const out = await fn(tx);
        if (scope.aborted) {
          // Postgres commits an aborted transaction as a rollback.
          rows = snapshot;
          throw new Error(ABORTED);
        }
        return out;
      } catch (err) {
        rows = snapshot;
        throw err;
      } finally {
        held.forEach((h) => h());
      }
    },
  };
  return api;
}

describe('FIX-13: a failed sweep never fails the sign-in, refresh or sign-out', () => {
  jest.setTimeout(60_000);
  const env: Record<string, string> = {
    JWT_EXPIRES_IN: '15m',
    REFRESH_EXPIRES_IN: '30d',
  };
  const jwt = new JwtService({
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    signOptions: { algorithm: 'RS256' },
    verifyOptions: { algorithms: ['RS256'] },
  });
  let prisma: ReturnType<typeof fakePrisma>;
  let tokens: TokensService;
  let service: SessionSecurityService;
  let warn: jest.SpyInstance;

  const user = (id: string): Row => ({
    id,
    email: `${id}@example.test`,
    phone: '+2348031234412',
    firstName: 'A',
    middleName: null,
    lastName: 'B',
    country: null,
    verificationTier: 'basic',
    trustScore: 0,
    creatorVerifiedAt: null,
    creatorVerifiedUntil: null,
    professionalVerifiedAt: null,
    professionalVerifiedUntil: null,
    status: 'active',
    wawuafricaAppUserId: null,
    onboardingRef: null,
    beautyUserId: null,
    basketUserId: null,
    phoneVerifiedAt: new Date(),
    passwordHash: null,
  });
  const signIn = (id: string) =>
    tokens.issueTokens({ ...prisma.users.get(id)! } as WawuUser);
  const addExpired = (userId: string, n: number) => {
    for (let i = 0; i < n; i++) {
      prisma.rows.push({
        id: `exp-${userId}-${i}`,
        userId,
        jti: randomUUID(),
        tokenHash: 'x',
        expiresAt: new Date(Date.now() - (i + 1) * 60_000),
      });
    }
  };
  const expiredRows = () =>
    prisma.rows.filter((r: Row) => r.expiresAt.getTime() <= Date.now());
  const isExpiredId = (id: unknown) =>
    expiredRows().some((r: Row) => r.id === id);
  /** A database that refuses to delete an expired row (the verifier's trigger). */
  const refuseExpiredDeletes = () =>
    prisma.failWhen((op: string, where: Row) =>
      op === 'deleteMany' && isExpiredId(where.id)
        ? 'sweep refused: expired rows are locked'
        : undefined,
    );
  /** A database that fails the sweep's read of the expired rows. */
  const refuseExpiredReads = () =>
    prisma.failWhen((op: string, where: Row) =>
      op === 'findMany' && where.expiresAt?.lte
        ? 'sweep refused: lock timeout'
        : undefined,
    );

  beforeEach(() => {
    prisma = fakePrisma();
    prisma.users.set('alice', user('alice'));
    tokens = new TokensService(
      jwt,
      {
        get: (k: string) => env[k],
        getOrThrow: (k: string) => env[k],
      } as never,
      { kid: 'k1' } as never,
      prisma as never,
    );
    service = new SessionSecurityService(
      prisma as never,
      tokens,
      new MemoryRateLimiter(),
    );
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => warn.mockRestore());

  describe.each([
    ['a delete of an expired record is refused', refuseExpiredDeletes],
    ['the read of the expired records fails', refuseExpiredReads],
  ])('when %s', (_name, breakSweep) => {
    it('the refresh answers with a new token, and the old one is spent', async () => {
      const mine = await signIn('alice');
      addExpired('alice', 3);
      breakSweep();

      const next = await tokens.rotateRefreshToken(mine.refreshToken);

      expect(next.refreshToken).toEqual(expect.any(String));
      expect(next.refreshToken).not.toBe(mine.refreshToken);
      // State, not just the answer: the spent token's record is gone, the new
      // one is stored and works, and the sweep did not run to completion.
      expect(prisma.rows.filter((r: Row) => !isExpiredId(r.id))).toHaveLength(
        1,
      );
      expect(expiredRows()).toHaveLength(3);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Could not prune expired refresh tokens'),
      );
      prisma.failWhen(undefined);
      await expect(
        tokens.rotateRefreshToken(next.refreshToken),
      ).resolves.toBeDefined();
      await expect(
        tokens.rotateRefreshToken(mine.refreshToken),
      ).rejects.toThrow('Invalid refresh token');
    });

    it('a sign-in answers with a pair that works', async () => {
      addExpired('alice', 3);
      breakSweep();
      const first = await signIn('alice');
      prisma.failWhen(undefined);
      await expect(
        tokens.rotateRefreshToken(first.refreshToken),
      ).resolves.toBeDefined();
    });

    it('a sign-out signs out', async () => {
      const mine = await signIn('alice');
      addExpired('alice', 3);
      breakSweep();
      await service.logout(mine.refreshToken, '10.0.0.1');
      prisma.failWhen(undefined);
      await expect(
        tokens.rotateRefreshToken(mine.refreshToken),
      ).rejects.toThrow('Invalid refresh token');
    });

    it('the next refresh, once the cause is gone, takes the backlog', async () => {
      const mine = await signIn('alice');
      addExpired('alice', 3);
      breakSweep();
      const next = await tokens.rotateRefreshToken(mine.refreshToken);
      prisma.failWhen(undefined);
      await tokens.rotateRefreshToken(next.refreshToken);
      expect(expiredRows()).toHaveLength(0);
    });
  });

  it('the sweep of a refresh runs after the rotation has committed, never inside its transaction', async () => {
    const mine = await signIn('alice');
    addExpired('alice', 2);
    prisma.log.length = 0;
    await tokens.rotateRefreshToken(mine.refreshToken);

    const sweepOps = prisma.log.filter(
      (e: { op: string; where: Row }) =>
        (e.op === 'findMany' && e.where.expiresAt?.lte) ||
        (e.op === 'deleteMany' && String(e.where.id).startsWith('exp-')),
    );
    expect(sweepOps.length).toBeGreaterThan(0);
    expect(sweepOps.every((e: { inTx: boolean }) => !e.inTx)).toBe(true);
    // The rotation itself did run inside its transaction.
    const inside = prisma.log.filter((e: { inTx: boolean }) => e.inTx);
    expect(inside.map((e: { op: string }) => e.op)).toEqual([
      'deleteMany',
      'create',
    ]);
    expect(expiredRows()).toHaveLength(0);
  });

  it('a refused refresh sweeps nothing and changes nothing', async () => {
    const mine = await signIn('alice');
    await tokens.rotateRefreshToken(mine.refreshToken);
    addExpired('alice', 2);
    prisma.log.length = 0;
    await expect(tokens.rotateRefreshToken(mine.refreshToken)).rejects.toThrow(
      'Invalid refresh token',
    );
    expect(expiredRows()).toHaveLength(2);
  });
});
