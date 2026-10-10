import { HttpException } from '@nestjs/common';
import { createHash } from 'crypto';
import { MemoryRateLimiter } from '../testing/memory-rate-limiter';
import { RecordingSmsProvider } from '../testing/recording-sms.provider';
import { AuthService } from './auth.service';
import {
  PhoneSignupService,
  type PhoneCodeSent,
  type SignupStarted,
} from './phone-signup.service';

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

interface CodeRow extends Row {
  id: string;
  userId: string;
  phone: string;
  codeHash: string;
  attemptHash: string;
  claimEmail: string | null;
  emailCodeHash: string | null;
  expiresAt: Date;
  lastSentAt: Date;
  signupExpiresAt: Date;
}

interface UserRow extends Row {
  id: string;
  email: string | null;
  phone: string;
  emailVerified: boolean;
  phoneVerifiedAt: Date | null;
  passwordHash: string | null;
  occupation: string | null;
  accountType: string | null;
  phoneVerification: CodeRow | null;
}

type Where = Record<string, unknown>;

/** A Prisma `where` over plain rows: equality, `in`, `not` and `OR`. */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'OR') return (want as Where[]).some((w) => matches(row, w));
    const have = row[key];
    if (want && typeof want === 'object' && 'in' in want) {
      return (want.in as unknown[]).includes(have);
    }
    if (want && typeof want === 'object' && 'not' in want) {
      return have !== want.not;
    }
    return have === want;
  });
}

/** The few Prisma calls the service makes, over one array of users. */
function fakePrisma() {
  const users: UserRow[] = [];
  let seq = 0;
  const codes = () =>
    users.flatMap((u) => (u.phoneVerification ? [u.phoneVerification] : []));

  const api = {
    users,
    codes,
    wawuUser: {
      findMany: ({ where }: { where: Where }) =>
        Promise.resolve(users.filter((u) => matches(u, where))),
      create: ({ data }: { data: Row }) => {
        const { phoneVerification, ...rest } = data as {
          phoneVerification?: { create: Partial<CodeRow> };
        } & Row;
        const taken = users.some(
          (u) =>
            (rest.email && u.email === rest.email) || u.phone === rest.phone,
        );
        if (taken) {
          return Promise.reject(
            Object.assign(new Error('Unique constraint failed'), {
              code: 'P2002',
            }),
          );
        }
        const id = `u${++seq}`;
        const row = {
          id,
          emailVerified: false,
          phoneVerifiedAt: null,
          ...rest,
          phoneVerification: phoneVerification
            ? ({
                id: `c${++seq}`,
                userId: id,
                ...phoneVerification.create,
              } as CodeRow)
            : null,
        } as UserRow;
        users.push(row);
        return Promise.resolve(row);
      },
      update: ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<UserRow>;
      }) => {
        const row = users.find((u) => u.id === where.id) as UserRow;
        if (
          data.email &&
          users.some((u) => u.id !== row.id && u.email === data.email)
        ) {
          return Promise.reject(
            Object.assign(new Error('Unique constraint failed'), {
              code: 'P2002',
            }),
          );
        }
        Object.assign(row, data);
        return Promise.resolve(row);
      },
      updateMany: ({
        where,
        data,
      }: {
        where: Where;
        data: Partial<UserRow>;
      }) => {
        const hit = users.filter(
          (u) =>
            matches(u, where) &&
            u.id !== (where.id as { not: string } | undefined)?.not,
        );
        hit.forEach((u) => Object.assign(u, data));
        return Promise.resolve({ count: hit.length });
      },
      deleteMany: ({ where }: { where: { id: string } }) => {
        const at = users.findIndex((u) => u.id === where.id);
        if (at >= 0) users.splice(at, 1);
        return Promise.resolve({ count: at >= 0 ? 1 : 0 });
      },
    },
    phoneVerification: {
      findUnique: ({ where }: { where: { attemptHash: string } }) => {
        const owner = users.find(
          (u) => u.phoneVerification?.attemptHash === where.attemptHash,
        );
        return Promise.resolve(
          owner?.phoneVerification
            ? { ...owner.phoneVerification, user: owner }
            : null,
        );
      },
      update: ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<CodeRow>;
      }) => {
        const row = codes().find((c) => c.id === where.id) as CodeRow;
        Object.assign(row, data);
        return Promise.resolve(row);
      },
      deleteMany: ({ where }: { where: { id: string } }) => {
        const owner = users.find((u) => u.phoneVerification?.id === where.id);
        if (!owner) return Promise.resolve({ count: 0 });
        owner.phoneVerification = null;
        return Promise.resolve({ count: 1 });
      },
    },
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(api),
  };
  return api;
}

