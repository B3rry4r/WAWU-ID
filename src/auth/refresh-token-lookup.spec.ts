/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- an in-memory stand-in for the few Prisma calls, rows are untyped by design */
import { JwtService } from '@nestjs/jwt';
import type { WawuUser } from '@prisma/client';
import * as argon2 from 'argon2';
import { generateKeyPairSync, randomUUID } from 'crypto';
import { MemoryRateLimiter } from '../testing/memory-rate-limiter';
import { SessionSecurityService } from './session-security.service';
import { TokensService } from './tokens.service';

// Counts every hash check, so a spec can say HOW MANY were paid for, not only
// how long the call took on a machine that is busy with something else.
let verifies = 0;
jest.mock('argon2', () => {
  const actual = jest.requireActual('argon2');
  return {
    ...actual,
    verify: (...args: unknown[]) => {
      verifies += 1;
      return actual.verify(...args);
    },
  };
});

type Row = Record<string, any>;

const pair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/**
 * The Prisma calls the refresh-token code makes, over plain rows, and unlike a
 * loose stand-in this one HONOURS the filters it is given (userId, jti
 * including null, expiresAt gt/lte, id), so a query that forgets one is
 * caught here. The jti column is unique, as in the migration.
 */
function fakePrisma() {
  const users = new Map<string, Row>();
  let rows: Row[] = [];
  let seq = 0;
  const locks = new Map<string, Promise<void>>();
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
  const api: any = {
    users,
    get rows() {
      return rows;
    },
    set rows(v: Row[]) {
      rows = v;
    },
    wawuUser: {
      findUnique: ({ where }: Row) =>
        Promise.resolve(
          users.has(where.id) ? { ...users.get(where.id) } : null,
        ),
      update: ({ where, data }: Row) => {
        const row = users.get(where.id)!;
        Object.assign(row, data);
        return Promise.resolve({ ...row });
      },
    },
    phoneVerification: { findUnique: () => Promise.resolve(null) },
    passwordResetToken: { deleteMany: () => Promise.resolve({ count: 0 }) },
    refreshToken: {
      create: ({ data }: Row) => {
        if (data.jti != null && rows.some((r) => r.jti === data.jti)) {
          return Promise.reject(new Error('Unique constraint failed: jti'));
        }
        rows.push({ id: `r${++seq}`, jti: null, ...data });
        return Promise.resolve();
      },
      findMany: ({ where, take }: Row) => {
        const found = rows.filter((r) => matches(r, where));
        return Promise.resolve(take ? found.slice(0, take) : found);
      },
      deleteMany: async ({ where }: Row) => {
        const before = rows.length;
        rows = rows.filter((r) => !matches(r, where));
        await new Promise((r) => setTimeout(r, Math.random() * 3));
        return { count: before - rows.length };
      },
    },
    $transaction: async (fn: (tx: unknown) => unknown) => {
      const held: Array<() => void> = [];
      const tx = Object.create(api);
      tx.$queryRaw = async (_s: unknown, userId: string) => {
        while (locks.get(userId)) await locks.get(userId);
        let release!: () => void;
        locks.set(userId, new Promise<void>((r) => (release = r)));
        held.push(() => {
          locks.delete(userId);
          release();
        });
      };
      try {
        return await fn(tx);
      } finally {
        held.forEach((h) => h());
      }
    },
  };
  return api;
}

