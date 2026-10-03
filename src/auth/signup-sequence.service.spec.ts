import { HttpException } from '@nestjs/common';
import type { WawuUser } from '@prisma/client';
import { MemoryRateLimiter } from '../testing/memory-rate-limiter';
import { nextStep, stepsFor } from './signup-sequence';
import { SignupSequenceService } from './signup-sequence.service';

/** The Date clock only: argon2 and promises keep running for real. */
const DATE_ONLY = [
  'hrtime',
  'nextTick',
  'performance',
  'queueMicrotask',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'setImmediate',
  'clearImmediate',
  'setInterval',
  'clearInterval',
  'setTimeout',
  'clearTimeout',
] as const;

type Row = Record<string, unknown>;

/** The few Prisma calls the service makes, over plain rows. */
function fakePrisma() {
  const users = new Map<string, WawuUser>();
  const progress = new Map<string, Row>();
  const codes = new Map<string, Row>();
  const api = {
    users,
    progress,
    codes,
    wawuUser: {
      findUniqueOrThrow: ({ where }: { where: { id: string } }) => {
        const row = users.get(where.id);
        return row
          ? Promise.resolve({ ...row })
          : Promise.reject(new Error('not found'));
      },
      updateMany: ({
        where,
        data,
      }: {
        where: { id: string; email: string; emailVerified: boolean };
        data: Partial<WawuUser>;
      }) => {
        const row = users.get(where.id);
        if (
          !row ||
          row.email !== where.email ||
          row.emailVerified !== where.emailVerified
        ) {
          return Promise.resolve({ count: 0 });
        }
        Object.assign(row, data);
        return Promise.resolve({ count: 1 });
      },
    },
    signupProgress: {
      findUnique: ({ where }: { where: { userId: string } }) =>
        Promise.resolve(
          progress.has(where.userId) ? { ...progress.get(where.userId) } : null,
        ),
      upsert: ({ where }: { where: { userId: string } }) => {
        if (!progress.has(where.userId)) {
          progress.set(where.userId, {
            userId: where.userId,
            emailSkippedAt: null,
            creatorSetupAt: null,
            interestsAt: null,
            followsAt: null,
            completedAt: null,
          });
        }
        return Promise.resolve({ ...progress.get(where.userId) });
      },
      update: ({ where, data }: { where: { userId: string }; data: Row }) => {
        const row = progress.get(where.userId) as Row;
        Object.assign(row, data);
        return Promise.resolve({ ...row });
      },
    },
    signupEmailCode: {
      findUnique: ({ where }: { where: { userId: string } }) =>
        Promise.resolve(
          codes.has(where.userId) ? { ...codes.get(where.userId) } : null,
        ),
      upsert: ({
        where,
        create,
        update,
      }: {
        where: { userId: string };
        create: Row;
        update: Row;
      }) => {
        codes.set(where.userId, {
          ...(codes.get(where.userId) ?? create),
          ...update,
        });
        return Promise.resolve(codes.get(where.userId));
      },
      deleteMany: ({
        where,
      }: {
        where: { userId: string; codeHash: string };
      }) => {
        const row = codes.get(where.userId);
        if (!row || row.codeHash !== where.codeHash) {
          return Promise.resolve({ count: 0 });
        }
        codes.delete(where.userId);
        return Promise.resolve({ count: 1 });
      },
    },
    $queryRaw: () => Promise.resolve([]),
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(api),
  };
  return api;
}

