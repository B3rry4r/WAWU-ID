import { HttpException, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  fakePrisma,
  type Row,
  type UserRow,
} from '../testing/fake-signup-prisma';
import { MemoryRateLimiter } from '../testing/memory-rate-limiter';
import { RecordingMail } from '../testing/recording-mail';
import { AuthService } from './auth.service';
import { EmailSignupService } from './email-signup.service';

/** argon2 is slow on a busy machine; these specs hash a lot. */
jest.setTimeout(120_000);

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

describe('EmailSignupService (AUTH-07: the sign-up code is mailed)', () => {
  let prisma: ReturnType<typeof fakePrisma>;
  let mail: RecordingMail;
  let service: EmailSignupService;
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
    SMS_LIMIT_IP_PER_DAY: '100',
    SMS_LIMIT_PHONE_PER_DAY: '5',
    SMS_LIMIT_GLOBAL_PER_DAY: '2000',
    CONFIRM_LIMIT_IP_PER_HOUR: '120',
    SIGNUP_EMAIL_CODE_TTL_SECONDS: '600',
  };

  const IP = '203.0.113.7';
  const PHONE = '+2348031234412';
  const signup = {
    email: 'Ada@Example.test',
    phone: '0803 123 4412',
    password: 'a-long-password',
  };

  const wrongCode = (real: string) => (real === '000000' ? '111111' : '000000');
  /** The code for a resend is mailed in the background; let it go out. */
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
    mail = new RecordingMail();
    sessionFor.mockClear();
    service = new EmailSignupService(
      prisma as never,
      { sessionFor } as unknown as AuthService,
      { get: (name: string) => ({ ...baseEnv, ...env })[name] } as never,
      new MemoryRateLimiter(),
      mail as never,
    );
  }

  /** Sign up and return what the person holds: the secret and the code just mailed. */
  async function begin(over: Partial<typeof signup> = {}, ip = IP) {
    const out = await service.signup({ ...signup, ...over }, ip);
    return { out, attempt: out.attempt, code: mail.lastCode() };
  }

  const confirm = (attempt: string, code: string, phone = PHONE, ip = IP) =>
    service.confirm(phone, attempt, code, ip);

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

  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: [...DATE_ONLY],
      now: new Date('2026-10-06T10:00:00Z'),
    });
    build();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ── the basics ──────────────────────────────────────────────────────────────

  it('creates the account with the phone stored normalised, mails the code, returns the secret and the masked address, and issues no session', async () => {
    const out = await service.signup(
      { ...signup, occupation: ' Photographer ', accountType: 'creator' },
      IP,
    );

    expect(out).toMatchObject({
      phone: PHONE,
      expiresIn: 600,
      resendIn: 60,
      emailCodeRequired: false,
      channel: 'email',
      maskedEmail: 'a•••@example.test',
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
    expect(prisma.codes()[0]).toMatchObject({ channel: 'email' });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({
      to: 'ada@example.test',
      purpose: 'verify your email address',
      strict: true,
    });
    expect(mail.lastCode()).toMatch(/^\d{6}$/);
    expect(sessionFor).not.toHaveBeenCalled();
    const stored = JSON.stringify(prisma.codes());
    expect(stored).not.toContain(mail.lastCode());
    expect(stored).not.toContain(out.attempt);
    expect(stored).toContain(
      createHash('sha256').update(out.attempt).digest('hex'),
    );
  });

  it('never writes a code or the secret to a log, not even when the mail fails', async () => {
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
      (level) => jest.spyOn(Logger.prototype, level).mockImplementation(),
    );
    const { attempt, code } = await begin();
    await failure(confirm(attempt, wrongCode(code)));
    later(61);
    await service.start(PHONE, attempt, IP);
    await flush();
    const second = mail.lastCode();
    await confirm(attempt, second);

    // a mail that fails in the background, and one that fails at sign-up
    const other = await begin({
      email: 'b@example.test',
      phone: '08031230099',
    });
    later(61);
    mail.failNext = true;
    await service.start('+2348031230099', other.attempt, IP);
    await flush();
    mail.failNext = true;
    await failure(
      service.signup(
        { ...signup, email: 'c@example.test', phone: '08031230098' },
        IP,
      ),
    );

    expect(spies.flatMap((s) => s.mock.calls).length).toBeGreaterThan(0);
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const secret of [code, second, attempt, other.code, other.attempt]) {
      expect(logged).not.toContain(secret);
    }
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

  it('proves the EMAIL (not the phone) with the right code and secret, once, then issues the session', async () => {
    const { attempt, code } = await begin();
    const out = await confirm(attempt, code, '08031234412');

    expect(out.accessToken).toBe('a');
    expect(sessionFor).toHaveBeenCalledTimes(1);
    const user = prisma.users[0];
    expect(user.emailVerified).toBe(true);
    // The number was never proven: nothing may treat it as confirmed.
    expect(user.phoneVerifiedAt).toBeNull();
    // In the sign-up sequence from now on, and nothing is pending.
    expect(prisma.progress).toEqual([user.id]);
    expect(prisma.codes()).toHaveLength(0);

    const again = await failure(confirm(attempt, code));
    expect(again.code).toBe('EMAIL_CODE_INVALID');
    expect(sessionFor).toHaveBeenCalledTimes(1);
  });

  it('does not accept the code for another phone or another secret', async () => {
    const a = await begin();
    const wrongPhone = await failure(
      confirm(a.attempt, a.code, '+2348077777777'),
    );
    expect(wrongPhone.code).toBe('EMAIL_CODE_INVALID');
    const wrongSecret = await failure(confirm('not-the-secret', a.code));
    expect(wrongSecret.code).toBe('EMAIL_CODE_INVALID');
    expect(sessionFor).not.toHaveBeenCalled();
  });

  it('refuses a number that is not Nigerian, or not a number, before anything is written or mailed', async () => {
    const abroad = await failure(
      service.signup({ ...signup, phone: '+14155552671' }, IP),
    );
    expect(abroad.code).toBe('PHONE_NOT_SUPPORTED');
    const junk = await failure(
      service.signup({ ...signup, phone: 'not a phone' }, IP),
    );
    expect(junk.code).toBe('PHONE_INVALID');
    expect(prisma.users).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  // ── the code's life ─────────────────────────────────────────────────────────

  it('lives as long as the mail says (10 minutes)', async () => {
    const { attempt, code } = await begin();
    later(599);
    // still live: a wrong guess, then the right one
    await failure(confirm(attempt, wrongCode(code)));
    const out = await confirm(attempt, code);
    expect(out.accessToken).toBe('a');
  });

  it('refuses the code after 10 minutes, as a wrong code', async () => {
    const { attempt, code } = await begin();
    later(601);
    const body = await failure(confirm(attempt, code));
    expect(body.code).toBe('EMAIL_CODE_INVALID');
    expect(sessionFor).not.toHaveBeenCalled();
  });

  // ── wrong codes (A15) and the wait: the phone code's rules ──────────────────

  it('answers a wrong code as A15 does, three times, and the right code still works', async () => {
    const { attempt, code } = await begin();
    for (let i = 0; i < 3; i++) {
      const body = await failure(confirm(attempt, wrongCode(code)));
      expect(body).toEqual({
        statusCode: 400,
        code: 'EMAIL_CODE_INVALID',
        message: "That code isn't right",
      });
    }
    const out = await confirm(attempt, code);
    expect(out.accessToken).toBe('a');
  });

  it('makes the user wait after the fourth wrong code, even for the right one', async () => {
    const { attempt, code } = await begin();
    for (let i = 0; i < 3; i++)
      await failure(confirm(attempt, wrongCode(code)));
    const fourth = await failure(confirm(attempt, wrongCode(code)));
    expect(fourth).toMatchObject({
      statusCode: 429,
      code: 'EMAIL_CODE_LOCKED',
      retryAfterSeconds: 900,
    });
    const right = await failure(confirm(attempt, code));
    expect(right.code).toBe('EMAIL_CODE_LOCKED');
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
    expect(mail.sent).toHaveLength(2);
    const out = await confirm(first.attempt, mail.lastCode());
    expect(out.accessToken).toBe('a');
  });

  it('does not hand the wrong-code budget back when a fresh code is mailed', async () => {
    const { attempt } = await begin();
    for (let round = 0; round < 2; round++) {
      later(61);
      await failure(confirm(attempt, wrongCode(mail.lastCode())));
      await failure(confirm(attempt, wrongCode(mail.lastCode())));
      await service.start(PHONE, attempt, IP).catch(() => undefined);
      await flush();
    }
    const body = await failure(confirm(attempt, wrongCode(mail.lastCode())));
    expect(body).toMatchObject({ statusCode: 429, code: 'EMAIL_CODE_LOCKED' });
  });

  it('caps wrong codes per day however often the wait ends', async () => {
    build({ PENDING_SIGNUP_TTL_SECONDS: '172800' });
    const { attempt } = await begin();
    for (let round = 0; round < 8; round++) {
      later(901);
      for (let i = 0; i < 4; i++) {
        await failure(confirm(attempt, wrongCode(mail.lastCode())));
      }
    }
    const right = await failure(confirm(attempt, mail.lastCode()));
    expect(right.code).toBe('EMAIL_CODE_LOCKED');
    expect(right.retryAfterSeconds).toBeGreaterThan(900);
    expect(prisma.users[0].emailVerified).toBe(false);

    later(24 * 3600);
    await service.start(PHONE, attempt, IP);
    await flush();
    const out = await confirm(attempt, mail.lastCode());
    expect(out.accessToken).toBe('a');
  });

  it('gives one session for two confirms with the same code, and tells the other', async () => {
    const { attempt, code } = await begin();
    const results = await Promise.allSettled([
      confirm(attempt, code),
      confirm(attempt, code),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(sessionFor).toHaveBeenCalledTimes(1);
    const refused = results.find((r) => r.status === 'rejected');
    const body = (
      (refused as PromiseRejectedResult).reason as HttpException
    ).getResponse() as Row;
    expect(['EMAIL_ALREADY_CONFIRMED', 'EMAIL_CODE_INVALID']).toContain(
      body.code,
    );
  });

  // ── resend: the phone code's timing and limits ──────────────────────────────

  it('makes the user wait 60 seconds between mails, then mails a new code and kills the old one', async () => {
    const first = await begin();
    const early = await failure(service.start(PHONE, first.attempt, IP));
    expect(early).toMatchObject({
      statusCode: 429,
      code: 'EMAIL_CODE_RESEND_TOO_SOON',
    });
    expect(early.retryAfterSeconds).toBeGreaterThan(0);
    expect(early.retryAfterSeconds).toBeLessThanOrEqual(60);

    later(61);
    const out = await service.start(PHONE, first.attempt, IP);
    await flush();
    expect(out).toEqual({
      phone: PHONE,
      expiresIn: 600,
      resendIn: 60,
      channel: 'email',
    });
    expect(mail.sent).toHaveLength(2);
    expect(mail.sent[1].strict).toBe(true);
    const fresh = mail.lastCode();
    if (fresh !== first.code) {
      const stale = await failure(confirm(first.attempt, first.code));
      expect(stale.code).toBe('EMAIL_CODE_INVALID');
    }
    expect((await confirm(first.attempt, fresh)).accessToken).toBe('a');
  });

  it('makes a second sign-up for the same email inside the 60 seconds wait', async () => {
    await begin();
    const body = await failure(
      service.signup({ ...signup, password: 'another-long-one' }, IP),
    );
    expect(body).toMatchObject({
      statusCode: 429,
      code: 'EMAIL_CODE_RESEND_TOO_SOON',
    });
    expect(mail.sent).toHaveLength(1);
  });

  it('limits how many mails one email can be sent in a day (5)', async () => {
    const { attempt } = await begin();
    for (let i = 0; i < 4; i++) {
      later(61);
      await service.start(PHONE, attempt, IP);
      await flush();
    }
    expect(mail.sent).toHaveLength(5);
    later(61);
    const body = await failure(service.start(PHONE, attempt, IP));
    expect(body).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
    expect(mail.sent).toHaveLength(5);
  });

  it('limits sign-ups and resends from one client address (30 an hour)', async () => {
    for (let i = 0; i < 30; i++) {
      await service.start(`+23480312${String(10000 + i)}`, 'x', IP);
    }
    const body = await failure(service.start(PHONE, 'x', IP));
    expect(body).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
    // another address is not affected
    await service.start(PHONE, 'x', '198.51.100.9');
    expect(mail.sent).toHaveLength(0);
  });

  it('gives each client address a daily share of the budget (100)', async () => {
    build({ SMS_LIMIT_IP_PER_HOUR: '1000' });
    for (let i = 0; i < 100; i++) {
      await service.start(`+23480312${String(10000 + i)}`, 'x', IP);
    }
    const body = await failure(service.start(PHONE, 'x', IP));
    expect(body).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
  });

  it('stops everyone once the whole service has mailed its daily budget', async () => {
    build({ SMS_LIMIT_GLOBAL_PER_DAY: '2' });
    await begin({ email: 'one@example.test', phone: '08031230001' });
    await begin(
      { email: 'two@example.test', phone: '08031230002' },
      '198.51.100.1',
    );
    const body = await failure(
      service.signup(
        { ...signup, email: 'three@example.test', phone: '08031230003' },
        '198.51.100.2',
      ),
    );
    expect(body).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
    expect(mail.sent).toHaveLength(2);
  });

  it('answers start the same for a pending sign-up, an existing account, an unknown number and a wrong secret, and mails only the real one', async () => {
    const { attempt } = await begin();
    prisma.users.push(legacy());
    later(61);
    const shapes = await Promise.all([
      service.start(PHONE, attempt, IP),
      service.start(PHONE, 'not-the-secret', IP),
      service.start('+2348099900011', 'any', IP),
      service.start('+2348055555555', 'any', IP),
    ]);
    await flush();
    for (const s of shapes) {
      expect(s).toEqual({ ...shapes[0], phone: s.phone });
      expect(Object.keys(s).sort()).toEqual([
        'channel',
        'expiresIn',
        'phone',
        'resendIn',
      ]);
    }
    expect(mail.sent).toHaveLength(2);
  });

  it('never mails an existing account that did not come from sign-up', async () => {
    prisma.users.push(legacy());
    for (const phone of ['+2348099900011', '08099900011']) {
      await service.start(phone, 'any-secret', IP);
      later(61);
    }
    expect(mail.sent).toHaveLength(0);
  });

  it('never gives a session to an existing account, whatever code and secret are sent', async () => {
    prisma.users.push(legacy());
    for (let i = 0; i < 3; i++) {
      const body = await failure(
        confirm('any-secret', '123456', '+2348099900011'),
      );
      expect(body.code).toBe('EMAIL_CODE_INVALID');
    }
    expect(sessionFor).not.toHaveBeenCalled();
    expect(prisma.users[0].emailVerified).toBe(true);
    expect(prisma.progress).toHaveLength(0);
  });

  it('never mails or confirms a sign-up that is already proven', async () => {
    const { attempt, code } = await begin();
    await confirm(attempt, code);
    later(61);
    sessionFor.mockClear();
    await service.start(PHONE, attempt, IP);
    await flush();
    expect(mail.sent).toHaveLength(1);
    const body = await failure(confirm(attempt, '123456'));
    expect(body.code).toBe('EMAIL_CODE_INVALID');
    expect(sessionFor).not.toHaveBeenCalled();
  });

  // ── who may take an email or a phone ───────────────────────────────────────

  it('lets a newer sign-up take over an unproven one, which is then gone', async () => {
    const first = await begin();
    later(61);
    const second = await begin({ password: 'another-long-one' });
    expect(prisma.users).toHaveLength(1);
    const stale = await failure(confirm(first.attempt, first.code));
    expect(stale.code).toBe('EMAIL_CODE_INVALID');
    expect((await confirm(second.attempt, second.code)).accessToken).toBe('a');
  });

  it('answers 409 for an email or phone an account already holds, and mails nothing', async () => {
    prisma.users.push(legacy());
    const byEmail = await failure(
      service.signup({ ...signup, email: 'old@example.test' }, IP),
    );
    expect(byEmail.statusCode).toBe(409);
    const byPhone = await failure(
      service.signup({ ...signup, phone: '08099900011' }, IP),
    );
    expect(byPhone.statusCode).toBe(409);
    expect(mail.sent).toHaveLength(0);
    expect(prisma.users).toHaveLength(1);
  });

  it('gives the email to the person who proves the mailbox, and keeps the other account signing in by phone', async () => {
    // A mobile account of the texted kind: phone proven, email not.
    prisma.users.push(
      legacy({
        id: 'holder',
        email: 'ada@example.test',
        phone: '+2348077700022',
        emailVerified: false,
        phoneVerifiedAt: new Date(),
      }),
    );
    const { out, attempt, code } = await begin();
    expect(out.maskedEmail).toBe('a•••@example.test');
    // Until the code is entered, the newcomer has no email and the holder keeps it.
    const holder = () => prisma.users.find((u) => u.id === 'holder') as UserRow;
    expect(holder().email).toBe('ada@example.test');
    expect(prisma.users[1].email).toBeNull();
    // One code only: the code mailed is the proof.
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe('ada@example.test');

    await confirm(attempt, code);
    expect(holder().email).toBeNull();
    expect(holder().phone).toBe('+2348077700022');
    expect(prisma.users[1]).toMatchObject({
      email: 'ada@example.test',
      emailVerified: true,
    });
  });

  // ── delivery ────────────────────────────────────────────────────────────────

  it('answers 503 EMAIL_NOT_CONFIGURED when there is no mail transport, and writes and spends nothing', async () => {
    mail.configured = false;
    const body = await failure(service.signup(signup, IP));
    expect(body).toMatchObject({
      statusCode: 503,
      code: 'EMAIL_NOT_CONFIGURED',
    });
    expect(prisma.users).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
    const resend = await failure(service.start(PHONE, 'x', IP));
    expect(resend.code).toBe('EMAIL_NOT_CONFIGURED');
  });

  it('gives a reserved mail back when the mailer refuses it, so the person may ask again at once', async () => {
    mail.failNext = true;
    const body = await failure(service.signup(signup, IP));
    expect(body).toMatchObject({ statusCode: 503, code: 'EMAIL_SEND_FAILED' });
    expect(mail.sent).toHaveLength(0);
    // Nothing was delivered, so nothing is held against the person: no wait.
    const { attempt, code } = await begin();
    expect((await confirm(attempt, code)).accessToken).toBe('a');
  });

  // ── resume ──────────────────────────────────────────────────────────────────

  it('tells an app that was closed where the sign-up stands, with the masked address and the time left', async () => {
    const { attempt } = await begin();
    later(20);
    const out = await service.resume('08031234412', attempt, IP);
    expect(out).toEqual({
      step: 'phone',
      phone: PHONE,
      expiresIn: 580,
      resendIn: 40,
      emailCodeRequired: false,
      accountType: null,
      channel: 'email',
      maskedEmail: 'a•••@example.test',
    });
    expect(mail.sent).toHaveLength(1);
  });

  it('answers `details` for a made-up secret, a confirmed sign-up and a texted one', async () => {
    const { attempt, code } = await begin();
    expect(await service.resume(PHONE, 'made-up', IP)).toEqual({
      step: 'details',
    });
    // a sign-up whose code was TEXTED (channel null) is not this service's to resume
    prisma.codes()[0].channel = null;
    expect(await service.resume(PHONE, attempt, IP)).toEqual({
      step: 'details',
    });
    prisma.codes()[0].channel = 'email';
    await confirm(attempt, code);
    expect(await service.resume(PHONE, attempt, IP)).toEqual({
      step: 'details',
    });
  });

  it('never acts on a sign-up whose code was texted', async () => {
    const { attempt, code } = await begin();
    prisma.codes()[0].channel = null;
    const body = await failure(confirm(attempt, code));
    expect(body.code).toBe('EMAIL_CODE_INVALID');
    expect(sessionFor).not.toHaveBeenCalled();
    later(61);
    await service.start(PHONE, attempt, IP);
    await flush();
    expect(mail.sent).toHaveLength(1);
    expect(prisma.codes()).toHaveLength(1);
  });
});
