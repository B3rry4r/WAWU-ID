import { HttpException, Logger } from '@nestjs/common';
import {
  fakePrisma,
  type Row,
  type UserRow,
} from '../testing/fake-signup-prisma';
import { MemoryRateLimiter } from '../testing/memory-rate-limiter';
import { RecordingMail } from '../testing/recording-mail';
import { RecordingSmsProvider } from '../testing/recording-sms.provider';
import { AuthService } from './auth.service';
import { EmailSignupService } from './email-signup.service';
import { maskEmail } from './mask-email';
import { PhoneSignupService } from './phone-signup.service';
import { SignupChannelService } from './signup-channel.service';
import {
  signupVerifyChannel,
  signupVerifyChannelIsUnrecognised,
} from './signup-channel.config';

jest.setTimeout(120_000);

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

const cfg = (env: Record<string, string | undefined>) =>
  ({ get: (name: string) => env[name] }) as never;

describe('SIGNUP_VERIFY_CHANNEL (the setting)', () => {
  it("is phone by default (today's behaviour), and only a literal email turns the mailed code on", () => {
    expect(signupVerifyChannel(cfg({}))).toBe('phone');
    expect(signupVerifyChannel(cfg({ SIGNUP_VERIFY_CHANNEL: '' }))).toBe(
      'phone',
    );
    expect(signupVerifyChannel(cfg({ SIGNUP_VERIFY_CHANNEL: 'phone' }))).toBe(
      'phone',
    );
    expect(signupVerifyChannel(cfg({ SIGNUP_VERIFY_CHANNEL: 'email' }))).toBe(
      'email',
    );
    expect(signupVerifyChannel(cfg({ SIGNUP_VERIFY_CHANNEL: ' EMAIL ' }))).toBe(
      'email',
    );
  });

  it('still reads `sms`, the name this value had in an earlier build, as phone', () => {
    expect(signupVerifyChannel(cfg({ SIGNUP_VERIFY_CHANNEL: 'sms' }))).toBe(
      'phone',
    );
    expect(signupVerifyChannel(cfg({ SIGNUP_VERIFY_CHANNEL: ' SMS ' }))).toBe(
      'phone',
    );
    expect(
      signupVerifyChannelIsUnrecognised(cfg({ SIGNUP_VERIFY_CHANNEL: 'sms' })),
    ).toBe(false);
  });

  it('treats a typo as phone (a typo must never switch off the sign-up that is live) and says so', () => {
    for (const typo of ['emial', 'e-mail', 'mail', 'true', '1']) {
      const config = cfg({ SIGNUP_VERIFY_CHANNEL: typo });
      expect(signupVerifyChannel(config)).toBe('phone');
      expect(signupVerifyChannelIsUnrecognised(config)).toBe(true);
    }
    expect(signupVerifyChannelIsUnrecognised(cfg({}))).toBe(false);
    expect(
      signupVerifyChannelIsUnrecognised(
        cfg({ SIGNUP_VERIFY_CHANNEL: 'email' }),
      ),
    ).toBe(false);
    expect(
      signupVerifyChannelIsUnrecognised(
        cfg({ SIGNUP_VERIFY_CHANNEL: 'phone' }),
      ),
    ).toBe(false);
  });
});

describe('maskEmail', () => {
  it('keeps the first letter and the domain', () => {
    expect(maskEmail('ada@example.com')).toBe('a•••@example.com');
    expect(maskEmail('n@example.com')).toBe('n•••@example.com');
    expect(maskEmail('first.last+tag@mail.co.ng')).toBe('f•••@mail.co.ng');
  });

  it('never returns the local part, and survives something that is not an address', () => {
    expect(maskEmail('ada@example.com')).not.toContain('da');
    expect(maskEmail('')).toBe('•••');
    expect(maskEmail('no-at-sign')).toBe('•••');
  });
});

