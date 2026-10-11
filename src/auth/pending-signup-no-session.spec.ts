import { ForbiddenException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AuthService } from './auth.service';
import { TokensService } from './tokens.service';

/**
 * A mobile sign-up whose phone code was never entered holds no session, by any
 * route. Every route in this service that hands out tokens does it through
 * TokensService.issueTokens, so each of them is driven here against the real
 * TokensService, with an account that has a pending sign-up, and again with
 * one that does not (a web or legacy account), which must be unaffected.
 *
 * The routes: POST /auth/login, /auth/refresh, /auth/otp/verify,
 * /auth/email/verify/confirm, /auth/reset-password (code by SMS),
 * /auth/activate, POST /auth/register, and /auth/phone/verify/confirm (which
 * deletes the pending row before it asks).
 */
describe('a pending mobile sign-up holds no session', () => {
  const password = 'correct horse battery';
  let hash: string;
  let codeHash: string;

  beforeAll(async () => {
    hash = await argon2.hash(password);
    codeHash = await argon2.hash('123456');
  });

  const user = (over: Record<string, unknown> = {}) => ({
    id: 'u1',
    email: 'ada@wawuafrica.com',
    phone: '+2348031234412',
    firstName: null,
    middleName: null,
    lastName: null,
    country: null,
    state: null,
    gender: null,
    occupation: null,
    accountType: null,
    verificationTier: 'basic',
    trustScore: 0,
    status: 'active',
    passwordHash: hash,
    emailVerified: true,
    phoneVerifiedAt: null,
    creatorVerifiedAt: null,
    creatorVerifiedUntil: null,
    professionalVerifiedAt: null,
    professionalVerifiedUntil: null,
    wawuafricaAppUserId: null,
    onboardingRef: null,
    beautyUserId: null,
    basketUserId: null,
    ...over,
  });

  function build(
    pending: boolean,
    row = user(),
    channel: string | null = null,
  ) {
    const refreshHash = argon2.hash('refresh-token');
    const found = pending
      ? { ...row, phoneVerification: { id: 'pv1', channel } }
      : row;
    const prisma = {
      wawuUser: {
        findFirst: jest.fn().mockResolvedValue(found),
        findUnique: jest.fn().mockResolvedValue(found),
        create: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue(row),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      phoneVerification: {
        findUnique: jest
          .fn()
          .mockResolvedValue(pending ? { id: 'pv1', channel } : null),
      },
      emailVerificationCode: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'e1',
          codeHash,
          expiresAt: new Date(Date.now() + 60_000),
        }),
        delete: jest.fn(),
      },
      activationToken: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'a1',
            tokenHash: codeHash,
            expiresAt: new Date(Date.now() + 60_000),
          },
        ]),
        deleteMany: jest.fn(),
      },
      refreshToken: {
        create: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        delete: jest.fn(),
        findMany: jest.fn(async () => [
          {
            id: 'r1',
            tokenHash: await refreshHash,
            expiresAt: new Date(Date.now() + 60_000),
          },
        ]),
      },
      // A refresh runs its work in a callback under the account's row lock
      // (SETTINGS-03); the other callers pass a list of operations.
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (tx: unknown) => unknown)(prisma)
          : Promise.all((arg as unknown[]).map((o) => Promise.resolve(o))).then(
              () => [row],
            ),
      ),
    };
    const jwt = {
      signAsync: jest.fn().mockResolvedValue('signed'),
      decode: jest
        .fn()
        .mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      verifyAsync: jest.fn().mockResolvedValue({ sub: 'u1', type: 'refresh' }),
    };
    const config = {
      get: () => undefined,
      getOrThrow: () => '15m',
    };
    const tokens = new TokensService(
      jwt as never,
      config as never,
      { kid: 'k' } as never,
      prisma as never,
    );
    const otp = { verify: jest.fn().mockResolvedValue(true) };
    const mail = {
      sendWelcome: jest.fn(),
      sendLoginAlert: jest.fn(),
      sendOtpCode: jest.fn(),
    };
    const auth = new AuthService(
      prisma as never,
      tokens,
      otp as never,
      mail as never,
      config as never,
    );
    return { auth, prisma };
  }

  const routes: Array<[string, (a: AuthService) => Promise<unknown>]> = [
    ['login', (a) => a.login({ identifier: 'ada@wawuafrica.com', password })],
    ['refresh', (a) => a.refresh('refresh-token')],
    ['otp verify', (a) => a.otpVerify('+2348031234412', '123456')],
    [
      'email verify confirm',
      (a) => a.emailVerifyConfirm('ada@wawuafrica.com', '123456'),
    ],
    [
      'reset password by sms code',
      (a) =>
        a.resetPassword({
          identifier: 'ada@wawuafrica.com',
          code: '123456',
          newPassword: 'a-brand-new-password',
        }),
    ],
  ];

  it.each(routes)(
    '%s: refused 403 PHONE_NOT_CONFIRMED while the phone code is pending',
    async (_name, call) => {
      const { auth, prisma } = build(true);
      const err = await call(auth).catch((e: unknown) => e);
      // nothing was changed on the way to refusing: no new password, no
      // verified email, no session record
      expect(prisma.wawuUser.update).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        statusCode: 403,
        code: 'PHONE_NOT_CONFIRMED',
      });
    },
  );

  // AUTH-07: the code is the same (the contract names it), the sentence says
  // where the code went.
  it.each(routes)(
    '%s: a pending sign-up whose code was mailed is refused with the same code and a sentence about the email',
    async (_name, call) => {
      const { auth } = build(true, user(), 'email');
      const err = await call(auth).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toEqual({
        statusCode: 403,
        code: 'PHONE_NOT_CONFIRMED',
        message: 'Enter the code we emailed you to finish signing up.',
      });
    },
  );

  it.each(routes)(
    '%s: a pending sign-up whose code was texted is refused with the sentence it always had',
    async (_name, call) => {
      const { auth } = build(true);
      const err = await call(auth).catch((e: unknown) => e);
      expect((err as ForbiddenException).getResponse()).toEqual({
        statusCode: 403,
        code: 'PHONE_NOT_CONFIRMED',
        message: 'Confirm your phone number to finish signing up.',
      });
    },
  );

  it.each(routes)(
    '%s: gives a web or legacy account its session as before',
    async (_name, call) => {
      const { auth, prisma } = build(false);
      const out = (await call(auth)) as { accessToken: string };
      expect(out.accessToken).toBe('signed');
      expect(prisma.refreshToken.create).toHaveBeenCalled();
    },
  );

  it('activate: refused while pending, as before for everyone else', async () => {
    const dto = {
      email: 'ada@wawuafrica.com',
      activationToken: '123456',
      password: 'a-brand-new-password',
    };
    const pending = build(true, user({ passwordHash: null }));
    await expect(pending.auth.activate(dto as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const web = build(false, user({ passwordHash: null }));
    const out = await web.auth.activate(dto);
    expect(out.accessToken).toBe('signed');
  });

  it('register: a web sign-up has no pending row and is issued its tokens as before', async () => {
    const { auth, prisma } = build(false);
    prisma.wawuUser.findFirst.mockResolvedValue(null);
    const out = await auth.register({
      email: 'new@wawuafrica.com',
      password,
      phone: '+2348099900011',
      country: 'Nigeria',
      firstName: 'Ada',
      lastName: 'Obi',
    });
    expect(out.accessToken).toBe('signed');
  });

  it('a phone-verified account is never held back, whatever row it once had', async () => {
    const { auth } = build(true, user({ phoneVerifiedAt: new Date() }));
    const out = await auth.sessionFor(
      user({ phoneVerifiedAt: new Date() }) as never,
    );
    expect(out.accessToken).toBe('signed');
  });

  it('removes only expired pending sign-ups when a web sign-up arrives', async () => {
    const { auth, prisma } = build(false);
    prisma.wawuUser.findFirst.mockResolvedValue(null);
    await auth.register({
      email: 'New@WAWUafrica.com',
      password,
      phone: '08099900011',
      country: 'Nigeria',
      firstName: 'Ada',
      lastName: 'Obi',
    });
    const where = (
      prisma.wawuUser.deleteMany.mock.calls as Array<
        [{ where: Record<string, unknown> }]
      >
    )[0][0].where;
    expect(where.phoneVerifiedAt).toBeNull();
    expect(where.phoneVerification).toEqual({
      is: { signupExpiresAt: { lt: expect.any(Date) as Date } },
    });
    expect(where.OR).toEqual([
      { email: 'new@wawuafrica.com' },
      { phone: { in: ['08099900011', '+2348099900011', '2348099900011'] } },
    ]);
  });
});
