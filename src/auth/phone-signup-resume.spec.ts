import { HttpException } from '@nestjs/common';
import { createHash } from 'crypto';
import { MemoryRateLimiter } from '../testing/memory-rate-limiter';
import { RecordingSmsProvider } from '../testing/recording-sms.provider';
import { PhoneSignupService } from './phone-signup.service';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const NOW = new Date('2026-10-03T10:00:00Z');
const PHONE = '+2348031234412';
const SECRET = 'a-live-secret-of-the-person-who-signed-up';
const IP = '203.0.113.9';

/**
 * POST /auth/signup/resume (AUTH-05): where a sign-up stands before its phone
 * code, for an app that was closed between A3 and A4.
 */
describe('PhoneSignupService.resume', () => {
  let rows: Array<Record<string, unknown>>;
  let sms: RecordingSmsProvider;
  let service: PhoneSignupService;
  let writes: number;
  const env: Record<string, string> = { SIGNUP_RESUME_LIMIT_IP_PER_HOUR: '3' };

  function pending(over: Record<string, unknown> = {}, user = {}) {
    rows.push({
      id: 'c1',
      userId: 'u1',
      phone: PHONE,
      attemptHash: sha256(SECRET),
      claimEmail: null,
      expiresAt: new Date(NOW.getTime() + 200_000),
      lastSentAt: new Date(NOW.getTime() - 25_000),
      signupExpiresAt: new Date(NOW.getTime() + 3_600_000),
      user: {
        id: 'u1',
        phoneVerifiedAt: null,
        accountType: 'creator',
        ...user,
      },
      ...over,
    });
  }

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'], now: NOW });
    rows = [];
    writes = 0;
    sms = new RecordingSmsProvider();
    const count = () => {
      writes += 1;
      return Promise.resolve({});
    };
    const prisma = {
      phoneVerification: {
        findUnique: ({ where }: { where: { attemptHash: string } }) =>
          Promise.resolve(
            rows.find((r) => r.attemptHash === where.attemptHash) ?? null,
          ),
        update: count,
        deleteMany: count,
      },
      wawuUser: { update: count, updateMany: count, deleteMany: count },
    };
    service = new PhoneSignupService(
      prisma as never,
      {} as never,
      { get: (name: string) => env[name] } as never,
      sms,
      new MemoryRateLimiter(),
      {} as never,
    );
  });
  afterEach(() => jest.useRealTimers());

  it('answers the code step with what is left of the code and of the resend wait, and sends nothing', async () => {
    pending();
    await expect(service.resume('0803 123 4412', SECRET, IP)).resolves.toEqual({
      step: 'phone',
      phone: PHONE,
      expiresIn: 200,
      resendIn: 35,
      emailCodeRequired: false,
      accountType: 'creator',
    });
    expect(sms.sent).toHaveLength(0);
    expect(writes).toBe(0);
  });

  it('says a code that ran out has 0 seconds left, and the resend is open', async () => {
    pending({
      expiresAt: new Date(NOW.getTime() - 1000),
      lastSentAt: new Date(NOW.getTime() - 400_000),
    });
    await expect(service.resume(PHONE, SECRET, IP)).resolves.toMatchObject({
      step: 'phone',
      expiresIn: 0,
      resendIn: 0,
    });
  });

  it('tells the app to ask for the mailed code too when the sign-up claims a held email', async () => {
    pending({ claimEmail: 'held@example.test' }, { accountType: null });
    await expect(service.resume(PHONE, SECRET, IP)).resolves.toMatchObject({
      step: 'phone',
      emailCodeRequired: true,
      accountType: null,
    });
  });

  it.each([
    ['a made-up secret', () => pending(), 'not-the-secret', PHONE],
    [
      'the secret with another number',
      () => pending(),
      SECRET,
      '+2348039999999',
    ],
    [
      'an expired sign-up',
      () => pending({ signupExpiresAt: new Date(NOW.getTime() - 1) }),
      SECRET,
      PHONE,
    ],
    [
      'a sign-up already confirmed',
      () => pending({}, { phoneVerifiedAt: new Date() }),
      SECRET,
      PHONE,
    ],
    ['a replaced sign-up (its row is gone)', () => undefined, SECRET, PHONE],
    ['a number that is not one', () => pending(), SECRET, 'not a phone'],
    ['a number outside Nigeria', () => pending(), SECRET, '+447700900123'],
  ])(
    'answers details (start again at A3) for %s',
    async (_n, setup, secret, phone) => {
      setup();
      await expect(service.resume(phone, secret, IP)).resolves.toEqual({
        step: 'details',
      });
      expect(writes).toBe(0);
    },
  );

  it('limits resume checks per client address', async () => {
    pending();
    for (let i = 0; i < 3; i += 1) await service.resume(PHONE, SECRET, IP);
    try {
      await service.resume(PHONE, SECRET, IP);
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(429);
      expect((err as HttpException).getResponse()).toMatchObject({
        code: 'RATE_LIMITED',
      });
    }
    // Another address is not held back.
    await expect(
      service.resume(PHONE, SECRET, '198.51.100.4'),
    ).resolves.toMatchObject({ step: 'phone' });
  });
});