describe('SignupSequenceService', () => {
  let prisma: ReturnType<typeof fakePrisma>;
  let limits: MemoryRateLimiter;
  let service: SignupSequenceService;
  const sendOtpCode = jest.fn<Promise<void>, [string, string, string]>(() =>
    Promise.resolve(),
  );
  const env: Record<string, string> = {};

  const build = () => {
    service = new SignupSequenceService(
      prisma as never,
      limits,
      { sendOtpCode } as never,
      { get: (name: string) => env[name] } as never,
    );
  };

  let seq = 0;
  /** A mobile sign-up whose phone code was just confirmed. */
  function mobile(over: Partial<WawuUser> = {}): WawuUser {
    const user = {
      id: `00000000-0000-0000-0000-${String(++seq).padStart(12, '0')}`,
      email: `p${seq}@example.test`,
      emailVerified: false,
      phone: `+23480312344${String(seq).padStart(2, '0')}`,
      phoneVerifiedAt: new Date(),
      accountType: 'user',
      status: 'active',
      deletedAt: null,
      ...over,
    } as WawuUser;
    prisma.users.set(user.id, user);
    return user;
  }
  const fresh = (user: WawuUser) => prisma.users.get(user.id) as WawuUser;

  async function failure(p: Promise<unknown>): Promise<Row> {
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      return {
        status: (err as HttpException).getStatus(),
        ...((err as HttpException).getResponse() as Row),
      };
    }
    throw new Error('expected the call to fail');
  }
  const mailed = () =>
    sendOtpCode.mock.calls.at(-1) as [string, string, string];
  const later = (seconds: number) =>
    jest.setSystemTime(new Date(Date.now() + seconds * 1000));

  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: [...DATE_ONLY],
      now: new Date('2026-10-03T10:00:00Z'),
    });
    prisma = fakePrisma();
    limits = new MemoryRateLimiter();
    sendOtpCode.mockClear();
    build();
  });
  afterEach(() => jest.useRealTimers());

  // ── the order ─────────────────────────────────────────────────────────────

  it('orders a discovering account email, A12, A13 and an earning one email, A11', () => {
    expect(stepsFor('user')).toEqual(['email', 'interests', 'follows']);
    expect(stepsFor('creator')).toEqual(['email', 'creator_setup']);
    // No pick reads as discover: the pick that opens no wallet (R-6).
    expect(stepsFor(null)).toEqual(['email', 'interests', 'follows']);
    const none = {
      emailSkippedAt: null,
      creatorSetupAt: null,
      interestsAt: null,
      followsAt: null,
    };
    // An account with no email has nothing to prove.
    expect(
      nextStep(
        { accountType: 'user', email: null, emailVerified: false },
        none,
      ),
    ).toBe('interests');
  });

  it('starts a just-confirmed mobile account at the email step', async () => {
    const user = mobile();
    await expect(service.progress(user)).resolves.toEqual({
      step: 'email',
      inSequence: true,
      accountType: 'user',
      steps: ['email', 'interests', 'follows'],
      emailProven: false,
    });
  });

  it('puts every web, legacy and phone-only account outside the sequence, with nothing to complete', async () => {
    const web = mobile({ phoneVerifiedAt: null, emailVerified: true });
    await expect(service.progress(web)).resolves.toEqual({
      step: 'done',
      inSequence: false,
      accountType: 'user',
      steps: [],
      emailProven: true,
    });
    expect(prisma.progress.has(web.id)).toBe(false);
    expect(await failure(service.complete(web, 'email'))).toMatchObject({
      status: 409,
      code: 'SIGNUP_ALREADY_FINISHED',
    });
    expect(prisma.progress.has(web.id)).toBe(false);
  });

  it('walks a discovering account through every step, one at a time, to done', async () => {
    const user = mobile();
    expect((await service.complete(user, 'email')).step).toBe('interests');
    expect((await service.complete(fresh(user), 'interests')).step).toBe(
      'follows',
    );
    const done = await service.complete(fresh(user), 'follows');
    expect(done.step).toBe('done');
    expect(prisma.progress.get(user.id)?.completedAt).toBeInstanceOf(Date);
  });

  it('walks an earning account through the email step and A11 to done', async () => {
    const user = mobile({ accountType: 'creator' });
    expect((await service.complete(user, 'email')).step).toBe('creator_setup');
    expect((await service.complete(user, 'creator_setup')).step).toBe('done');
  });

  it('refuses a step before the one in front of it is done, and changes nothing', async () => {
    const user = mobile();
    expect(await failure(service.complete(user, 'interests'))).toMatchObject({
      status: 409,
      code: 'SIGNUP_STEP_OUT_OF_ORDER',
    });
    expect(await failure(service.complete(user, 'follows'))).toMatchObject({
      status: 409,
      code: 'SIGNUP_STEP_OUT_OF_ORDER',
    });
    await service.complete(user, 'email');
    expect(await failure(service.complete(user, 'follows'))).toMatchObject({
      status: 409,
      code: 'SIGNUP_STEP_OUT_OF_ORDER',
    });
    expect(prisma.progress.get(user.id)).toMatchObject({
      interestsAt: null,
      followsAt: null,
      completedAt: null,
    });
    expect((await service.progress(user)).step).toBe('interests');
  });

  it("refuses a step that is not this account's", async () => {
    const creator = mobile({ accountType: 'creator' });
    await service.complete(creator, 'email');
    expect(await failure(service.complete(creator, 'interests'))).toMatchObject(
      { status: 409, code: 'SIGNUP_STEP_OUT_OF_ORDER' },
    );
    const discover = mobile();
    await service.complete(discover, 'email');
    expect(
      await failure(service.complete(discover, 'creator_setup')),
    ).toMatchObject({ status: 409, code: 'SIGNUP_STEP_OUT_OF_ORDER' });
  });

  it('answers a repeated step with the progress unchanged (a double tap)', async () => {
    const user = mobile({ accountType: 'creator' });
    await service.complete(user, 'email');
    const first = await service.complete(user, 'creator_setup');
    const stamp = prisma.progress.get(user.id)?.creatorSetupAt;
    later(5);
    await expect(service.complete(user, 'creator_setup')).resolves.toEqual(
      first,
    );
    expect(prisma.progress.get(user.id)?.creatorSetupAt).toBe(stamp);
  });

  it('resumes at the next step after the app is closed: a new instance reads the same place', async () => {
    const user = mobile();
    await service.complete(user, 'email');
    await service.complete(user, 'interests');
    build();
    expect((await service.progress(fresh(user))).step).toBe('follows');
  });

  // ── the email step (G-27) ─────────────────────────────────────────────────

  it("mails a code to the account's own email only, and stores neither the code nor the address", async () => {
    const user = mobile({ email: 'ada@example.test' });
    const sent = await service.emailStart(user);
    expect(sent).toEqual({
      email: 'ada@example.test',
      expiresIn: 600,
      resendIn: 60,
    });
    const [to, code] = mailed();
    expect(to).toBe('ada@example.test');
    expect(code).toMatch(/^\d{6}$/);
    const stored = JSON.stringify([...prisma.codes.values()]);
    expect(stored).not.toContain(code);
    expect(stored).not.toContain('ada@example.test');
  });

  it('proves the email with the right code: the email step is done and the next step comes up', async () => {
    const user = mobile();
    await service.emailStart(user);
    const out = await service.emailConfirm(user, mailed()[1]);
    expect(out).toMatchObject({ step: 'interests', emailProven: true });
    expect(fresh(user).emailVerified).toBe(true);
    expect(prisma.codes.has(user.id)).toBe(false);
  });

  it('refuses a wrong code, then waits after the fourth wrong code in a row', async () => {
    const user = mobile();
    await service.emailStart(user);
    const right = mailed()[1];
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 3; i += 1) {
      expect(await failure(service.emailConfirm(user, wrong))).toMatchObject({
        status: 400,
        code: 'EMAIL_CODE_INVALID',
      });
    }
    expect(await failure(service.emailConfirm(user, wrong))).toMatchObject({
      status: 429,
      code: 'EMAIL_CODE_LOCKED',
      retryAfterSeconds: 900,
    });
    // The right code waits too.
    expect(await failure(service.emailConfirm(user, right))).toMatchObject({
      status: 429,
      code: 'EMAIL_CODE_LOCKED',
    });
    expect(fresh(user).emailVerified).toBe(false);
  });

  it('refuses an expired code', async () => {
    const user = mobile();
    await service.emailStart(user);
    later(601);
    expect(
      await failure(service.emailConfirm(user, mailed()[1])),
    ).toMatchObject({ status: 400, code: 'EMAIL_CODE_INVALID' });
    expect(fresh(user).emailVerified).toBe(false);
  });

  it('refuses a code mailed to an address the account no longer has', async () => {
    const user = mobile({ email: 'old@example.test' });
    await service.emailStart(user);
    const code = mailed()[1];
    fresh(user).email = 'new@example.test';
    expect(
      await failure(service.emailConfirm(fresh(user), code)),
    ).toMatchObject({ status: 400, code: 'EMAIL_CODE_INVALID' });
    expect(fresh(user).emailVerified).toBe(false);
  });

  it('marks nothing when the email moved away between the check and the write', async () => {
    const user = mobile({ email: 'moving@example.test' });
    await service.emailStart(user);
    const code = mailed()[1];
    // Another account claimed the address meanwhile (AUTH-03's claim).
    const stale = { ...fresh(user) };
    fresh(user).email = null;
    expect(await failure(service.emailConfirm(stale, code))).toMatchObject({
      status: 400,
      code: 'EMAIL_CODE_INVALID',
    });
    expect(fresh(user).emailVerified).toBe(false);
  });

  it('waits between codes and caps codes a day', async () => {
    const user = mobile();
    await service.emailStart(user);
    expect(await failure(service.emailStart(user))).toMatchObject({
      status: 429,
      code: 'EMAIL_CODE_RESEND_TOO_SOON',
      retryAfterSeconds: 60,
    });
    for (let i = 0; i < 4; i += 1) {
      later(61);
      await service.emailStart(user);
    }
    later(61);
    expect(await failure(service.emailStart(user))).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
    });
    expect(sendOtpCode).toHaveBeenCalledTimes(5);
  });

  it('refuses to mail an email that is already proven, or an account with none', async () => {
    const proven = mobile({ emailVerified: true });
    expect(await failure(service.emailStart(proven))).toMatchObject({
      status: 409,
      code: 'EMAIL_ALREADY_PROVEN',
    });
    const none = mobile({ email: null });
    expect(await failure(service.emailStart(none))).toMatchObject({
      status: 409,
      code: 'EMAIL_NOT_SET',
    });
    expect(sendOtpCode).not.toHaveBeenCalled();
  });

  it('lets a person who put the email off prove it later', async () => {
    const user = mobile();
    await service.complete(user, 'email');
    await service.emailStart(user);
    const out = await service.emailConfirm(user, mailed()[1]);
    expect(out).toMatchObject({ step: 'interests', emailProven: true });
  });
});
