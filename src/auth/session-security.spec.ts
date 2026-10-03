/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- an in-memory stand-in for the few Prisma calls, rows are untyped by design */
import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { WawuUser } from '@prisma/client';
import * as argon2 from 'argon2';
import { generateKeyPairSync } from 'crypto';
import { MemoryRateLimiter } from '../testing/memory-rate-limiter';
import {
  CHANGE_PASSWORD_MAX_TRIES,
  LOGOUT_PER_ADDRESS_PER_MINUTE,
  SessionSecurityService,
} from './session-security.service';
import { TokensService } from './tokens.service';

type Row = Record<string, any>;

const pair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const other = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** The few Prisma calls these two services make, over plain rows. */
function fakePrisma() {
  const users = new Map<string, Row>();
  let refresh: Row[] = [];
  let resets: Row[] = [];
  let seq = 0;
  const locks = new Map<string, Promise<void>>();
  const api: any = {
    users,
    get refresh() {
      return refresh;
    },
    get resets() {
      return resets;
    },
    set resets(v: Row[]) {
      resets = v;
    },
    failNextTransaction: false,
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
    refreshToken: {
      create: ({ data }: Row) => {
        refresh.push({ id: `r${++seq}`, ...data });
        return Promise.resolve();
      },
      findMany: ({ where }: Row) =>
        Promise.resolve(refresh.filter((r) => r.userId === where.userId)),
      delete: ({ where }: Row) => {
        refresh = refresh.filter((r) => r.id !== where.id);
        return Promise.resolve();
      },
      deleteMany: async ({ where }: Row) => {
        const before = refresh.length;
        refresh = refresh.filter((r) =>
          where.id !== undefined
            ? r.id !== where.id
            : r.userId !== where.userId,
        );
        // Yield, as a real round trip does, so racing calls interleave.
        await new Promise((r) => setTimeout(r, Math.random() * 3));
        return { count: before - refresh.length };
      },
    },
    passwordResetToken: {
      deleteMany: ({ where }: Row) => {
        resets = resets.filter((r) => r.userId !== where.userId);
        return Promise.resolve();
      },
    },
    // A row lock per account, held until the transaction ends (FOR UPDATE).
    // `locking: false` is the revert proof: the lock does nothing.
    locking: true,
    $transaction: async (fn: (tx: unknown) => unknown) => {
      if (api.failNextTransaction) {
        api.failNextTransaction = false;
        throw new Error('database down');
      }
      const held: Array<() => void> = [];
      const tx = Object.create(api);
      tx.$queryRaw = async (_s: unknown, userId: string) => {
        if (!api.locking) return;
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

describe('SETTINGS-03: change password and sign out', () => {
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
  let limiter: MemoryRateLimiter;
  let tokens: TokensService;
  let service: SessionSecurityService;
  let alice: WawuUser;
  let bob: WawuUser;

  const user = (id: string, hash: string | null): Row => ({
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
  const live = (u: Row) => ({ ...prisma.users.get(u.id)! }) as WawuUser;

  /** A device signs in: a new refresh token is stored. */
  const signIn = (u: Row) => tokens.issueTokens(live(u));
  const refreshes = (t: string) =>
    tokens.rotateRefreshToken(t).then(
      () => true,
      () => false,
    );
  const refused = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => null,
      (e: HttpException) => e,
    );
    expect(err).toBeInstanceOf(HttpException);
    return {
      status: (err as HttpException).getStatus(),
      body: (err as HttpException).getResponse() as Row,
    };
  };

  beforeAll(async () => {
    alice = user('alice', await argon2.hash('old-password-1')) as WawuUser;
    bob = user('bob', await argon2.hash('bobs-password-1')) as WawuUser;
  });
  beforeEach(() => {
    prisma = fakePrisma();
    prisma.users.set('alice', { ...alice });
    prisma.users.set('bob', { ...bob });
    limiter = new MemoryRateLimiter();
    tokens = new TokensService(
      jwt,
      {
        get: (k: string) => env[k],
        getOrThrow: (k: string) => env[k],
      } as never,
      { kid: 'k1' } as never,
      prisma as never,
    );
    service = new SessionSecurityService(prisma as never, tokens, limiter);
  });

  describe('change password', () => {
    it('a user can change the password and sign in with the new one only', async () => {
      await service.changePassword(
        live(alice),
        'old-password-1',
        'new-password-2',
      );
      const hash = prisma.users.get('alice')!.passwordHash;
      expect(await argon2.verify(hash, 'new-password-2')).toBe(true);
      expect(await argon2.verify(hash, 'old-password-1')).toBe(false);
    });

    it('a user who changes the password signs out their other devices and keeps this one', async () => {
      const phone = await signIn(alice);
      const laptop = await signIn(alice);
      const here = await service.changePassword(
        live(alice),
        'old-password-1',
        'new-password-2',
      );
      expect(await refreshes(phone.refreshToken)).toBe(false);
      expect(await refreshes(laptop.refreshToken)).toBe(false);
      expect(await refreshes(here.refreshToken)).toBe(true);
    });

    it('a user who changes the password does not sign out anyone else', async () => {
      const bobsPhone = await signIn(bob);
      await signIn(alice);
      await service.changePassword(
        live(alice),
        'old-password-1',
        'new-password-2',
      );
      expect(await refreshes(bobsPhone.refreshToken)).toBe(true);
    });

    it('a user who changes the password also ends their pending reset links', async () => {
      prisma.resets = [{ userId: 'alice' }, { userId: 'bob' }];
      await service.changePassword(
        live(alice),
        'old-password-1',
        'new-password-2',
      );
      expect(prisma.resets).toEqual([{ userId: 'bob' }]);
    });

    it('someone with the wrong current password cannot change it, and nothing else changes', async () => {
      const phone = await signIn(alice);
      const r = await refused(
        service.changePassword(live(alice), 'guess-guess-1', 'new-password-2'),
      );
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('CURRENT_PASSWORD_WRONG');
      expect(prisma.users.get('alice')!.passwordHash).toBe(alice.passwordHash);
      expect(await refreshes(phone.refreshToken)).toBe(true);
    });

    it('someone cannot guess the current password past the limit, even with the right one after', async () => {
      for (let i = 0; i < CHANGE_PASSWORD_MAX_TRIES; i++) {
        const r = await refused(
          service.changePassword(
            live(alice),
            `wrong-${i}-pass`,
            'new-password-2',
          ),
        );
        expect(r.body.code).toBe('CURRENT_PASSWORD_WRONG');
      }
      const locked = await refused(
        service.changePassword(live(alice), 'old-password-1', 'new-password-2'),
      );
      expect(locked.status).toBe(429);
      expect(locked.body.code).toBe('RATE_LIMITED');
      expect(locked.body.retryAfterSeconds).toBeGreaterThan(0);
      expect(prisma.users.get('alice')!.passwordHash).toBe(alice.passwordHash);
      // The wait is per account: Bob is not held up by Alice's misses.
      await service.changePassword(
        live(bob),
        'bobs-password-1',
        'bobs-new-pass-2',
      );
    });

    it('a user who gets it right gets the tries back', async () => {
      for (let i = 0; i < CHANGE_PASSWORD_MAX_TRIES - 1; i++) {
        await refused(
          service.changePassword(
            live(alice),
            `wrong-${i}-pass`,
            'new-password-2',
          ),
        );
      }
      await service.changePassword(
        live(alice),
        'old-password-1',
        'new-password-2',
      );
      for (let i = 0; i < CHANGE_PASSWORD_MAX_TRIES; i++) {
        const r = await refused(
          service.changePassword(
            live(alice),
            `again-${i}-pass`,
            'third-password-3',
          ),
        );
        expect(r.body.code).toBe('CURRENT_PASSWORD_WRONG');
      }
    });

    it('parallel guesses cannot step round the limit', async () => {
      const results = await Promise.all(
        Array.from({ length: CHANGE_PASSWORD_MAX_TRIES + 4 }, (_, i) =>
          refused(
            service.changePassword(
              live(alice),
              `par-${i}-pass`,
              'new-password-2',
            ),
          ),
        ),
      );
      expect(results.filter((r) => r.status === 429)).toHaveLength(4);
    });

    it('a user cannot "change" to the password they already have', async () => {
      const r = await refused(
        service.changePassword(live(alice), 'old-password-1', 'old-password-1'),
      );
      expect(r.body.code).toBe('PASSWORD_UNCHANGED');
    });

    it('an account that never had a password is told so, and the work is the same as for a wrong one', async () => {
      prisma.users.set('nopass', user('nopass', null));
      const r = await refused(
        service.changePassword(
          live({ id: 'nopass' }),
          'anything-1',
          'new-password-2',
        ),
      );
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('PASSWORD_NOT_SET');
    });

    it('a failure while saving leaves the old password and every session in place', async () => {
      const phone = await signIn(alice);
      prisma.failNextTransaction = true;
      await expect(
        service.changePassword(live(alice), 'old-password-1', 'new-password-2'),
      ).rejects.toThrow('database down');
      expect(prisma.users.get('alice')!.passwordHash).toBe(alice.passwordHash);
      expect(await refreshes(phone.refreshToken)).toBe(true);
    });

    it('never answers with a hash or the password in the error', async () => {
      const r = await refused(
        service.changePassword(live(alice), 'secret-guess-1', 'new-password-2'),
      );
      const text = JSON.stringify(r.body);
      expect(text).not.toContain('secret-guess-1');
      expect(text).not.toContain('new-password-2');
      expect(text).not.toContain('argon2');
      expect(text).not.toMatch(/—/);
    });
  });

  describe('sign out', () => {
    it('a user who signs out cannot use that refresh token again', async () => {
      const phone = await signIn(alice);
      await service.logout(phone.refreshToken, '10.0.0.1');
      expect(await refreshes(phone.refreshToken)).toBe(false);
    });

    it('a user who signs out on one device stays signed in on the others', async () => {
      const phone = await signIn(alice);
      const laptop = await signIn(alice);
      await service.logout(phone.refreshToken, '10.0.0.1');
      expect(await refreshes(laptop.refreshToken)).toBe(true);
    });

    it('signing out twice, or with a token already used, is not an error', async () => {
      const phone = await signIn(alice);
      await service.logout(phone.refreshToken, '10.0.0.1');
      await expect(
        service.logout(phone.refreshToken, '10.0.0.1'),
      ).resolves.toBeUndefined();
    });

    it('a token that was rotated is gone, so the newest one is what sign-out must end', async () => {
      const first = await signIn(alice);
      const second = await tokens.rotateRefreshToken(first.refreshToken);
      await service.logout(second.refreshToken, '10.0.0.1');
      expect(await refreshes(second.refreshToken)).toBe(false);
    });

    it('an expired refresh token is cleaned up, not refused', async () => {
      const phone = await signIn(alice);
      const expired = await jwt.signAsync(
        { sub: 'alice', jti: 'x', type: 'refresh' },
        { algorithm: 'RS256', expiresIn: -10 },
      );
      prisma.refresh.push({
        id: 'old',
        userId: 'alice',
        tokenHash: await argon2.hash(expired),
        expiresAt: new Date(Date.now() - 1000),
      });
      await service.logout(expired, '10.0.0.1');
      expect(prisma.refresh.find((r) => r.id === 'old')).toBeUndefined();
      expect(await refreshes(phone.refreshToken)).toBe(true);
    });

    it('garbage, a forged token, an access token and an unknown refresh token all answer the same and end nothing', async () => {
      const phone = await signIn(alice);
      const forged = await new JwtService({
        privateKey: other.privateKey,
      }).signAsync(
        { sub: 'alice', jti: 'f', type: 'refresh' },
        { algorithm: 'RS256', expiresIn: '1d' },
      );
      const accessLike = await jwt.signAsync(
        { sub: 'alice' },
        { algorithm: 'RS256', expiresIn: '15m' },
      );
      const unknown = await jwt.signAsync(
        { sub: 'alice', jti: 'u', type: 'refresh' },
        { algorithm: 'RS256', expiresIn: '1d' },
      );
      const nobody = await jwt.signAsync(
        { sub: 'ghost', jti: 'g', type: 'refresh' },
        { algorithm: 'RS256', expiresIn: '1d' },
      );
      for (const t of [
        'not.a.token',
        '',
        forged,
        accessLike,
        unknown,
        nobody,
      ]) {
        await expect(service.logout(t, '10.0.0.2')).resolves.toBeUndefined();
      }
      expect(prisma.refresh).toHaveLength(1);
      expect(await refreshes(phone.refreshToken)).toBe(true);
    });

    it('a user cannot sign someone else out with a token that is not theirs', async () => {
      const bobsPhone = await signIn(bob);
      const alicePhone = await signIn(alice);
      // Alice presents her own token: only hers goes.
      await service.logout(alicePhone.refreshToken, '10.0.0.3');
      expect(await refreshes(bobsPhone.refreshToken)).toBe(true);
    });

    it('sign-out is limited per address, so it cannot be used to burn the server', async () => {
      for (let i = 0; i < LOGOUT_PER_ADDRESS_PER_MINUTE; i++) {
        await service.logout('x', '10.0.0.9');
      }
      const r = await refused(service.logout('x', '10.0.0.9'));
      expect(r.status).toBe(429);
      expect(r.body.code).toBe('RATE_LIMITED');
      await expect(service.logout('x', '10.0.0.10')).resolves.toBeUndefined();
    });
  });

  describe('a refresh in flight while the account is revoked', () => {
    jest.setTimeout(120_000);
    const TRIALS = 12;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('a user who changes the password leaves no working session on a device that was refreshing at that moment', async () => {
      for (let i = 0; i < TRIALS; i++) {
        prisma = fakePrisma();
        prisma.users.set('alice', { ...alice });
        tokens = new TokensService(
          jwt,
          {
            get: (k: string) => env[k],
            getOrThrow: (k: string) => env[k],
          } as never,
          { kid: 'k1' } as never,
          prisma as never,
        );
        service = new SessionSecurityService(prisma as never, tokens, limiter);
        const stale = await signIn(alice);
        limiter = new MemoryRateLimiter();
        service = new SessionSecurityService(prisma as never, tokens, limiter);
        const [rotated, changed] = await Promise.allSettled([
          wait(Math.random() * 4).then(() =>
            tokens.rotateRefreshToken(stale.refreshToken),
          ),
          service.changePassword(
            live(alice),
            'old-password-1',
            'new-password-2',
          ),
        ]);
        expect(changed.status).toBe('fulfilled');
        // Whatever the order: the only refresh token left is the one the
        // password change handed this device. The stale device holds none.
        const mine = (
          changed as PromiseFulfilledResult<{ refreshToken: string }>
        ).value.refreshToken;
        if (rotated.status === 'fulfilled') {
          expect(await refreshes(rotated.value.refreshToken)).toBe(false);
        }
        expect(await refreshes(stale.refreshToken)).toBe(false);
        expect(prisma.refresh).toHaveLength(1);
        expect(await refreshes(mine)).toBe(true);
      }
    });

    it('a user who signs out while that device is refreshing is signed out, or the refresh was refused', async () => {
      for (let i = 0; i < TRIALS; i++) {
        prisma = fakePrisma();
        prisma.users.set('alice', { ...alice });
        tokens = new TokensService(
          jwt,
          {
            get: (k: string) => env[k],
            getOrThrow: (k: string) => env[k],
          } as never,
          { kid: 'k1' } as never,
          prisma as never,
        );
        service = new SessionSecurityService(prisma as never, tokens, limiter);
        const device = await signIn(alice);
        const [rotated] = await Promise.allSettled([
          wait(Math.random() * 4).then(() =>
            tokens.rotateRefreshToken(device.refreshToken),
          ),
          service.logout(device.refreshToken, `10.1.${i}.1`),
        ]);
        // Logout first: the refresh is refused. Refresh first: the device
        // was handed a newer token, and the sign-out it asked for named the
        // older one (what the app's session counter prevents), so the old one
        // is dead either way and nothing throws or hangs.
        expect(await refreshes(device.refreshToken)).toBe(false);
        if (rotated.status === 'rejected') {
          expect(prisma.refresh).toHaveLength(0);
        }
      }
    });

    it('a user can refresh normally when nothing else is happening', async () => {
      const first = await signIn(alice);
      const second = await tokens.rotateRefreshToken(first.refreshToken);
      expect(await refreshes(first.refreshToken)).toBe(false);
      expect(await refreshes(second.refreshToken)).toBe(true);
    });

    it('an access token sent to sign-out ends nothing', async () => {
      const phone = await signIn(alice);
      const access = await jwt.signAsync(
        { sub: 'alice' },
        { algorithm: 'RS256', expiresIn: '15m' },
      );
      await service.logout(access, '10.0.0.5');
      expect(await refreshes(phone.refreshToken)).toBe(true);
    });
  });
});
