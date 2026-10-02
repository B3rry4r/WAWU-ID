import { HttpException } from '@nestjs/common';
import { MemoryRateLimiter } from '../testing/memory-rate-limiter';
import { RecordingSmsProvider } from '../testing/recording-sms.provider';
import { AuthService } from './auth.service';
import { PhoneSignupService, type PhoneCodeSent } from './phone-signup.service';

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

/** A Prisma `where` over plain rows: equality, `in`, and `OR`. */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'OR') return (want as Where[]).some((w) => matches(row, w));
    const have = row[key];
    if (want && typeof want === 'object' && 'in' in want) {
      return (want.in as unknown[]).includes(have);
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
        Object.assign(row, data);
        return Promise.resolve(row);
      },
      deleteMany: ({ where }: { where: { id: string } }) => {
        const at = users.findIndex((u) => u.id === where.id);
        if (at >= 0) users.splice(at, 1);
        return Promise.resolve({ count: at >= 0 ? 1 : 0 });
      },
    },
    phoneVerification: {
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

  const baseEnv: Record<string, string> = {
    PHONE_CODE_TTL_SECONDS: '300',
    PHONE_CODE_MAX_WRONG: '4',
    PHONE_CODE_LOCKOUT_SECONDS: '900',
    PHONE_CODE_RESEND_SECONDS: '60',
    PHONE_CODE_DAILY_WRONG_CAP: '12',
    PENDING_SIGNUP_TTL_SECONDS: '86400',
    SMS_LIMIT_IP_PER_HOUR: '30',
    SMS_LIMIT_PHONE_PER_DAY: '5',
    SMS_LIMIT_GLOBAL_PER_DAY: '2000',
    CONFIRM_LIMIT_IP_PER_HOUR: '120',
  };

  const IP = '203.0.113.7';
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
    service = new PhoneSignupService(
      prisma as never,
      { sessionFor } as unknown as AuthService,
      { get: (name: string) => ({ ...baseEnv, ...env })[name] } as never,
      sms,
      new MemoryRateLimiter(),
    );
  }

  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: [...DATE_ONLY],
      now: new Date('2026-10-02T10:00:00Z'),
    });
    build();
  });
  afterEach(() => jest.useRealTimers());

  // ── the basics ──────────────────────────────────────────────────────────────

  it('creates the account with the phone stored normalised, texts the code, and issues no session', async () => {
    const out = await service.signup(
      { ...signup, occupation: ' Photographer ', accountType: 'creator' },
      IP,
    );

    expect(out).toEqual({
      phone: '+2348031234412',
      expiresIn: 300,
      resendIn: 60,
    });
    expect(prisma.users).toHaveLength(1);
    expect(prisma.users[0]).toMatchObject({
      email: 'ada@example.test',
      phone: '+2348031234412',
      occupation: 'Photographer',
      accountType: 'creator',
      emailVerified: false,
      phoneVerifiedAt: null,
    });
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0].to).toBe('+2348031234412');
    expect(sessionFor).not.toHaveBeenCalled();
    expect(JSON.stringify(prisma.codes())).not.toContain(sms.lastCode());
  });

  it('proves the phone with the right code, once, and then issues the session', async () => {
    await service.signup(signup, IP);
    const out = await service.confirm('+2348031234412', sms.lastCode(), IP);

    expect(out.accessToken).toBe('a');
    expect(prisma.users[0].phoneVerifiedAt).toBeInstanceOf(Date);
    expect(prisma.users[0].phoneVerification).toBeNull();
    expect(sessionFor).toHaveBeenCalledTimes(1);
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
      const again = await failure(service.start(phone, IP));
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
      const out = await service.start(phone, IP);
      expect(out.phone).toBe('+2348099900011');
      later(61);
    }
    expect(sms.sent).toHaveLength(0);
  });

  it('never gives a session to an existing account, whatever code is sent', async () => {
    prisma.users.push(legacy());
    for (let i = 0; i < 3; i++) {
      const body = await failure(
        service.confirm('+2348099900011', '123456', IP),
      );
      expect(body.code).toBe('PHONE_CODE_INVALID');
    }
    expect(sessionFor).not.toHaveBeenCalled();
    expect(prisma.users[0].phoneVerifiedAt).toBeNull();
  });

  it('never texts or confirms an account whose phone is already proven', async () => {
    await service.signup(signup, IP);
    await service.confirm('+2348031234412', sms.lastCode(), IP);
    later(61);
    sessionFor.mockClear();
    await service.start('+2348031234412', IP);
    expect(sms.sent).toHaveLength(1);
    const body = await failure(service.confirm('+2348031234412', '123456', IP));
    expect(body.code).toBe('PHONE_CODE_INVALID');
    expect(sessionFor).not.toHaveBeenCalled();
  });

  it('does not treat a legacy account with the same phone as pending', async () => {
    // A web row holding the number as typed, next to nothing from sign-up.
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
    await service.signup(signup, IP);
    const code = sms.lastCode();
    for (let i = 0; i < 3; i++) {
      const body = await failure(
        service.confirm('08031234412', wrongCode(code), IP),
      );
      expect(body).toEqual({
        statusCode: 400,
        code: 'PHONE_CODE_INVALID',
        message: "That code isn't right",
      });
    }
    const out = await service.confirm('08031234412', code, IP);
    expect(out.accessToken).toBe('a');
  });

  it('makes the user wait after the fourth wrong code, even for the right one', async () => {
    await service.signup(signup, IP);
    const code = sms.lastCode();
    for (let i = 0; i < 3; i++) {
      await failure(service.confirm('+2348031234412', wrongCode(code), IP));
    }
    const fourth = await failure(
      service.confirm('+2348031234412', wrongCode(code), IP),
    );
    expect(fourth).toMatchObject({
      statusCode: 429,
      code: 'PHONE_CODE_LOCKED',
      retryAfterSeconds: 900,
    });
    const right = await failure(service.confirm('+2348031234412', code, IP));
    expect(right.code).toBe('PHONE_CODE_LOCKED');
    expect(sessionFor).not.toHaveBeenCalled();
  });

  it('lets the user try again after the wait, with a new code', async () => {
    await service.signup(signup, IP);
    const first = sms.lastCode();
    for (let i = 0; i < 4; i++) {
      await failure(service.confirm('+2348031234412', wrongCode(first), IP));
    }
    later(901);
    await service.start('+2348031234412', IP);
    await flush();
    expect(sms.sent).toHaveLength(2);
    const out = await service.confirm('+2348031234412', sms.lastCode(), IP);
    expect(out.accessToken).toBe('a');
  });

  // ── F-2: a resend gives no guesses back ─────────────────────────────────────

  it('does not hand the wrong-code budget back when a fresh code is sent', async () => {
    await service.signup(signup, IP);
    for (let round = 0; round < 3; round++) {
      later(61);
      const code = sms.lastCode();
      // two wrong guesses per code, then a resend: 6 guesses in all
      await failure(service.confirm('+2348031234412', wrongCode(code), IP));
      const second = await failure(
        service.confirm('+2348031234412', wrongCode(code), IP),
      );
      expect(second.statusCode === 400 || second.statusCode === 429).toBe(true);
      await service.start('+2348031234412', IP).catch(() => undefined);
    }
    // 4 wrong in a row, across resends, have started the wait
    const body = await failure(
      service.confirm('+2348031234412', wrongCode(sms.lastCode()), IP),
    );
    expect(body).toMatchObject({ statusCode: 429, code: 'PHONE_CODE_LOCKED' });
  });

  it('caps wrong codes per day however often the wait ends', async () => {
    build({ PENDING_SIGNUP_TTL_SECONDS: '172800' });
    await service.signup(signup, IP);
    let wrong = 0;
    for (let round = 0; round < 8; round++) {
      later(901);
      const code = sms.lastCode();
      for (let i = 0; i < 4; i++) {
        const body = await failure(
          service.confirm('+2348031234412', wrongCode(code), IP),
        );
        if (body.code === 'PHONE_CODE_INVALID' || wrong < 12) wrong += 1;
      }
    }
    // The day is not over (8 x 901 s is 2 h): the cap answers "wait", and the
    // right code is refused as well.
    const right = await failure(
      service.confirm('+2348031234412', sms.lastCode(), IP),
    );
    expect(right.code).toBe('PHONE_CODE_LOCKED');
    expect(right.retryAfterSeconds).toBeGreaterThan(900);
    expect(prisma.users[0].phoneVerifiedAt).toBeNull();

    // After the day the number starts clean.
    later(24 * 3600);
    await service.start('+2348031234412', IP);
    await flush();
    const out = await service.confirm('+2348031234412', sms.lastCode(), IP);
    expect(out.accessToken).toBe('a');
  });

  it('holds a number back for at most the day when a stranger burns its guesses', async () => {
    build({ PENDING_SIGNUP_TTL_SECONDS: '172800' });
    await service.signup(signup, IP);
    for (let round = 0; round < 4; round++) {
      later(901);
      for (let i = 0; i < 4; i++) {
        await failure(
          service.confirm('+2348031234412', '000000', '198.51.100.9'),
        );
      }
    }
    const held = await failure(
      service.confirm('+2348031234412', sms.lastCode(), IP),
    );
    expect(held.retryAfterSeconds).toBeLessThanOrEqual(24 * 3600);
    later(24 * 3600 + 1);
    await service.start('+2348031234412', IP);
    await flush();
    const out = await service.confirm('+2348031234412', sms.lastCode(), IP);
    expect(out.accessToken).toBe('a');
  });

  // ── F-3: the same answer for every kind of number ──────────────────────────

  it('answers start the same for a pending, an existing and an unknown number', async () => {
    prisma.users.push(legacy());
    await service.signup(signup, IP);
    later(61);
    const answers: PhoneCodeSent[] = [];
    for (const phone of [
      '+2348031234412',
      '+2348099900011',
      '+2348055555555',
    ]) {
      answers.push(await service.start(phone, IP));
    }
    expect(answers.map((a) => [a.expiresIn, a.resendIn])).toEqual([
      [300, 60],
      [300, 60],
      [300, 60],
    ]);
    // Asking again at once is held back for all three alike.
    for (const phone of [
      '+2348031234412',
      '+2348099900011',
      '+2348055555555',
    ]) {
      const body = await failure(service.start(phone, IP));
      expect(body).toMatchObject({
        statusCode: 429,
        code: 'PHONE_CODE_RESEND_TOO_SOON',
      });
    }
  });

  it('runs a number nobody registered out of guesses exactly as a pending one', async () => {
    const outcomes: Record<string, string[]> = {};
    await service.signup(signup, IP);
    for (const phone of ['+2348031234412', '+2348055555555']) {
      outcomes[phone] = [];
      for (let i = 0; i < 6; i++) {
        const body = await failure(
          service.confirm(phone, wrongCode(sms.lastCode()), IP),
        );
        outcomes[phone].push(`${String(body.statusCode)}:${String(body.code)}`);
      }
    }
    expect(outcomes['+2348055555555']).toEqual(outcomes['+2348031234412']);
    expect(outcomes['+2348055555555'].slice(3)).toEqual(
      Array(3).fill('429:PHONE_CODE_LOCKED'),
    );
  });

  it('refuses an expired code without telling it apart from a wrong one', async () => {
    await service.signup(signup, IP);
    const code = sms.lastCode();
    later(301);
    const body = await failure(service.confirm('+2348031234412', code, IP));
    expect(body.code).toBe('PHONE_CODE_INVALID');
  });

  // ── F-4: an unproven sign-up holds nothing ─────────────────────────────────

  it('lets the owner of an email sign up after someone else proved a phone against it', async () => {
    // The attacker signs up with the victim's email and their own phone, and proves the phone.
    await service.signup(
      {
        email: 'victim@example.test',
        phone: '09011111111',
        password: 'attackers-pass',
      },
      IP,
    );
    const attackerSession = await service.confirm(
      '+2349011111111',
      sms.lastCode(),
      IP,
    );
    expect(attackerSession.accessToken).toBe('a');
    later(61);

    // The victim signs up with their own email and phone.
    const out = await service.signup(
      {
        email: 'victim@example.test',
        phone: '08022222222',
        password: 'victims-pass',
      },
      IP,
    );
    expect(out.phone).toBe('+2348022222222');

    const attacker = prisma.users.find(
      (u) => u.phone === '+2349011111111',
    ) as UserRow;
    const victim = prisma.users.find(
      (u) => u.phone === '+2348022222222',
    ) as UserRow;
    expect(attacker.email).toBeNull();
    expect(victim.email).toBe('victim@example.test');
    // The victim's account is the victim's: the attacker's proof is on another row.
    expect(victim.phoneVerifiedAt).toBeNull();
    const victimSession = await service.confirm(
      '+2348022222222',
      sms.lastCode(),
      IP,
    );
    expect(victimSession.user).toMatchObject({ phone: '+2348022222222' });
  });

  it('lets a newer sign-up take over an unproven one, which is then gone', async () => {
    await service.signup(signup, IP);
    const oldCode = sms.lastCode();
    later(61);
    await service.signup({ ...signup, password: 'a-different-password' }, IP);
    expect(prisma.users).toHaveLength(1);
    // the first code is dead: a guess against it is just a wrong code
    const body = await failure(service.confirm('+2348031234412', oldCode, IP));
    expect(
      body.code === 'PHONE_CODE_INVALID' || oldCode === sms.lastCode(),
    ).toBe(true);
  });

  it('lets a stranger take an unproven phone, but never a proven one', async () => {
    await service.signup(signup, IP);
    later(61);
    await service.signup({ ...signup, email: 'thief@example.test' }, IP);
    expect(prisma.users).toHaveLength(1);
    expect(prisma.users[0].email).toBe('thief@example.test');

    await service.confirm('+2348031234412', sms.lastCode(), IP);
    later(61);
    const body = await failure(
      service.signup({ ...signup, email: 'another@example.test' }, IP),
    );
    expect(body.statusCode).toBe(409);
    expect(prisma.users).toHaveLength(1);
  });

  it('never takes the email of an account that proved it', async () => {
    prisma.users.push(legacy({ email: 'real@example.test' }));
    const body = await failure(
      service.signup({ ...signup, email: 'real@example.test' }, IP),
    );
    expect(body.statusCode).toBe(409);
    expect(prisma.users).toHaveLength(1);
    expect(sms.sent).toHaveLength(0);
  });

  it('stops accepting a code once the sign-up has expired', async () => {
    await service.signup(signup, IP);
    later(24 * 3600 + 1);
    const body = await failure(
      service.confirm('+2348031234412', sms.lastCode(), IP),
    );
    expect(body.code).toBe('PHONE_CODE_INVALID');
    await service.start('+2348031234412', IP);
    expect(sms.sent).toHaveLength(1);
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
    prisma.users.push(
      legacy({ email: 'x@example.test', phone: '+2348031234412' }),
    );
    // The clash check misses it (a row appears between the check and the insert):
    // the insert itself reports the clash.
    const find = prisma.wawuUser.findMany;
    prisma.wawuUser.findMany = () => Promise.resolve([]);
    const body = await failure(service.signup(signup, IP));
    prisma.wawuUser.findMany = find;
    expect(body.statusCode).toBe(409);
  });

  it('gives one session for two confirms with the same code, and tells the other', async () => {
    await service.signup(signup, IP);
    const code = sms.lastCode();
    const results = await Promise.allSettled([
      service.confirm('+2348031234412', code, IP),
      service.confirm('+2348031234412', code, IP),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    expect(sessionFor).toHaveBeenCalledTimes(1);
    const other = results.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect([400, 409]).toContain((other.reason as HttpException).getStatus());
  });

  // ── F-9: limits on texts ───────────────────────────────────────────────────

  it('limits sign-ups and resends from one client address', async () => {
    build({ SMS_LIMIT_IP_PER_HOUR: '3' });
    for (let i = 0; i < 3; i++) {
      await service.signup(
        { ...signup, email: `a${i}@example.test`, phone: `0803000000${i}` },
        IP,
      );
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
    // another address is not held back
    await service.signup(
      { ...signup, email: 'b@example.test', phone: '08030000010' },
      '203.0.113.99',
    );
    expect(sms.sent).toHaveLength(4);
    // and the window ends
    later(3601);
    await service.signup(
      { ...signup, email: 'c@example.test', phone: '08030000011' },
      IP,
    );
  });

  it('limits how many times one number can be asked for in a day', async () => {
    build({ SMS_LIMIT_PHONE_PER_DAY: '3' });
    await service.signup(signup, IP);
    for (let i = 0; i < 2; i++) {
      later(61);
      await service.start('+2348031234412', IP);
    }
    later(61);
    const body = await failure(service.start('+2348031234412', IP));
    expect(body).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
    expect(sms.sent).toHaveLength(3);
    later(24 * 3600);
    await service.start('+2348031234412', IP);
  });

  it('stops sending when the daily budget for the whole service is spent', async () => {
    build({ SMS_LIMIT_GLOBAL_PER_DAY: '2' });
    await service.signup(
      { ...signup, email: 'a@example.test', phone: '08030000001' },
      '10.0.0.1',
    );
    await service.signup(
      { ...signup, email: 'b@example.test', phone: '08030000002' },
      '10.0.0.2',
    );
    const body = await failure(
      service.signup(
        { ...signup, email: 'c@example.test', phone: '08030000003' },
        '10.0.0.3',
      ),
    );
    expect(body).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
    expect(prisma.users).toHaveLength(2);
    expect(sms.sent).toHaveLength(2);
    // the same refusal for a number that is not registered
    const unknown = await failure(service.start('+2348077777777', '10.0.0.4'));
    expect(unknown).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
  });

  it('limits code checks from one client address', async () => {
    build({ CONFIRM_LIMIT_IP_PER_HOUR: '2' });
    for (const phone of ['+2348030000001', '+2348030000002']) {
      await failure(service.confirm(phone, '123456', IP));
    }
    const body = await failure(service.confirm('+2348030000003', '123456', IP));
    expect(body).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
  });
});