describe('SignupChannelService (one setting, both channels)', () => {
  let prisma: ReturnType<typeof fakePrisma>;
  let sms: RecordingSmsProvider;
  let mail: RecordingMail;
  let limits: MemoryRateLimiter;
  const sessionFor = jest.fn((user: Row) =>
    Promise.resolve({ accessToken: 'a', refreshToken: 'r', user }),
  );
  const sendOtpForPhoneFlow = jest.fn<Promise<void>, [string, string, string]>(
    () => Promise.resolve(),
  );

  const IP = '203.0.113.7';
  const PHONE = '+2348031234412';
  const signup = {
    email: 'Ada@Example.test',
    phone: '0803 123 4412',
    password: 'a-long-password',
  };
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

  /** The service for one value of the setting, over the SAME database and counters as before. */
  function serviceFor(channel: string | undefined): SignupChannelService {
    const config = cfg({ SIGNUP_VERIFY_CHANNEL: channel });
    const auth = { sessionFor } as unknown as AuthService;
    const phone = new PhoneSignupService(
      prisma as never,
      auth,
      config,
      sms,
      limits,
      { sendOtpCode: sendOtpForPhoneFlow } as never,
    );
    const email = new EmailSignupService(
      prisma as never,
      auth,
      config,
      limits,
      mail as never,
    );
    return new SignupChannelService(config, phone, email);
  }

  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: [...DATE_ONLY],
      now: new Date('2026-10-06T10:00:00Z'),
    });
    prisma = fakePrisma();
    sms = new RecordingSmsProvider();
    mail = new RecordingMail();
    limits = new MemoryRateLimiter();
    sessionFor.mockClear();
    sendOtpForPhoneFlow.mockClear();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('with the setting at its default (phone: what runs today)', () => {
    it('signs up exactly as before: texts the code, proves the PHONE, mails nothing', async () => {
      const service = serviceFor(undefined);
      expect(service.channel).toBe('phone');
      const out = await service.signup(signup, IP);
      expect(Object.keys(out).sort()).toEqual([
        'attempt',
        'emailCodeRequired',
        'expiresIn',
        'phone',
        'resendIn',
      ]);
      expect(out).toMatchObject({ expiresIn: 300, emailCodeRequired: false });
      expect(sms.sent).toHaveLength(1);
      expect(sms.sent[0].to).toBe(PHONE);
      expect(mail.sent).toHaveLength(0);

      const session = await service.phoneConfirm(
        PHONE,
        out.attempt,
        sms.lastCode(),
        undefined,
        IP,
      );
      expect(session.accessToken).toBe('a');
      expect(prisma.users[0].phoneVerifiedAt).toBeInstanceOf(Date);
      expect(prisma.users[0].emailVerified).toBe(false);
      expect(prisma.progress).toHaveLength(0);
    });

    it('answers the email-code routes 409 SIGNUP_CHANNEL_DISABLED, touching nothing', async () => {
      const service = serviceFor(undefined);
      const out = await service.signup(signup, IP);
      const start = await failure(
        service.emailCodeStart(PHONE, out.attempt, IP),
      );
      expect(start).toEqual({
        statusCode: 409,
        code: 'SIGNUP_CHANNEL_DISABLED',
        message:
          'Sign-up codes are sent by text message right now. Start again to get one.',
      });
      const confirm = await failure(
        service.emailCodeConfirm(PHONE, out.attempt, sms.lastCode(), IP),
      );
      expect(confirm.code).toBe('SIGNUP_CHANNEL_DISABLED');
      expect(mail.sent).toHaveLength(0);
      expect(sessionFor).not.toHaveBeenCalled();
    });

    it('keeps working across a deploy: a sign-up waiting on a text and an older app build see no change', async () => {
      const before = serviceFor(undefined);
      const out = await before.signup(signup, IP);
      const code = sms.lastCode();
      // the new build starts, with no value set for the setting
      const after = serviceFor(undefined);
      expect(await after.resume(PHONE, out.attempt, IP)).toMatchObject({
        step: 'phone',
      });
      // an older app build only knows the phone routes
      const session = await after.phoneConfirm(
        PHONE,
        out.attempt,
        code,
        undefined,
        IP,
      );
      expect(session.accessToken).toBe('a');
      expect(mail.sent).toHaveLength(0);
    });

    it('reads `sms`, an earlier name for this value, the same way', async () => {
      const service = serviceFor('sms');
      expect(service.channel).toBe('phone');
      await service.signup(signup, IP);
      expect(sms.sent).toHaveLength(1);
      expect(mail.sent).toHaveLength(0);
    });

    it('resumes with the old answer: no channel field', async () => {
      const service = serviceFor(undefined);
      const out = await service.signup(signup, IP);
      const answer = await service.resume(PHONE, out.attempt, IP);
      expect(answer).toEqual({
        step: 'phone',
        phone: PHONE,
        expiresIn: 300,
        resendIn: 60,
        emailCodeRequired: false,
        accountType: null,
      });
    });

    it('asks for an email code beside the texted one when an account holds the email unproven, as before', async () => {
      const holder: UserRow = {
        id: 'holder',
        email: 'ada@example.test',
        phone: '+2348077700022',
        emailVerified: false,
        phoneVerifiedAt: new Date(),
        passwordHash: 'x',
        occupation: null,
        accountType: null,
        phoneVerification: null,
      };
      prisma.users.push(holder);
      const service = serviceFor(undefined);
      const out = await service.signup(signup, IP);
      expect(out.emailCodeRequired).toBe(true);
      expect(sendOtpForPhoneFlow).toHaveBeenCalledTimes(1);
    });
  });

  describe('with SIGNUP_VERIFY_CHANNEL=email (the switch, made after the app build and Resend are confirmed)', () => {
    it('signs up by mailing a code, sends no text at all, and signs the person in on the right code', async () => {
      const service = serviceFor('email');
      expect(service.channel).toBe('email');
      const out = await service.signup(signup, IP);
      expect(out).toMatchObject({
        channel: 'email',
        maskedEmail: 'a•••@example.test',
        emailCodeRequired: false,
      });
      expect(mail.sent).toHaveLength(1);
      expect(sms.sent).toHaveLength(0);

      const session = await service.emailCodeConfirm(
        PHONE,
        out.attempt,
        mail.lastCode(),
        IP,
      );
      expect(session.accessToken).toBe('a');
      expect(sms.sent).toHaveLength(0);
      expect(prisma.users[0]).toMatchObject({
        emailVerified: true,
        phoneVerifiedAt: null,
      });
    });

    it('answers the phone-code routes 409 SIGNUP_CHANNEL_DISABLED, touching nothing', async () => {
      const service = serviceFor('email');
      const out = await service.signup(signup, IP);
      const start = await failure(service.phoneStart(PHONE, out.attempt, IP));
      expect(start).toEqual({
        statusCode: 409,
        code: 'SIGNUP_CHANNEL_DISABLED',
        message: 'Sign-up codes are sent by email now. Start again to get one.',
      });
      const confirm = await failure(
        service.phoneConfirm(
          PHONE,
          out.attempt,
          mail.lastCode(),
          undefined,
          IP,
        ),
      );
      expect(confirm.code).toBe('SIGNUP_CHANNEL_DISABLED');
      expect(sms.sent).toHaveLength(0);
      expect(sessionFor).not.toHaveBeenCalled();
      // the pending sign-up is untouched and the mailed code still works
      expect(prisma.codes()).toHaveLength(1);
      expect(
        (
          await service.emailCodeConfirm(
            PHONE,
            out.attempt,
            mail.lastCode(),
            IP,
          )
        ).accessToken,
      ).toBe('a');
    });

    it('resumes with the channel and the masked address', async () => {
      const service = serviceFor('email');
      const out = await service.signup(signup, IP);
      expect(await service.resume(PHONE, out.attempt, IP)).toMatchObject({
        step: 'phone',
        channel: 'email',
        maskedEmail: 'a•••@example.test',
      });
    });
  });

  describe('switching the setting while a sign-up is waiting', () => {
    it('email to phone: the mailed sign-up is answered `details`, and its code does nothing on the phone route', async () => {
      const out = await serviceFor('email').signup(signup, IP);
      const code = mail.lastCode();
      const nowPhone = serviceFor('phone');
      expect(await nowPhone.resume(PHONE, out.attempt, IP)).toEqual({
        step: 'details',
      });
      const body = await failure(
        nowPhone.phoneConfirm(PHONE, out.attempt, code, undefined, IP),
      );
      expect(body.code).toBe('PHONE_CODE_INVALID');
      expect(sessionFor).not.toHaveBeenCalled();
      expect(prisma.users[0].phoneVerifiedAt).toBeNull();
    });

    it('phone to email: the texted sign-up is answered `details`, and its code does nothing on the email route', async () => {
      const out = await serviceFor('phone').signup(signup, IP);
      const code = sms.lastCode();
      const nowEmail = serviceFor('email');
      expect(await nowEmail.resume(PHONE, out.attempt, IP)).toEqual({
        step: 'details',
      });
      // Even though the setting says email, a texted row cannot be proven by the email route.
      const body = await failure(
        nowEmail.emailCodeConfirm(PHONE, out.attempt, code, IP),
      );
      expect(body.code).toBe('EMAIL_CODE_INVALID');
      expect(sessionFor).not.toHaveBeenCalled();
    });

    it('a person whose code went the other way starts again at A3 and the new sign-up replaces the old', async () => {
      await serviceFor('phone').signup(signup, IP);
      later(61);
      const out = await serviceFor('email').signup(signup, IP);
      expect(prisma.users).toHaveLength(1);
      expect(
        (
          await serviceFor('email').emailCodeConfirm(
            PHONE,
            out.attempt,
            mail.lastCode(),
            IP,
          )
        ).accessToken,
      ).toBe('a');
      await flush();
    });
  });
});
