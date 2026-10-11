/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- an in-memory stand-in for the few Prisma calls, rows are untyped by design */
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { WawuUser } from '@prisma/client';
import { generateKeyPairSync } from 'crypto';
import { JwksService } from '../jwks/jwks.service';
import { TokensService } from './tokens.service';

type Row = Record<string, any>;

const pair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/**
 * JOIN-03 round 5, D10: a refresh token of a closed account (banned, deletion
 * begun, anonymised by the Hub) is refused, and every token the account holds
 * goes with it. Nothing about an open account's refresh changes (AUTH-08,
 * SETTINGS-03): the specs for those are refresh-token-lookup.spec.ts and
 * session-security.spec.ts; the control here runs the same rotation.
 */
describe('POST /auth/refresh for a closed account (D10)', () => {
  const jwt = new JwtService({
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    signOptions: { algorithm: 'RS256' },
    verifyOptions: { algorithms: ['RS256'] },
  });
  const env: Record<string, string> = {
    JWT_EXPIRES_IN: '15m',
    REFRESH_EXPIRES_IN: '30d',
  };
  let users: Map<string, Row>;
  let rows: Row[];
  let steps: string[];
  let seq: number;
  /** Reads of the account row before this many have been served as the OPEN account (a close that lands later). */
  let openReads: number;
  /** The account still has a sign-up code row (its deletion began before the code was entered). */
  let pendingCode: boolean;
  let tokens: TokensService;

  const account = (id: string, over: Row = {}): Row => ({
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
    deletedAt: null,
    wawuafricaAppUserId: null,
    onboardingRef: null,
    beautyUserId: null,
    basketUserId: null,
    phoneVerifiedAt: new Date(),
    phoneVerifiedFor: '+2348031234412',
    emailVerified: true,
    passwordHash: null,
    ...over,
  });

  function fakePrisma() {
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
      wawuUser: {
        findUnique: ({ where }: Row) => {
          const row = users.get(where.id);
          if (!row) return Promise.resolve(null);
          // a close that lands after the account was first read
          if (openReads > 0) {
            openReads -= 1;
            return Promise.resolve({
              ...row,
              status: 'active',
              deletedAt: null,
              phone: '+2348031234412',
            });
          }
          return Promise.resolve({ ...row });
        },
      },
      phoneVerification: {
        findUnique: () =>
          Promise.resolve(pendingCode ? { id: 'c1', channel: null } : null),
      },
      refreshToken: {
        create: ({ data }: Row) => {
          steps.push('create');
          rows.push({ id: `r${++seq}`, jti: null, ...data });
          return Promise.resolve();
        },
        findMany: ({ where, take }: Row) => {
          const found = rows.filter((r) => matches(r, where));
          return Promise.resolve(take ? found.slice(0, take) : found);
        },
        deleteMany: ({ where }: Row) => {
          steps.push(`delete ${JSON.stringify(Object.keys(where))}`);
          const before = rows.length;
          rows = rows.filter((r) => !matches(r, where));
          return Promise.resolve({ count: before - rows.length });
        },
      },
      $transaction: (fn: (tx: unknown) => unknown) => {
        const tx = Object.create(api);
        tx.$queryRaw = () => {
          steps.push('lock');
          return Promise.resolve([]);
        };
        return Promise.resolve(fn(tx));
      },
    };
    return api;
  }

  beforeEach(() => {
    users = new Map();
    rows = [];
    steps = [];
    seq = 0;
    openReads = 0;
    pendingCode = false;
    tokens = new TokensService(
      jwt,
      {
        get: (k: string) => env[k],
        getOrThrow: (k: string) => env[k],
      } as never,
      { kid: 'k1' } as unknown as JwksService,
      fakePrisma() as never,
    );
  });

  const signIn = (id: string) =>
    tokens.issueTokens(users.get(id) as unknown as WawuUser);
  const heldBy = (id: string) => rows.filter((r) => r.userId === id).length;

  async function refused(p: Promise<unknown>): Promise<string> {
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthorizedException);
      return (err as UnauthorizedException).message;
    }
    throw new Error('the refresh was not refused');
  }

  const closures: Array<[string, Row]> = [
    ['banned', { status: 'banned' }],
    ['deletion begun', { status: 'pending_deletion' }],
    ['deletedAt stamped', { deletedAt: new Date() }],
    ['phone is the deleted marker', { phone: 'deleted:u1' }],
    [
      'anonymised (all of the above and no email)',
      {
        status: 'banned',
        deletedAt: new Date(),
        phone: 'deleted:u1',
        email: null,
        phoneVerifiedFor: null,
      },
    ],
  ];

  it('the control: an open account rotates its token, once, and the new one rotates again', async () => {
    users.set('u1', account('u1'));
    const first = await signIn('u1');
    const second = await tokens.rotateRefreshToken(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(heldBy('u1')).toBe(1);
    await refused(tokens.rotateRefreshToken(first.refreshToken));
    const third = await tokens.rotateRefreshToken(second.refreshToken);
    expect(third.accessToken).toEqual(expect.any(String));
  });

  it('a suspended account is not closed here: it still refreshes (unchanged)', async () => {
    users.set('u1', account('u1', { status: 'suspended' }));
    const first = await signIn('u1');
    expect(
      (await tokens.rotateRefreshToken(first.refreshToken)).accessToken,
    ).toEqual(expect.any(String));
  });

  it.each(closures)(
    'refuses the token and issues nothing: %s',
    async (_name, closed) => {
      users.set('u1', account('u1'));
      const session = await signIn('u1');
      // the token was stored; the account is closed afterwards (a session written after the Hub's anonymise)
      Object.assign(users.get('u1')!, closed);
      steps = [];
      const message = await refused(
        tokens.rotateRefreshToken(session.refreshToken),
      );
      // the answer an unknown token gets
      expect(message).toBe('Invalid refresh token');
      expect(steps).not.toContain('create');
    },
  );

  it.each(closures)(
    "removes every token the account holds, and no other account's: %s",
    async (_name, closed) => {
      users.set('u1', account('u1'));
      users.set('u2', account('u2', { phone: '+2348031234499' }));
      const presented = await signIn('u1');
      await signIn('u1');
      await signIn('u1');
      await signIn('u2');
      expect(heldBy('u1')).toBe(3);
      Object.assign(users.get('u1')!, closed);
      await refused(tokens.rotateRefreshToken(presented.refreshToken));
      expect(heldBy('u1')).toBe(0);
      expect(heldBy('u2')).toBe(1);
    },
  );

  it("revokes under the account's lock, the order the Hub's anonymise takes (the account, then its tokens)", async () => {
    users.set('u1', account('u1'));
    const session = await signIn('u1');
    Object.assign(users.get('u1')!, { status: 'banned' });
    steps = [];
    await refused(tokens.rotateRefreshToken(session.refreshToken));
    expect(steps[0]).toBe('lock');
    expect(steps).toContain('delete ["userId"]');
    expect(steps.indexOf('lock')).toBeLessThan(
      steps.indexOf('delete ["userId"]'),
    );
  });

  it('refuses an account closed in the moment between the first read and the rotation: the check is made again under the lock, and nothing new is stored', async () => {
    users.set('u1', account('u1'));
    const presented = await signIn('u1');
    await signIn('u1');
    Object.assign(users.get('u1')!, {
      status: 'banned',
      deletedAt: new Date(),
      phone: 'deleted:u1',
    });
    // the first read (outside the transaction) still finds the account open
    openReads = 1;
    steps = [];
    await refused(tokens.rotateRefreshToken(presented.refreshToken));
    expect(steps).not.toContain('create');
    expect(heldBy('u1')).toBe(0);
  });

  it('a closed account that still has a sign-up code row answers 401 like any closed account, not the 403 of an unconfirmed sign-up, and its tokens are removed', async () => {
    users.set('u1', account('u1', { phoneVerifiedAt: null }));
    const session = await signIn('u1');
    Object.assign(users.get('u1')!, { status: 'pending_deletion' });
    pendingCode = true;
    await refused(tokens.rotateRefreshToken(session.refreshToken));
    expect(heldBy('u1')).toBe(0);
  });

  it('the control: an open account that has not confirmed its phone still gets the 403 an unconfirmed sign-up always got', async () => {
    users.set('u1', account('u1', { phoneVerifiedAt: null }));
    const session = await signIn('u1');
    pendingCode = true;
    await expect(
      tokens.rotateRefreshToken(session.refreshToken),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("an unknown, a forged and a used token get the same answer as a closed account's", async () => {
    users.set('u1', account('u1'));
    const session = await signIn('u1');
    await tokens.rotateRefreshToken(session.refreshToken);
    const used = await refused(tokens.rotateRefreshToken(session.refreshToken));
    const forged = await refused(tokens.rotateRefreshToken('not.a.token'));
    Object.assign(users.get('u1')!, { status: 'banned' });
    const live = (await signIn('u1')).refreshToken;
    const closed = await refused(tokens.rotateRefreshToken(live));
    expect(new Set([used, forged, closed]).size).toBe(1);
  });
});