describe('AUTH-08: refresh and sign-out find the token by its id', () => {
  jest.setTimeout(600_000);
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
  let decoyHash: string;
  const DAY = 24 * 60 * 60 * 1000;

  const user = (id: string, hash: string | null = null): Row => ({
    id,
    email: `${id}@example.test`,
    phone: `+23480312344${id.length}`,
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
    passwordHash: hash,
  });
  const live = (id: string) => ({ ...prisma.users.get(id)! }) as WawuUser;
  const signIn = (id: string) => tokens.issueTokens(live(id));
  const refreshes = (t: string) =>
    tokens.rotateRefreshToken(t).then(
      () => true,
      () => false,
    );
  /** What a token minted before AUTH-08 is: its row has no jti. */
  const legacyToken = async (
    id: string,
    opts: { withJti?: boolean; ttl?: number } = {},
  ) => {
    const token = await jwt.signAsync(
      {
        sub: id,
        ...(opts.withJti === false ? {} : { jti: randomUUID() }),
        type: 'refresh',
      },
      { algorithm: 'RS256', expiresIn: opts.ttl ?? 30 * 24 * 60 * 60 },
    );
    const { exp } = jwt.decode(token);
    prisma.rows.push({
      id: `legacy-${randomUUID()}`,
      userId: id,
      jti: null,
      tokenHash: await argon2.hash(token),
      expiresAt: new Date(exp * 1000),
    });
    return token;
  };
  /** n rows the account already holds: real argon2 hashes, none of them the token. */
  const fillWithOtherTokens = (id: string, n: number, withJti = true) => {
    for (let i = 0; i < n; i++) {
      prisma.rows.push({
        id: `filler-${i}`,
        userId: id,
        jti: withJti ? randomUUID() : null,
        tokenHash: decoyHash,
        expiresAt: new Date(Date.now() + 20 * DAY),
      });
    }
  };

  beforeAll(async () => {
    // One hash at the production cost, reused: a row costs a real verify
    // whatever string it is checked against.
    decoyHash = await argon2.hash('some other device');
  });
  beforeEach(() => {
    verifies = 0;
    prisma = fakePrisma();
    prisma.users.set('alice', user('alice', null));
    prisma.users.set('bob', user('bob', null));
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
  });

  describe('speed however many tokens the account holds', () => {
    it('with 200 stored refresh tokens, a refresh and a sign-out each answer in under a second', async () => {
      fillWithOtherTokens('alice', 199);
      const mine = await signIn('alice'); // the 200th, and the newest
      expect(prisma.rows).toHaveLength(200);

      verifies = 0;
      let t = Date.now();
      await tokens.rotateRefreshToken(mine.refreshToken);
      const refreshMs = Date.now() - t;
      const refreshVerifies = verifies;

      const next = await signIn('alice');
      verifies = 0;
      t = Date.now();
      await service.logout(next.refreshToken, '10.0.0.1');
      const logoutMs = Date.now() - t;
      const logoutVerifies = verifies;

      console.log(
        `AUTH-08 timing, 200 stored tokens: refresh ${refreshMs} ms (${refreshVerifies} hash checks), sign-out ${logoutMs} ms (${logoutVerifies} hash checks)`,
      );
      expect(refreshMs).toBeLessThan(1000);
      expect(logoutMs).toBeLessThan(1000);
      expect(refreshVerifies).toBe(1);
      expect(logoutVerifies).toBe(1);
      // The refresh really happened and the sign-out really signed out.
      expect(await refreshes(mine.refreshToken)).toBe(false);
      expect(await refreshes(next.refreshToken)).toBe(false);
    });

    it('with 2 stored refresh tokens, a refresh costs one hash check, the same as with 200', async () => {
      const first = await signIn('alice');
      await signIn('alice');
      verifies = 0;
      const t = Date.now();
      await tokens.rotateRefreshToken(first.refreshToken);
      console.log(
        `AUTH-08 timing, 2 stored tokens: refresh ${Date.now() - t} ms (${verifies} hash checks)`,
      );
      expect(verifies).toBe(1);
    });

    it("a token stored by the new code carries its jti on the row, and the jti is the token's own", async () => {
      const a = await signIn('alice');
      const b = await signIn('alice');
      const ids = prisma.rows.map((r: Row) => r.jti);
      expect(new Set(ids).size).toBe(2);
      const claim = jwt.decode(a.refreshToken).jti;
      expect(prisma.rows.find((r: Row) => r.jti === claim)).toBeDefined();
      expect(jwt.decode(b.refreshToken).jti).not.toBe(claim);
    });
  });

  describe('a token issued before this change', () => {
    it('refreshes once and only once, the payload having no jti at all', async () => {
      const old = await legacyToken('alice', { withJti: false });
      expect(await refreshes(old)).toBe(true);
      expect(await refreshes(old)).toBe(false);
    });

    it('refreshes once and only once, the payload naming a jti no row holds (what was shipped)', async () => {
      const old = await legacyToken('alice');
      const out = await tokens.rotateRefreshToken(old);
      expect(await refreshes(old)).toBe(false);
      // What it is swapped for is a new-style token, found by its jti.
      verifies = 0;
      expect(await refreshes(out.refreshToken)).toBe(true);
      expect(verifies).toBe(1);
    });

    it('is honoured by a scan of the null-jti rows only: rows that carry a jti are not hash-checked', async () => {
      fillWithOtherTokens('alice', 30, true);
      const old = await legacyToken('alice');
      verifies = 0;
      expect(await refreshes(old)).toBe(true);
      expect(verifies).toBe(1);
    });

    it('is honoured by a scan that skips null-jti rows already expired', async () => {
      for (let i = 0; i < 5; i++) {
        prisma.rows.push({
          id: `dead-${i}`,
          userId: 'alice',
          jti: null,
          tokenHash: decoyHash,
          expiresAt: new Date(Date.now() - DAY),
        });
      }
      const old = await legacyToken('alice');
      verifies = 0;
      expect(await refreshes(old)).toBe(true);
      expect(verifies).toBe(1);
    });

    it('signs out: the sign-out ends it, and it cannot refresh afterwards', async () => {
      const old = await legacyToken('alice');
      const other = await legacyToken('alice');
      await service.logout(old, '10.0.0.1');
      expect(await refreshes(old)).toBe(false);
      expect(await refreshes(other)).toBe(true);
    });

    it('an old token that has expired is refused', async () => {
      const old = await legacyToken('alice', { ttl: 1 });
      await new Promise((r) => setTimeout(r, 1500));
      expect(await refreshes(old)).toBe(false);
    });
  });

  describe('what is still refused', () => {
    it('a rotated token cannot be used again', async () => {
      const first = await signIn('alice');
      const second = await tokens.rotateRefreshToken(first.refreshToken);
      expect(await refreshes(first.refreshToken)).toBe(false);
      expect(await refreshes(second.refreshToken)).toBe(true);
    });

    it('a real token whose record was deleted is refused, and it signs out nothing else', async () => {
      const gone = await signIn('alice');
      const kept = await signIn('alice');
      const claim = jwt.decode(gone.refreshToken).jti;
      prisma.rows = prisma.rows.filter((r: Row) => r.jti !== claim);
      expect(await refreshes(gone.refreshToken)).toBe(false);
      await expect(
        service.logout(gone.refreshToken, '10.0.0.1'),
      ).resolves.toBeUndefined();
      expect(await refreshes(kept.refreshToken)).toBe(true);
    });

    it('a record whose hash does not verify refuses the token, and no other row is tried', async () => {
      fillWithOtherTokens('alice', 20, false);
      const real = await signIn('alice');
      const claim = jwt.decode(real.refreshToken).jti;
      prisma.rows.find((r: Row) => r.jti === claim)!.tokenHash = decoyHash;
      verifies = 0;
      expect(await refreshes(real.refreshToken)).toBe(false);
      expect(verifies).toBe(1);
      expect(prisma.rows.some((r: Row) => r.jti === claim)).toBe(true);
    });

    it("a token cannot use another account's row: the jti is looked up under the signed account", async () => {
      const bobs = await signIn('bob');
      const bobsJti = jwt.decode(bobs.refreshToken).jti;
      // Signed by this service for Alice, but naming Bob's jti.
      const mixed = await jwt.signAsync(
        { sub: 'alice', jti: bobsJti, type: 'refresh' },
        { algorithm: 'RS256', expiresIn: '1d' },
      );
      expect(await refreshes(mixed)).toBe(false);
      await service.logout(mixed, '10.0.0.1');
      expect(await refreshes(bobs.refreshToken)).toBe(true);
    });

    it('a refresh token with no matching record at all is refused, and an access token is not a refresh token', async () => {
      const unknown = await jwt.signAsync(
        { sub: 'alice', jti: randomUUID(), type: 'refresh' },
        { algorithm: 'RS256', expiresIn: '1d' },
      );
      const access = await jwt.signAsync(
        { sub: 'alice', jti: randomUUID() },
        { algorithm: 'RS256', expiresIn: '15m' },
      );
      expect(await refreshes(unknown)).toBe(false);
      expect(await refreshes(access)).toBe(false);
    });
  });

  describe('sign-out of everything still sweeps every token, null-jti ones included', () => {
    it('a password change ends new-style and pre-change tokens alike, and hands this device one', async () => {
      prisma.users.set('carol', user('carol', await argon2.hash('old-pass-1')));
      const a = await signIn('carol');
      const b = await signIn('carol');
      const oldA = await legacyToken('carol');
      const oldB = await legacyToken('carol', { withJti: false });
      const here = await service.changePassword(
        live('carol'),
        'old-pass-1',
        'new-pass-2',
      );
      for (const t of [a.refreshToken, b.refreshToken, oldA, oldB]) {
        expect(await refreshes(t)).toBe(false);
      }
      expect(prisma.rows.filter((r: Row) => r.userId === 'carol')).toHaveLength(
        1,
      );
      expect(await refreshes(here.refreshToken)).toBe(true);
    });
  });

  describe('expired records are deleted', () => {
    const expired = (userId: string, n: number, jti: boolean) => {
      for (let i = 0; i < n; i++) {
        prisma.rows.push({
          id: `exp-${userId}-${jti ? 'j' : 'n'}-${i}`,
          userId,
          jti: jti ? randomUUID() : null,
          tokenHash: decoyHash,
          expiresAt: new Date(Date.now() - (i + 1) * 60_000),
        });
      }
    };

    it("an issue removes that account's expired records, keeps its live ones, and leaves other accounts alone", async () => {
      const live1 = await signIn('alice');
      expired('alice', 3, true);
      expired('alice', 3, false);
      expired('bob', 2, true);
      expect(prisma.rows).toHaveLength(9);
      await signIn('alice');
      const mine = prisma.rows.filter((r: Row) => r.userId === 'alice');
      expect(mine).toHaveLength(2);
      expect(mine.every((r: Row) => r.expiresAt.getTime() > Date.now())).toBe(
        true,
      );
      expect(prisma.rows.filter((r: Row) => r.userId === 'bob')).toHaveLength(
        2,
      );
      expect(await refreshes(live1.refreshToken)).toBe(true);
    });

    it('a refresh does the same, through the issue it ends with', async () => {
      const mine = await signIn('alice');
      expired('alice', 4, true);
      await tokens.rotateRefreshToken(mine.refreshToken);
      expect(prisma.rows.filter((r: Row) => r.userId === 'alice')).toHaveLength(
        1,
      );
    });

    it('a sign-out does the same', async () => {
      const mine = await signIn('alice');
      expired('alice', 4, false);
      await service.logout(mine.refreshToken, '10.0.0.1');
      expect(prisma.rows.filter((r: Row) => r.userId === 'alice')).toHaveLength(
        0,
      );
    });

    it('is bounded: one issue takes at most 50, the next takes the rest', async () => {
      expired('alice', 120, true);
      await signIn('alice');
      expect(
        prisma.rows.filter((r: Row) => r.expiresAt.getTime() <= Date.now()),
      ).toHaveLength(70);
      await signIn('alice');
      await signIn('alice');
      expect(
        prisma.rows.filter((r: Row) => r.expiresAt.getTime() <= Date.now()),
      ).toHaveLength(0);
    });

    it('a failure while pruning does not fail the sign-in', async () => {
      const original = prisma.refreshToken.findMany;
      prisma.refreshToken.findMany = () => Promise.reject(new Error('slow'));
      const pairOut = await signIn('alice');
      prisma.refreshToken.findMany = original;
      expect(await refreshes(pairOut.refreshToken)).toBe(true);
    });
  });
});