describe('PhoneSignupService', () => {
  let prisma: ReturnType<typeof fakePrisma>;
  let sms: RecordingSmsProvider;
  let service: PhoneSignupService;
  const sessionFor = jest.fn((user: Row) =>
    Promise.resolve({ accessToken: 'a', refreshToken: 'r', user }),
  );
  const sendOtpCode = jest.fn<Promise<void>, [string, string, string]>(() =>
    Promise.resolve(),
  );

  const baseEnv: Record<string, string> = {
    PHONE_CODE_TTL_SECONDS: '300',
    PHONE_CODE_MAX_WRONG: '4',
    PHONE_CODE_LOCKOUT_SECONDS: '900',
    PHONE_CODE_RESEND_SECONDS: '60',
    PHONE_CODE_DAILY_WRONG_CAP: '12',
    PENDING_SIGNUP_TTL_SECONDS: '86400',
    SMS_LIMIT_IP_PER_HOUR: '30',
    SMS_LIMIT_IP_PER_DAY: '100',
    SMS_LIMIT_PHONE_PER_DAY: '5',
    SMS_LIMIT_GLOBAL_PER_DAY: '2000',
    CONFIRM_LIMIT_IP_PER_HOUR: '120',
  };

  const IP = '203.0.113.7';
  const PHONE = '+2348031234412';
  const signup = {
    email: 'Ada@Example.test',
    phone: '0803 123 4412',
    password: 'a-long-password',
  };

  const wrongCode = (real: string) => (real === '000000' ? '111111' : '000000');
  /** The code for a resend is texted in the background; let it go out. */
  const flush = () => new Promise<void>((done) => setImmediate(done));
  const later = (seconds: number) =>
    jest.setSystemTime(new Date(Date.now() + seconds * 1000));

  async function failure(p: Promise<unknown>): Promise<Row> {
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      return (err as HttpException).getResponse() as Row;
    }
    throw new Error('expected the call to fail');
  }

  function build(env: Record<string, string> = {}) {
    prisma = fakePrisma();
    sms = new RecordingSmsProvider();
    sessionFor.mockClear();
    sendOtpCode.mockClear();
    service = new PhoneSignupService(
      prisma as never,
      { sessionFor } as unknown as AuthService,
      { get: (name: string) => ({ ...baseEnv, ...env })[name] } as never,
      sms,
      new MemoryRateLimiter(),
      { sendOtpCode } as never,
    );
  }

  /** Sign up and return what the person holds: the secret and the code just texted. */
  async function begin(
    over: Partial<typeof signup> = {},
    ip = IP,
  ): Promise<{ out: SignupStarted; attempt: string; code: string }> {
    const out = await service.signup({ ...signup, ...over }, ip);
    return { out, attempt: out.attempt, code: sms.lastCode() };
  }

  const emailCodeSent = () => sendOtpCode.mock.calls.at(-1)?.[1] as string;
  const confirm = (
    attempt: string,
    code: string,
    phone = PHONE,
    emailCode?: string,
    ip = IP,
  ) => service.confirm(phone, attempt, code, emailCode, ip);

  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: [...DATE_ONLY],
      now: new Date('2026-10-02T10:00:00Z'),
    });
    build();
  });
  afterEach(() => jest.useRealTimers());

  // ── the basics ──────────────────────────────────────────────────────────────

  it('creates the account with the phone stored normalised, texts the code, returns the secret, and issues no session', async () => {
    const out = await service.signup(
      { ...signup, occupation: ' Photographer ', accountType: 'creator' },
      IP,
    );

    expect(out).toMatchObject({
      phone: PHONE,
      expiresIn: 300,
      resendIn: 60,
      emailCodeRequired: false,
    });
    expect(out.attempt.length).toBeGreaterThanOrEqual(43);
    expect(prisma.users[0]).toMatchObject({
      email: 'ada@example.test',
      phone: PHONE,
      occupation: 'Photographer',
      accountType: 'creator',
      emailVerified: false,
      phoneVerifiedAt: null,
    });
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0].to).toBe(PHONE);
    expect(sessionFor).not.toHaveBeenCalled();
    const stored = JSON.stringify(prisma.codes());
    expect(stored).not.toContain(sms.lastCode());
    expect(stored).not.toContain(out.attempt);
    expect(stored).toContain(
      createHash('sha256').update(out.attempt).digest('hex'),
    );
  });

  it('gives each sign-up its own secret', async () => {
    const a = await service.signup(signup, IP);
    later(61);
    const b = await service.signup(
      { ...signup, password: 'another-long-one' },
      IP,
    );
    expect(a.attempt).not.toBe(b.attempt);
  });

  it('proves the phone with the right code and secret, once, then issues the session', async () => {
    const { attempt, code } = await begin();
    const out = await confirm(attempt, code);

    expect(out.accessToken).toBe('a');
    expect(prisma.users[0].phoneVerifiedAt).toBeInstanceOf(Date);
    // Round 2, D1: the number the code went to is recorded, so the token
    // vouches for it only while the account still holds it.
    expect(
      (prisma.users[0] as unknown as { phoneVerifiedFor: string })
        .phoneVerifiedFor,
    ).toBe(PHONE);
    expect(prisma.users[0].phoneVerification).toBeNull();
    expect(sessionFor).toHaveBeenCalledTimes(1);
  });

  it('records the number the code went to, not whatever the account holds by then', async () => {
    const { attempt, code } = await begin();
    // The internal phone-change route moved the account to another number
    // while the code was waiting; the code was texted to PHONE.
    prisma.users[0].phone = '2348090000000';
    await confirm(attempt, code);
    expect(
      (prisma.users[0] as unknown as { phoneVerifiedFor: string })
        .phoneVerifiedFor,
    ).toBe(PHONE);
  });

  it('refuses a phone that is not a phone, without creating anything', async () => {
    const body = await failure(
      service.signup({ ...signup, phone: '1234567' }, IP),
    );
    expect(body.code).toBe('PHONE_INVALID');
    expect(prisma.users).toHaveLength(0);
  });

  it('does not create an account, or send anything, when SMS is not configured', async () => {
    sms.configured = false;
    const body = await failure(service.signup(signup, IP));
    expect(body).toMatchObject({ statusCode: 503, code: 'SMS_NOT_CONFIGURED' });
    expect(prisma.users).toHaveLength(0);
  });

  it('tells the person when the provider refuses, and lets them ask again at once', async () => {
    sms.failNext = true;
    const body = await failure(service.signup(signup, IP));
    expect(body).toMatchObject({ statusCode: 503, code: 'SMS_SEND_FAILED' });

    await service.signup(signup, IP);
    expect(prisma.users).toHaveLength(1);
    expect(sms.sent).toHaveLength(1);
  });

  // ── F-8: Nigerian numbers only ──────────────────────────────────────────────

  it('refuses an international number and sends nothing', async () => {
    for (const phone of ['+14155552671', '+442071838750']) {
      const body = await failure(service.signup({ ...signup, phone }, IP));
      expect(body).toMatchObject({
        statusCode: 400,
        code: 'PHONE_NOT_SUPPORTED',
      });
      const again = await failure(service.start(phone, 'x', IP));
      expect(again.code).toBe('PHONE_NOT_SUPPORTED');
    }
    expect(sms.sent).toHaveLength(0);
    expect(prisma.users).toHaveLength(0);
  });

  it('takes the allowed prefix from configuration', async () => {
    build({ SIGNUP_ALLOWED_PHONE_PREFIX: '+233' });
    const body = await failure(service.signup(signup, IP));
    expect(body.code).toBe('PHONE_NOT_SUPPORTED');
    await service.signup({ ...signup, phone: '+233241234567' }, IP);
    expect(sms.sent[0].to).toBe('+233241234567');
  });

  // ── D-1: a code only works in the sign-up that asked for it ────────────────

  it('never signs the victim in to the attacker account when a later sign-up replaces theirs', async () => {
    // The victim signs up and waits for the text.
    const victim = await begin({ email: 'victim@example.test' });
    later(61);
    // The attacker signs up with the victim's phone and an email and password of their own.
    const attacker = await begin({
      email: 'attacker@example.test',
      password: 'attackers-own-password',
    });
    expect(attacker.code).not.toBe(victim.code);
    expect(prisma.users).toHaveLength(1);

    // The victim types the newest text they received, with the secret they hold.
    const body = await failure(confirm(victim.attempt, attacker.code));
    expect(body).toMatchObject({ statusCode: 400, code: 'PHONE_CODE_INVALID' });
    expect(sessionFor).not.toHaveBeenCalled();
    // and with their own first code too
    const old = await failure(confirm(victim.attempt, victim.code));
    expect(old.code).toBe('PHONE_CODE_INVALID');
    expect(sessionFor).not.toHaveBeenCalled();
    expect(prisma.users[0].email).toBe('attacker@example.test');
    expect(prisma.users[0].phoneVerifiedAt).toBeNull();
  });

  it('never lets the attacker redeem a code that was texted to the victim', async () => {
    const victim = await begin({ email: 'victim@example.test' });
    // Without the victim's secret there is nothing to redeem, whatever the code.
    for (const guess of [victim.code, '123456']) {
      const body = await failure(confirm('made-up-secret', guess));
      expect(body.code).toBe('PHONE_CODE_INVALID');
    }
    expect(sessionFor).not.toHaveBeenCalled();
    // the victim's own sign-up is untouched and still works
    const out = await confirm(victim.attempt, victim.code);
    expect(out.accessToken).toBe('a');
  });

  it('turns a repeat sign-up by the same person into a new attempt that retires the old one', async () => {
    const first = await begin();
    later(61);
    const second = await begin();
    expect(prisma.users).toHaveLength(1);
    expect(second.attempt).not.toBe(first.attempt);
    const body = await failure(confirm(first.attempt, second.code));
    expect(body.code).toBe('PHONE_CODE_INVALID');
    const out = await confirm(second.attempt, second.code);
    expect(out.accessToken).toBe('a');
  });

  it('refuses a secret that belongs to another number', async () => {
    const a = await begin({ phone: '08031234412' });
    const b = await begin({ email: 'b@example.test', phone: '08032223334' });
    const body = await failure(confirm(a.attempt, b.code, '+2348032223334'));
    expect(body.code).toBe('PHONE_CODE_INVALID');
    expect(sessionFor).not.toHaveBeenCalled();
  });

  // ── U-1: a stranger spends nothing of the number's ─────────────────────────

  it('does not count a request without the secret against the number', async () => {
    const { attempt, code } = await begin();
    for (let i = 0; i < 10; i++) {
      await failure(
        confirm(
          'not-the-secret',
          '000000',
          PHONE,
          undefined,
          `198.51.100.${i}`,
        ),
      );
    }
    // the holder is not locked out, and still has all four guesses
    for (let i = 0; i < 3; i++) {
      await failure(confirm(attempt, wrongCode(code)));
    }
    const out = await confirm(attempt, code);
    expect(out.accessToken).toBe('a');
  });

  it('answers start without the secret like any number, sends nothing, and leaves the resend gap alone', async () => {
    const { attempt } = await begin();
    later(61);
    const answers: PhoneCodeSent[] = [];
    for (const secret of ['nope', '', attempt.slice(1)]) {
      answers.push(await service.start('0803 123 4412', secret || 'x', IP));
    }
    expect(answers.map((a) => [a.expiresIn, a.resendIn])).toEqual([
      [300, 60],
      [300, 60],
      [300, 60],
    ]);
    await flush();
    expect(sms.sent).toHaveLength(1);
    // the real holder can resend straight away: nothing was spent
    await service.start(PHONE, attempt, IP);
    await flush();
    expect(sms.sent).toHaveLength(2);
  });

  it('does not let a stranger find out that a sign-up for a number just started', async () => {
    await begin();
    const stranger = await service.start(PHONE, 'not-the-secret', IP);
    expect(stranger.phone).toBe(PHONE);
    const unknown = await service.start('+2348055555555', 'not-the-secret', IP);
    expect(unknown.expiresIn).toBe(stranger.expiresIn);
  });

  // ── F-1: only a pending sign-up can be texted or confirmed ─────────────────

  const legacy = (over: Partial<UserRow> = {}): UserRow => ({
    id: 'legacy1',
    email: 'old@example.test',
    phone: '+2348099900011',
    emailVerified: true,
    phoneVerifiedAt: null,
    passwordHash: 'x',
    occupation: null,
    accountType: null,
    phoneVerification: null,
    ...over,
  });

  it('never texts an existing account that did not come from sign-up', async () => {
    prisma.users.push(legacy());
    for (const phone of ['+2348099900011', '08099900011']) {
      const out = await service.start(phone, 'any-secret', IP);
      expect(out.phone).toBe('+2348099900011');
      later(61);
    }
    expect(sms.sent).toHaveLength(0);
  });

  it('never gives a session to an existing account, whatever code and secret are sent', async () => {
    prisma.users.push(legacy());
    for (let i = 0; i < 3; i++) {
      const body = await failure(
        confirm('any-secret', '123456', '+2348099900011'),
      );
      expect(body.code).toBe('PHONE_CODE_INVALID');
    }
    expect(sessionFor).not.toHaveBeenCalled();
    expect(prisma.users[0].phoneVerifiedAt).toBeNull();
  });

  it('never texts or confirms an account whose phone is already proven', async () => {
    const { attempt, code } = await begin();
    await confirm(attempt, code);
    later(61);
    sessionFor.mockClear();
    await service.start(PHONE, attempt, IP);
    await flush();
    expect(sms.sent).toHaveLength(1);
    const body = await failure(confirm(attempt, '123456'));
    expect(body.code).toBe('PHONE_CODE_INVALID');
    expect(sessionFor).not.toHaveBeenCalled();
  });

  it('does not treat a legacy account with the same phone as pending', async () => {
    prisma.users.push(legacy({ phone: '08099900011' }));
    const body = await failure(
      service.signup(
        { ...signup, email: 'new@example.test', phone: '+2348099900011' },
        IP,
      ),
    );
    expect(body.statusCode).toBe(409);
    expect(sms.sent).toHaveLength(0);
  });

  // ── wrong codes (A15) and the wait ──────────────────────────────────────────

  it('answers a wrong code as A15 does, three times, and the right code still works', async () => {
    const { attempt, code } = await begin();
    for (let i = 0; i < 3; i++) {
      const body = await failure(confirm(attempt, wrongCode(code)));
      expect(body).toEqual({
        statusCode: 400,
        code: 'PHONE_CODE_INVALID',
        message: "That code isn't right",
      });
    }
    const out = await confirm(attempt, code, '08031234412');
    expect(out.accessToken).toBe('a');
  });

  it('makes the user wait after the fourth wrong code, even for the right one', async () => {
    const { attempt, code } = await begin();
    for (let i = 0; i < 3; i++)
      await failure(confirm(attempt, wrongCode(code)));
    const fourth = await failure(confirm(attempt, wrongCode(code)));
    expect(fourth).toMatchObject({
      statusCode: 429,
      code: 'PHONE_CODE_LOCKED',
      retryAfterSeconds: 900,
    });
    const right = await failure(confirm(attempt, code));
    expect(right.code).toBe('PHONE_CODE_LOCKED');
    expect(sessionFor).not.toHaveBeenCalled();
  });

  it('lets the user try again after the wait, with a new code', async () => {
    const first = await begin();
    for (let i = 0; i < 4; i++) {
      await failure(confirm(first.attempt, wrongCode(first.code)));
    }
    later(901);
    await service.start(PHONE, first.attempt, IP);
    await flush();
    expect(sms.sent).toHaveLength(2);
    const out = await confirm(first.attempt, sms.lastCode());
    expect(out.accessToken).toBe('a');
  });

  // ── F-2: a resend gives no guesses back ─────────────────────────────────────

  it('does not hand the wrong-code budget back when a fresh code is sent', async () => {
    const { attempt } = await begin();
    for (let round = 0; round < 2; round++) {
      later(61);
      await failure(confirm(attempt, wrongCode(sms.lastCode())));
      await failure(confirm(attempt, wrongCode(sms.lastCode())));
      await service.start(PHONE, attempt, IP).catch(() => undefined);
      await flush();
    }
    const body = await failure(confirm(attempt, wrongCode(sms.lastCode())));
    expect(body).toMatchObject({ statusCode: 429, code: 'PHONE_CODE_LOCKED' });
  });

  it('caps wrong codes per day however often the wait ends', async () => {
    build({ PENDING_SIGNUP_TTL_SECONDS: '172800' });
    const { attempt } = await begin();
    for (let round = 0; round < 8; round++) {
      later(901);
      for (let i = 0; i < 4; i++) {
        await failure(confirm(attempt, wrongCode(sms.lastCode())));
      }
    }
    const right = await failure(confirm(attempt, sms.lastCode()));
    expect(right.code).toBe('PHONE_CODE_LOCKED');
    expect(right.retryAfterSeconds).toBeGreaterThan(900);
    expect(prisma.users[0].phoneVerifiedAt).toBeNull();

    later(24 * 3600);
    await service.start(PHONE, attempt, IP);
    await flush();
    const out = await confirm(attempt, sms.lastCode());
    expect(out.accessToken).toBe('a');
  });

  // ── F-3: the same answer for every kind of number ──────────────────────────

  it('answers start the same for a pending, an existing, an unknown number and a wrong secret', async () => {
    prisma.users.push(legacy());
    const { attempt } = await begin();
    later(61);
    const answers: PhoneCodeSent[] = [];
    answers.push(await service.start(PHONE, attempt, IP));
    answers.push(await service.start('+2348099900011', attempt, IP));
    answers.push(await service.start('+2348055555555', attempt, IP));
    answers.push(await service.start(PHONE, 'wrong-secret', IP));
    expect(answers.map((a) => [a.expiresIn, a.resendIn])).toEqual(
      Array(4).fill([300, 60]),
    );
  });

  it('answers confirm the same for an unknown number, a wrong secret and a wrong code', async () => {
    const { attempt, code } = await begin();
    const shapes = [
      await failure(confirm('wrong-secret', code)),
      await failure(confirm(attempt, wrongCode(code), '+2348055555555')),
      await failure(confirm(attempt, wrongCode(code))),
    ];
    expect(
      shapes.map((s) => `${String(s.statusCode)}:${String(s.code)}`),
    ).toEqual(Array(3).fill('400:PHONE_CODE_INVALID'));
  });

  it('refuses an expired code without telling it apart from a wrong one', async () => {
    const { attempt, code } = await begin();
    later(301);
    const body = await failure(confirm(attempt, code));
    expect(body.code).toBe('PHONE_CODE_INVALID');
  });

  // ── F-4: an unproven sign-up holds nothing ─────────────────────────────────

  it('lets a newer sign-up take over an unproven one, which is then gone', async () => {
    const first = await begin();
    later(61);
    await begin({ password: 'a-different-password' });
    expect(prisma.users).toHaveLength(1);
    const body = await failure(confirm(first.attempt, first.code));
    expect(body.code).toBe('PHONE_CODE_INVALID');
  });

  it('lets a stranger take an unproven phone', async () => {
    await begin();
    later(61);
    await begin({ email: 'thief@example.test' });
    expect(prisma.users).toHaveLength(1);
    expect(prisma.users[0].email).toBe('thief@example.test');
  });

  it('never takes the phone of a proven account', async () => {
    const { attempt, code } = await begin();
    await confirm(attempt, code);
    later(61);
    const body = await failure(
      service.signup({ ...signup, email: 'another@example.test' }, IP),
    );
    expect(body.statusCode).toBe(409);
    expect(prisma.users).toHaveLength(1);
  });

  it('never takes the email of an account that proved it, or of a web or legacy account', async () => {
    prisma.users.push(legacy({ email: 'real@example.test' }));
    const body = await failure(
      service.signup({ ...signup, email: 'real@example.test' }, IP),
    );
    expect(body.statusCode).toBe(409);
    prisma.users.push(
      legacy({
        id: 'web',
        email: 'web@example.test',
        phone: '08077700000',
        emailVerified: false,
      }),
    );
    const web = await failure(
      service.signup({ ...signup, email: 'web@example.test' }, IP),
    );
    expect(web.statusCode).toBe(409);
    expect(prisma.users).toHaveLength(2);
    expect(sms.sent).toHaveLength(0);
  });

  it('stops accepting a code once the sign-up has expired', async () => {
    const { attempt, code } = await begin();
    later(24 * 3600 + 1);
    const body = await failure(confirm(attempt, code));
    expect(body.code).toBe('PHONE_CODE_INVALID');
    await service.start(PHONE, attempt, IP);
    await flush();
    expect(sms.sent).toHaveLength(1);
  });

  // ── D-3: an email held by a phone-proven account ───────────────────────────

  /** A mobile account that proved its phone and never its email. */
  async function provenMobile(email: string, phone: string) {
    const s = await begin({ email, phone });
    await confirm(
      s.attempt,
      s.code,
      phone.startsWith('+') ? phone : `+234${phone.slice(1)}`,
    );
    later(61);
    return prisma.users.find((u) => u.email === email) as UserRow;
  }

  it('takes nothing from a phone-proven account when someone signs up with its email', async () => {
    const victim = await provenMobile('victim@example.test', '08022222222');
    const claimant = await begin({
      email: 'victim@example.test',
      phone: '09011111111',
    });
    expect(claimant.out.emailCodeRequired).toBe(true);
    expect(victim.email).toBe('victim@example.test');
    expect(victim.phone).toBe('+2348022222222');
    expect(victim.phoneVerifiedAt).not.toBeNull();
    // the claimant's account holds no email until the mailbox is proven
    const mine = prisma.users.find(
      (u) => u.phone === '+2349011111111',
    ) as UserRow;
    expect(mine.email).toBeNull();
    // and abandoning the sign-up leaves the victim exactly as they were
    later(24 * 3600 + 1);
    expect(victim.email).toBe('victim@example.test');
  });

  it('gives the email to the person who proves the mailbox, and keeps the other account signing in by phone', async () => {
    const squatter = await provenMobile('owner@example.test', '09011111111');
    const owner = await begin({
      email: 'owner@example.test',
      phone: '08022222222',
    });
    expect(owner.out.emailCodeRequired).toBe(true);
    expect(sendOtpCode).toHaveBeenCalledWith(
      'owner@example.test',
      expect.stringMatching(/^\d{6}$/),
      expect.any(String),
    );

    // the phone code alone is not enough
    const half = await failure(
      confirm(owner.attempt, owner.code, '+2348022222222'),
    );
    expect(half.code).toBe('PHONE_CODE_INVALID');
    expect(squatter.email).toBe('owner@example.test');

    // with both codes the email moves
    later(61);
    await service.start('+2348022222222', owner.attempt, IP);
    await flush();
    const out = await service.confirm(
      '+2348022222222',
      owner.attempt,
      sms.lastCode(),
      emailCodeSent(),
      IP,
    );
    expect(out.user).toMatchObject({
      email: 'owner@example.test',
      phone: '+2348022222222',
    });
    expect(squatter.email).toBeNull();
    expect(squatter.phone).toBe('+2349011111111');
    expect(squatter.phoneVerifiedAt).not.toBeNull();
    expect(squatter.passwordHash).not.toBeNull();
  });

  it('never gives a claimant a session on an existing account', async () => {
    const victim = await provenMobile('victim@example.test', '08022222222');
    const claimant = await begin({
      email: 'victim@example.test',
      phone: '09011111111',
    });
    later(61);
    await service.start('+2349011111111', claimant.attempt, IP);
    await flush();
    const out = await service.confirm(
      '+2349011111111',
      claimant.attempt,
      sms.lastCode(),
      emailCodeSent(),
      IP,
    );
    expect(sessionFor).toHaveBeenCalledTimes(2);
    expect((out.user as unknown as Row).id).not.toBe(victim.id);
    expect((out.user as unknown as Row).phone).toBe('+2349011111111');
  });

  // ── F-5: parallel requests ─────────────────────────────────────────────────

  it('answers parallel identical sign-ups with one account and no server error', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => service.signup(signup, IP)),
    );
    const statuses = results.map((r) =>
      r.status === 'fulfilled' ? 201 : (r.reason as HttpException).getStatus(),
    );
    expect(statuses.every((s) => s === 201 || s === 409 || s === 429)).toBe(
      true,
    );
    expect(statuses).toContain(201);
    expect(prisma.users).toHaveLength(1);
  });

  it('turns a unique-key clash into 409, not 500', async () => {
    prisma.users.push(legacy({ email: 'x@example.test', phone: PHONE }));
    const find = prisma.wawuUser.findMany;
    prisma.wawuUser.findMany = () => Promise.resolve([]);
    const body = await failure(service.signup(signup, IP));
    prisma.wawuUser.findMany = find;
    expect(body.statusCode).toBe(409);
  });

  it('gives one session for two confirms with the same code, and tells the other', async () => {
    const { attempt, code } = await begin();
    const results = await Promise.allSettled([
      confirm(attempt, code),
      confirm(attempt, code),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(sessionFor).toHaveBeenCalledTimes(1);
    const other = results.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect([400, 409]).toContain((other.reason as HttpException).getStatus());
  });

  // ── F-9 and U-1: limits on texts ───────────────────────────────────────────

  it('limits sign-ups and resends from one client address', async () => {
    build({ SMS_LIMIT_IP_PER_HOUR: '3' });
    for (let i = 0; i < 3; i++) {
      await begin({ email: `a${i}@example.test`, phone: `0803000000${i}` });
    }
    const body = await failure(
      service.signup(
        { ...signup, email: 'a9@example.test', phone: '08030000009' },
        IP,
      ),
    );
    expect(body).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(sms.sent).toHaveLength(3);
    await begin(
      { email: 'b@example.test', phone: '08030000010' },
      '203.0.113.99',
    );
    expect(sms.sent).toHaveLength(4);
    later(3601);
    await begin({ email: 'c@example.test', phone: '08030000011' });
  });

  it('gives each client address a daily share of the budget', async () => {
    build({ SMS_LIMIT_IP_PER_DAY: '2' });
    await begin({ email: 'a@example.test', phone: '08030000001' });
    later(3601);
    await begin({ email: 'b@example.test', phone: '08030000002' });
    later(3601);
    const body = await failure(
      service.signup(
        { ...signup, email: 'c@example.test', phone: '08030000003' },
        IP,
      ),
    );
    expect(body).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
    expect(body.retryAfterSeconds).toBeGreaterThan(3600);
  });

  it('limits how many texts one number can be sent in a day', async () => {
    build({ SMS_LIMIT_PHONE_PER_DAY: '3' });
    const { attempt } = await begin();
    for (let i = 0; i < 2; i++) {
      later(61);
      await service.start(PHONE, attempt, IP);
      await flush();
    }
    later(61);
    const body = await failure(service.start(PHONE, attempt, IP));
    expect(body).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
    expect(sms.sent).toHaveLength(3);
    later(24 * 3600);
    await service.start(PHONE, attempt, IP).catch(() => undefined);
  });

  it('never sends more texts than the daily budget, even for parallel sign-ups', async () => {
    build({
      SMS_LIMIT_GLOBAL_PER_DAY: '5',
      SMS_LIMIT_IP_PER_HOUR: '1000',
      SMS_LIMIT_IP_PER_DAY: '1000',
    });
    const results = await Promise.allSettled(
      Array.from({ length: 24 }, (_, i) =>
        service.signup(
          {
            ...signup,
            email: `p${i}@example.test`,
            phone: `0803100${String(1000 + i)}`,
          },
          `10.0.0.${i}`,
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect(sms.sent).toHaveLength(5);
    expect(prisma.users).toHaveLength(5);
    const refused = results.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect((refused.reason as HttpException).getResponse()).toMatchObject({
      statusCode: 429,
      code: 'RATE_LIMITED',
    });
  });

  it('gives a reserved text back when the provider refuses it', async () => {
    build({ SMS_LIMIT_GLOBAL_PER_DAY: '1' });
    sms.failNext = true;
    await failure(service.signup(signup, IP));
    await begin({ email: 'b@example.test', phone: '08030000002' });
    expect(sms.sent).toHaveLength(1);
  });

  it('limits code checks from one client address', async () => {
    build({ CONFIRM_LIMIT_IP_PER_HOUR: '2' });
    for (const phone of ['+2348030000001', '+2348030000002']) {
      await failure(confirm('x', '123456', phone));
    }
    const body = await failure(confirm('x', '123456', '+2348030000003'));
    expect(body).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
  });
});
