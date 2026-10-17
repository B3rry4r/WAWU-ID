/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- a fake Hub over real HTTP and a real Postgres: rows and bodies are untyped by design */
import { ConflictException, HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { generateKeyPairSync, randomInt, randomUUID } from 'crypto';
import { createServer, type Server } from 'http';
import { PrismaService } from '../prisma/prisma.service';
import { HubAccountClient, HubUnavailableError } from './hub-account.client';
import { AuthService } from './auth.service';
import {
  PURGE_AFTER_SLACK_MS,
  DELETION_GRACE_MS,
  ceilToSecond,
  deletionDueAt,
} from './deletion-window';
import { SessionReader } from './session-reader';
import { TokensService } from './tokens.service';

/**
 * SETTINGS-08 (R-17): deleting an account waits 30 days, and signing in during
 * them cancels it. Run for real: a local Postgres and a fake Hub over HTTP on
 * a local port, because a double of the database cannot see a lock and a double
 * of the Hub cannot see how many times it was called.
 *
 *   createdb s08_test_wawu_id
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/s08_test_wawu_id?schema=public npx prisma migrate deploy
 *   DELETION_WINDOW_DATABASE_URL=...same... npx jest src/auth/deletion-window.spec.ts
 *
 * Refuses any database that is not on this machine or whose name lacks "test".
 * Without the variable the database cases are skipped (the pure ones run).
 */
const DB = process.env.DELETION_WINDOW_DATABASE_URL ?? '';
const HUB_PORT = Number(process.env.DELETION_WINDOW_HUB_PORT ?? 7760);
const dbCases =
  DB && /@(localhost|127\.0\.0\.1)[:/]/.test(DB) && /test/.test(DB)
    ? describe
    : describe.skip;

describe('deletionDueAt and ceilToSecond', () => {
  const at = new Date('2026-10-17T10:00:00.250Z');
  it('is 30 days after the mark when the Hub sends nothing', () => {
    expect(deletionDueAt(at).getTime() - at.getTime()).toBe(DELETION_GRACE_MS);
  });
  it("is the Hub's own date when it is within a day of 30 days", () => {
    const hub = new Date(at.getTime() + DELETION_GRACE_MS + 5000);
    expect(deletionDueAt(at, hub)).toEqual(hub);
  });
  it('ignores a date that cuts the 30 days short or stretches them', () => {
    const short = new Date(at.getTime() + 60_000);
    const long = new Date(
      at.getTime() + DELETION_GRACE_MS + PURGE_AFTER_SLACK_MS + 1,
    );
    const standard = at.getTime() + DELETION_GRACE_MS;
    expect(deletionDueAt(at, short).getTime()).toBe(standard);
    expect(deletionDueAt(at, long).getTime()).toBe(standard);
    expect(deletionDueAt(at, new Date('nope')).getTime()).toBe(standard);
  });
  it('starts the next whole second, even on an exact second', () => {
    expect(ceilToSecond(at).toISOString()).toBe('2026-10-17T10:00:01.000Z');
    expect(
      ceilToSecond(new Date('2026-10-17T10:00:00.000Z')).toISOString(),
    ).toBe('2026-10-17T10:00:01.000Z');
  });
});

describe('HubAccountClient', () => {
  const client = (url: string | undefined) =>
    new HubAccountClient({ get: () => url } as never);
  const answer = (status: number, body: unknown) =>
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
      }),
    );
  afterEach(() => jest.restoreAllMocks());

  it('posts the cancel to the Hub with the token and nothing else', async () => {
    const spy = answer(200, { cancelled: true });
    await client('http://hub.test/').cancelDeletion('tok');
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://hub.test/api/hub/account/cancel-deletion');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer tok' });
    expect(init.body).toBeUndefined();
  });

  it('reads the Hub answer bare or wrapped', async () => {
    answer(200, { cancelled: true });
    expect(await client('http://h').cancelDeletion('t')).toEqual({
      kind: 'cancelled',
    });
    answer(200, { statusCode: 200, message: 'OK', data: { cancelled: false } });
    expect(await client('http://h').cancelDeletion('t')).toEqual({
      kind: 'nothing_scheduled',
    });
    answer(200, {
      statusCode: 200,
      message: 'OK',
      data: { cancelled: false, deletionInProgress: true, message: 'Gone.' },
    });
    expect(await client('http://h').cancelDeletion('t')).toEqual({
      kind: 'in_progress',
      message: 'Gone.',
    });
  });

  it('settles nothing on a non-200, an unreadable body, an unknown shape or no answer', async () => {
    for (const make of [
      () => answer(503, { error: { code: 'provider_unreachable' } }),
      () => answer(401, {}),
      () => answer(200, 'not json'),
      () => answer(200, { hello: 'world' }),
      () => jest.spyOn(global, 'fetch').mockRejectedValue(new Error('refused')),
    ]) {
      make();
      await expect(
        client('http://h').cancelDeletion('t'),
      ).rejects.toBeInstanceOf(HubUnavailableError);
    }
  });

  it('never reaches a host nobody configured', async () => {
    const spy = answer(200, { cancelled: true });
    await expect(client(undefined).cancelDeletion('t')).rejects.toBeInstanceOf(
      HubUnavailableError,
    );
    await expect(client('  ').cancelDeletion('t')).rejects.toBeInstanceOf(
      HubUnavailableError,
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

type HubMode = 'cancel' | 'nothing' | 'in_progress' | 'down' | 'error500';

dbCases('SETTINGS-08 against a real database and a fake Hub', () => {
  // Argon2 on a busy machine: several sign-ins in one case.
  jest.setTimeout(30_000);
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const jwt = new JwtService({
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    signOptions: { algorithm: 'RS256' },
    verifyOptions: { algorithms: ['RS256'] },
  });
  const env: Record<string, string> = {
    DATABASE_URL: DB,
    JWT_EXPIRES_IN: '15m',
    REFRESH_EXPIRES_IN: '30d',
    WAWUAFRICA_API_URL: `http://127.0.0.1:${HUB_PORT}`,
  };
  const config = {
    get: (k: string) => env[k],
    getOrThrow: (k: string) => env[k],
  } as never;

  let prisma: PrismaService;
  let tokens: TokensService;
  let auth: AuthService;
  let reader: SessionReader;
  let server: Server;
  const mail = {
    sendLoginAlert: jest.fn(),
    sendUnpaidDeletionWarning: jest.fn().mockResolvedValue(undefined),
    sendDittoDistributionInvite: jest.fn().mockResolvedValue(undefined),
    sendMoneyCheckReport: jest.fn().mockResolvedValue(undefined),
  };
  const otp = { verify: jest.fn().mockResolvedValue(true) };

  // The fake Hub: what it was asked, by whom, and how it answers.
  const hub = {
    mode: 'cancel' as HubMode,
    delayMs: 0,
    calls: [] as Array<{ sub: string; path: string; method: string }>,
  };
  const password = 'correct horse battery';
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await argon2.hash(password);
    prisma = new PrismaService(config);
    await prisma.$connect();
    tokens = new TokensService(jwt, config, { kid: 'k1' } as never, prisma);
    auth = new AuthService(prisma, tokens, otp as never, mail as never, config);
    reader = new SessionReader(jwt, config, prisma);
    // One scrub is one UPDATE that writes the deleted marker; this counts them.
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS s08_scrub_log (user_id uuid, at timestamptz default now())`,
    );
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION s08_scrub_log_fn() RETURNS trigger AS $$
      BEGIN
        IF NEW.phone LIKE 'deleted:%' AND OLD.phone NOT LIKE 'deleted:%' THEN
          INSERT INTO s08_scrub_log(user_id) VALUES (NEW.id);
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS s08_scrub_log_t ON wawu_users`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER s08_scrub_log_t AFTER UPDATE ON wawu_users FOR EACH ROW EXECUTE FUNCTION s08_scrub_log_fn()`,
    );
    server = createServer((req, res) => {
      void (async () => {
        let sub = '';
        try {
          const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
          const claims: any = await jwt.verifyAsync(bearer?.[1] ?? '', {
            algorithms: ['RS256'],
          });
          sub = claims.sub;
        } catch {
          res.writeHead(401).end();
          return;
        }
        hub.calls.push({ sub, path: req.url ?? '', method: req.method ?? '' });
        if (hub.delayMs) await new Promise((r) => setTimeout(r, hub.delayMs));
        const send = (code: number, body: unknown) =>
          res
            .writeHead(code, { 'content-type': 'application/json' })
            .end(JSON.stringify(body));
        // The Hub wraps every answer: { statusCode, message: 'OK', data }.
        const ok = (data: unknown) =>
          send(200, { statusCode: 200, message: 'OK', data });
        switch (hub.mode) {
          case 'cancel':
            return ok({
              cancelled: true,
              walletUnfrozen: true,
              contentRestored: 3,
            });
          case 'nothing':
            return ok({
              cancelled: false,
              walletUnfrozen: false,
              contentRestored: 0,
            });
          case 'in_progress':
            return ok({
              cancelled: false,
              walletUnfrozen: false,
              contentRestored: 0,
              deletionInProgress: true,
              message:
                'Your account is already being deleted, so it can no longer be restored.',
            });
          case 'error500':
            return send(503, { error: { code: 'provider_unreachable' } });
          case 'down':
            return res.destroy();
        }
      })();
    });
    await new Promise<void>((r) => server.listen(HUB_PORT, '127.0.0.1', r));
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS s08_scrub_log_t ON wawu_users`,
    );
    await prisma.$disconnect();
  });

  beforeEach(() => {
    hub.mode = 'cancel';
    hub.delayMs = 0;
    hub.calls.length = 0;
    jest.clearAllMocks();
  });

  async function makeUser(over: Record<string, unknown> = {}) {
    const n = randomInt(0, 1_000_000_000);
    return prisma.wawuUser.create({
      data: {
        email: `s08-${n}-${randomUUID().slice(0, 6)}@example.test`,
        phone: `+23480${String(n).padStart(9, '0')}${randomInt(0, 99)}`,
        firstName: 'Ada',
        lastName: 'Obi',
        passwordHash,
        emailVerified: true,
        ...over,
      },
    });
  }

  const signIn = (u: { email: string | null }) =>
    auth.login({ identifier: u.email!, password });

  /** A session the account held before the delete, as a signed-in device has. */
  async function withSession(u: { id: string }) {
    const pair = await tokens.issueTokens(
      (await prisma.wawuUser.findUnique({ where: { id: u.id } }))!,
    );
    return pair;
  }

  const row = (id: string) =>
    prisma.wawuUser.findUniqueOrThrow({ where: { id } });
  const windowOf = (id: string) =>
    prisma.deletionWindow.findUnique({ where: { userId: id } });
  const refusal = async (p: Promise<unknown>) => {
    const e: any = await p.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HttpException);
    return { status: e.getStatus(), ...(e.getResponse() as object) } as any;
  };
  /** Moves the whole deletion back in time, as if it had been scheduled `days` ago. */
  async function ageDeletion(id: string, days: number) {
    const ms = days * 24 * 60 * 60 * 1000;
    const w = await windowOf(id);
    await prisma.deletionWindow.update({
      where: { userId: id },
      data: {
        markedAt: new Date(w!.markedAt.getTime() - ms),
        dueAt: new Date(w!.dueAt.getTime() - ms),
      },
    });
    const u = await row(id);
    await prisma.wawuUser.update({
      where: { id },
      data: { deletedAt: new Date(u.deletedAt!.getTime() - ms) },
    });
  }

  // ── the capability checks ────────────────────────────────────────────────

  it('a user who schedules deletion and signs in 10 days later keeps the account, and the Hub is told once', async () => {
    const u = await makeUser();
    const old = await withSession(u);
    await auth.markPendingDeletion(u.id);
    const marked = await row(u.id);
    expect(marked.status).toBe('pending_deletion');
    expect(marked.deletedAt).not.toBeNull();
    const w = await windowOf(u.id);
    expect(w!.dueAt.getTime() - w!.markedAt.getTime()).toBe(DELETION_GRACE_MS);
    await ageDeletion(u.id, 10);

    const session = await signIn(u);
    expect(session.user.status).toBe('active');
    expect(session.accessToken).toBeTruthy();
    const after = await row(u.id);
    expect(after.status).toBe('active');
    expect(after.deletedAt).toBeNull();
    expect(await windowOf(u.id)).toBeNull();
    // The Hub heard once, with this person's own token, on the cancel route.
    expect(hub.calls).toEqual([
      { sub: u.id, path: '/api/hub/account/cancel-deletion', method: 'POST' },
    ]);
    // The new session works; the one from before the delete does not.
    await expect(auth.refresh(session.refreshToken)).resolves.toBeTruthy();
    await expect(auth.refresh(old.refreshToken)).rejects.toMatchObject({
      message: 'Invalid refresh token',
    });
    // Signing in again is an ordinary sign-in: the Hub is not asked again.
    await signIn(u);
    expect(hub.calls).toHaveLength(1);
  });

  it('a phone-code sign-in during the 30 days cancels it too', async () => {
    const u = await makeUser({
      phone: `+23481${randomInt(10_000_000, 99_999_999)}0`,
    });
    await auth.markPendingDeletion(u.id);
    const out = await auth.otpVerify(u.phone, '123456');
    expect(out.user.status).toBe('active');
    expect(hub.calls).toHaveLength(1);
    expect((await row(u.id)).status).toBe('active');
  });

  it('a user who does not sign in for 30 days can no longer sign in, and the Hub is not asked', async () => {
    const u = await makeUser();
    await auth.markPendingDeletion(u.id);
    await ageDeletion(u.id, 31);
    const r = await refusal(signIn(u));
    expect(r).toMatchObject({
      status: 403,
      code: 'ACCOUNT_DELETION_PERIOD_ENDED',
    });
    expect(r.message).not.toContain('—');
    expect(hub.calls).toHaveLength(0);
    expect((await row(u.id)).status).toBe('pending_deletion');
    // At day 30 the Hub's sweep asks WAWU ID to anonymise; after that there is no account to sign in to.
    await auth.deleteUser(u.id, 'anonymize');
    const gone = await refusal(signIn(u));
    expect(gone).toMatchObject({ code: 'USER_NOT_IN_WAWUID' });
    expect(await windowOf(u.id)).toBeNull();
  });

  // ── the attacks ──────────────────────────────────────────────────────────

  it('A delete asked twice keeps the date and the sessions stay revoked', async () => {
    const u = await makeUser();
    await auth.markPendingDeletion(u.id);
    const first = await row(u.id);
    const w1 = await windowOf(u.id);
    await new Promise((r) => setTimeout(r, 25));
    await tokens.issueTokens({ ...first, status: 'active' } as never); // a session stored in between
    await auth.markPendingDeletion(u.id);
    const second = await row(u.id);
    const w2 = await windowOf(u.id);
    expect(second.deletedAt).toEqual(first.deletedAt);
    expect(second.sessionsRevokedAt).toEqual(first.sessionsRevokedAt);
    expect(w2!.dueAt).toEqual(w1!.dueAt);
    expect(w2!.markedAt).toEqual(w1!.markedAt);
    expect(await prisma.refreshToken.count({ where: { userId: u.id } })).toBe(
      0,
    );
    // Asked again with the Hub's own date: still the first date.
    await auth.markPendingDeletion(u.id, new Date(w1!.dueAt.getTime() + 3000));
    expect((await windowOf(u.id))!.dueAt).toEqual(w1!.dueAt);
  });

  it("takes the Hub's own end date when it is believable, and only then", async () => {
    const a = await makeUser();
    const hubDate = new Date(Date.now() + DELETION_GRACE_MS - 4000);
    await auth.markPendingDeletion(a.id, hubDate);
    expect((await windowOf(a.id))!.dueAt).toEqual(hubDate);
    const b = await makeUser();
    await auth.markPendingDeletion(b.id, new Date(Date.now() + 60_000));
    const w = await windowOf(b.id);
    expect(w!.dueAt.getTime() - w!.markedAt.getTime()).toBe(DELETION_GRACE_MS);
  });

  it('two sign-ins together cancel once, the Hub is told once, and both get in', async () => {
    const u = await makeUser();
    await auth.markPendingDeletion(u.id);
    hub.delayMs = 400;
    const [a, b] = await Promise.all([signIn(u), signIn(u)]);
    expect(a.user.status).toBe('active');
    expect(b.user.status).toBe('active');
    expect(hub.calls).toHaveLength(1);
    expect(await windowOf(u.id)).toBeNull();
    // Five at once, after a fresh mark: still one call.
    await auth.markPendingDeletion(u.id);
    hub.calls.length = 0;
    const five = await Promise.all([1, 2, 3, 4, 5].map(() => signIn(u)));
    expect(five.every((s) => s.user.status === 'active')).toBe(true);
    expect(hub.calls).toHaveLength(1);
  });

  it('day 30 runs once even with two workers asking together', async () => {
    const u = await makeUser({ occupation: 'tailor' });
    await auth.markPendingDeletion(u.id);
    await ageDeletion(u.id, 31);
    const [x, y] = await Promise.all([
      auth.deleteUser(u.id, 'anonymize'),
      auth.deleteUser(u.id, 'anonymize'),
    ]);
    expect(x).toEqual({ id: u.id, status: 'banned', deleted: false });
    expect(y).toEqual(x);
    const scrubs = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM s08_scrub_log WHERE user_id = '${u.id}'::uuid`,
    );
    expect(Number(scrubs[0].n)).toBe(1);
    const gone = await row(u.id);
    expect(gone.email).toBeNull();
    expect(gone.passwordHash).toBeNull();
    expect(gone.status).toBe('banned');
    const stamped = gone.deletedAt;
    // And a third, later ask changes nothing, the stamp included.
    await auth.deleteUser(u.id, 'anonymize');
    expect((await row(u.id)).deletedAt).toEqual(stamped);
    expect((await row(u.id)).updatedAt).toEqual(gone.updatedAt);
  });

  it('a token issued before the delete stops working, and stays dead after a cancel', async () => {
    const u = await makeUser();
    const before = await withSession(u);
    const req = (t: string) =>
      ({ headers: { authorization: `Bearer ${t}` } }) as never;
    expect((await reader.accountFor(req(before.accessToken))).id).toBe(u.id);

    await auth.markPendingDeletion(u.id);
    await expect(
      reader.accountFor(req(before.accessToken)),
    ).rejects.toMatchObject({
      response: { code: 'SESSION_INVALID' },
    });
    // Closed accounts hold no session on any other route either.
    await expect(auth.refresh(before.refreshToken)).rejects.toThrow(
      'Invalid refresh token',
    );
    await expect(tokens.issueTokens(await row(u.id))).rejects.toMatchObject({
      response: { code: 'ACCOUNT_DELETION_PENDING' },
    });

    // The cancel brings the account back, not the old session.
    const session = await signIn(u);
    await expect(
      reader.accountFor(req(before.accessToken)),
    ).rejects.toMatchObject({
      response: { code: 'SESSION_INVALID' },
    });
    expect((await reader.accountFor(req(session.accessToken))).id).toBe(u.id);
    await expect(auth.refresh(before.refreshToken)).rejects.toThrow(
      'Invalid refresh token',
    );
  });

  it('a session stored while the account was closed does not come back with it', async () => {
    const u = await makeUser();
    await auth.markPendingDeletion(u.id);
    const stray = await prisma.refreshToken.create({
      data: {
        userId: u.id,
        tokenHash: 'x',
        expiresAt: new Date(Date.now() + 1e9),
      },
    });
    await signIn(u);
    expect(
      await prisma.refreshToken.findUnique({ where: { id: stray.id } }),
    ).toBeNull();
  });

  it('sends no service mail to an account in its 30 days or deleted, and still mails an active one', async () => {
    const live = await makeUser();
    const pending = await makeUser();
    const gone = await makeUser();
    await auth.markPendingDeletion(pending.id);
    await auth.markPendingDeletion(gone.id);
    await auth.deleteUser(gone.id, 'anonymize');

    const report = {
      checkedAt: new Date().toISOString(),
    } as never;
    for (const u of [pending, gone]) {
      expect(
        await auth.sendDittoInvite(u.id, 'https://wawuafrica.com/x', 10),
      ).toEqual({ emailed: false });
      expect(
        await auth.sendUnpaidDeletionWarning(
          u.id,
          24,
          'https://wawuafrica.com/p',
        ),
      ).toEqual({ emailed: false });
      await expect(auth.sendMoneyCheckReport(u.id, report)).rejects.toThrow();
    }
    expect(mail.sendDittoDistributionInvite).not.toHaveBeenCalled();
    expect(mail.sendUnpaidDeletionWarning).not.toHaveBeenCalled();
    expect(mail.sendMoneyCheckReport).not.toHaveBeenCalled();

    expect(
      await auth.sendDittoInvite(live.id, 'https://wawuafrica.com/x', 10),
    ).toEqual({ emailed: true });
    expect(
      await auth.sendUnpaidDeletionWarning(
        live.id,
        24,
        'https://wawuafrica.com/p',
      ),
    ).toEqual({ emailed: true });
    expect(mail.sendDittoDistributionInvite).toHaveBeenCalledTimes(1);
    expect(mail.sendUnpaidDeletionWarning).toHaveBeenCalledTimes(1);
    // Control: the report route's refusal for a deleted account is the "no address" one.
    await expect(
      auth.sendMoneyCheckReport(gone.id, { not: 'a report' }),
    ).rejects.not.toBeInstanceOf(ConflictException);
  });

  it('touches nothing of another account', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const c = await makeUser();
    const sessionB = await withSession(b);
    await auth.markPendingDeletion(c.id);
    const snapB = await row(b.id);
    const snapC = await row(c.id);
    const winC = await windowOf(c.id);

    await auth.markPendingDeletion(a.id);
    await signIn(a);
    await auth.markPendingDeletion(a.id);
    await auth.deleteUser(a.id, 'anonymize');

    expect(await row(b.id)).toEqual(snapB);
    expect(await prisma.refreshToken.count({ where: { userId: b.id } })).toBe(
      1,
    );
    expect(await windowOf(b.id)).toBeNull();
    expect(await row(c.id)).toEqual(snapC);
    expect(await windowOf(c.id)).toEqual(winC);
    await expect(auth.refresh(sessionB.refreshToken)).resolves.toBeTruthy();
    expect(hub.calls.every((x) => x.sub === a.id)).toBe(true);
  });

  // ── the Hub does not settle it ────────────────────────────────────────────

  it('leaves everything as it was when the Hub does not answer, and the same sign-in works later', async () => {
    const u = await makeUser();
    await auth.markPendingDeletion(u.id);
    for (const mode of ['down', 'error500'] as const) {
      hub.mode = mode;
      const r = await refusal(signIn(u));
      expect(r).toMatchObject({
        status: 503,
        code: 'DELETION_CANCEL_UNAVAILABLE',
      });
      expect(r.message).not.toContain('—');
      const w = await windowOf(u.id);
      expect(w!.cancelClaimId).toBeNull();
      expect((await row(u.id)).status).toBe('pending_deletion');
      expect(await prisma.refreshToken.count({ where: { userId: u.id } })).toBe(
        0,
      );
    }
    hub.mode = 'cancel';
    expect((await signIn(u)).user.status).toBe('active');
  });

  it("gives the Hub's own message and restores nothing once the purge has started", async () => {
    const u = await makeUser();
    await auth.markPendingDeletion(u.id);
    hub.mode = 'in_progress';
    const r = await refusal(signIn(u));
    expect(r).toMatchObject({
      status: 403,
      code: 'ACCOUNT_DELETION_IN_PROGRESS',
      message:
        'Your account is already being deleted, so it can no longer be restored.',
    });
    expect((await row(u.id)).status).toBe('pending_deletion');
    expect((await windowOf(u.id))!.cancelClaimId).toBeNull();
    expect(await prisma.refreshToken.count({ where: { userId: u.id } })).toBe(
      0,
    );
  });

  it('clears the account when the Hub has nothing scheduled for it', async () => {
    const u = await makeUser();
    await auth.markPendingDeletion(u.id);
    hub.mode = 'nothing';
    expect((await signIn(u)).user.status).toBe('active');
    expect(await windowOf(u.id)).toBeNull();
  });

  it('a new deletion scheduled while a sign-in is cancelling is not cleared by it', async () => {
    const u = await makeUser();
    await auth.markPendingDeletion(u.id);
    hub.delayMs = 500;
    const racing = refusal(signIn(u));
    // Wait until the Hub has the cancel in hand (the claim is taken by then).
    for (let i = 0; i < 100 && hub.calls.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(hub.calls).toHaveLength(1);
    await auth.markPendingDeletion(u.id); // the Hub's repeat or new schedule lands meanwhile
    const r = await racing;
    expect(r).toMatchObject({ status: 503, code: 'DELETION_CANCEL_BUSY' });
    expect((await row(u.id)).status).toBe('pending_deletion');
    // The next sign-in cancels, and the Hub answers for whatever it holds.
    hub.delayMs = 0;
    expect((await signIn(u)).user.status).toBe('active');
  });

  it("lets a dead sign-in's claim go after two minutes", async () => {
    const u = await makeUser();
    await auth.markPendingDeletion(u.id);
    await prisma.deletionWindow.update({
      where: { userId: u.id },
      data: { cancelClaimId: randomUUID(), cancelClaimedAt: new Date() },
    });
    // A live claim holds the cancel: a sign-in waits, then gives up with a retry answer.
    const started = Date.now();
    const busy = await refusal(signIn(u));
    expect(busy).toMatchObject({ status: 503, code: 'DELETION_CANCEL_BUSY' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(5000);
    expect(hub.calls).toHaveLength(0);
    // A claim older than two minutes is a dead sign-in's.
    await prisma.deletionWindow.update({
      where: { userId: u.id },
      data: { cancelClaimedAt: new Date(Date.now() - 3 * 60 * 1000) },
    });
    expect((await signIn(u)).user.status).toBe('active');
    expect(hub.calls).toHaveLength(1);
  }, 20000);

  // ── what a deletion must not do ──────────────────────────────────────────

  it('never lifts a ban, and records no window for it', async () => {
    const u = await makeUser({ status: 'banned' });
    await withSession(u);
    expect(await auth.markPendingDeletion(u.id)).toEqual({
      id: u.id,
      status: 'banned',
    });
    expect((await row(u.id)).status).toBe('banned');
    expect(await windowOf(u.id)).toBeNull();
    expect(await prisma.refreshToken.count({ where: { userId: u.id } })).toBe(
      0,
    );
  });

  it('leaves an anonymised account exactly as it is', async () => {
    const u = await makeUser();
    await auth.markPendingDeletion(u.id);
    await auth.deleteUser(u.id, 'anonymize');
    const snap = await row(u.id);
    expect(await auth.markPendingDeletion(u.id)).toEqual({
      id: u.id,
      status: 'banned',
    });
    expect(await row(u.id)).toEqual(snap);
    expect(await windowOf(u.id)).toBeNull();
  });

  it('answers 404 for an account that does not exist, as before', async () => {
    await expect(auth.markPendingDeletion(randomUUID())).rejects.toMatchObject({
      status: 404,
    });
  });
});
