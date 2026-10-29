import * as argon2 from 'argon2';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SignupSequenceService } from './signup-sequence.service';
import { MemoryRateLimiter } from '../testing/memory-rate-limiter';

/**
 * EMAIL-01: the account mails WAWU ID sends by itself.
 *
 *  - "Your password was changed" after a change in the app and after a reset,
 *    by link or by code, to the person's own proven address.
 *  - The welcome also at the end of the app's sign-up.
 *
 * A mail is never allowed to break the request that caused it.
 */
const URL_BASE = 'https://app.example.test';
const config = {
  get: (k: string) =>
    ({ FRONTEND_URL: URL_BASE, SECURITY_URL: undefined })[k as 'FRONTEND_URL'],
};

const account = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  email: 'ada@example.test',
  firstName: 'Ada',
  phone: '+2348031234412',
  emailVerified: true,
  phoneVerifiedAt: null,
  status: 'active',
  deletedAt: null,
  passwordHash: 'x',
  phoneVerification: null,
  signupProgress: null,
  ...over,
});

describe('the password-changed mail', () => {
  const sendPasswordChanged = jest
    .fn<Promise<void>, [string, string, string | null]>()
    .mockResolvedValue(undefined);

  function build(user: Record<string, unknown>, mail: object) {
    const prisma = {
      wawuUser: {
        findUnique: jest.fn().mockResolvedValue(user),
        findFirst: jest.fn().mockResolvedValue(user),
        update: jest.fn().mockResolvedValue(user),
      },
      passwordResetToken: {
        findMany: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({}),
      },
      refreshToken: { deleteMany: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    const tokens = {
      issueTokens: jest
        .fn()
        .mockResolvedValue({ accessToken: 'a', refreshToken: 'r' }),
    };
    const otp = { verify: jest.fn().mockResolvedValue(true) };
    const auth = new AuthService(
      prisma as never,
      tokens as never,
      otp as never,
      mail as never,
      config as never,
    );
    return { auth, prisma };
  }
  beforeEach(() => sendPasswordChanged.mockClear());

  it('goes out after a reset by link, to the address, with the first name and a way to secure the account', async () => {
    const rawToken = 'a-reset-token';
    const user = account();
    const { auth, prisma } = build(user, { sendPasswordChanged });
    prisma.passwordResetToken.findMany.mockResolvedValue([
      {
        tokenHash: await argon2.hash(rawToken),
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    const res = await auth.resetPassword({
      token: rawToken,
      email: 'ada@example.test',
      password: 'a-new-password-1',
    });
    expect(res).toEqual({ message: 'Password reset successfully' });
    expect(sendPasswordChanged).toHaveBeenCalledTimes(1);
    expect(sendPasswordChanged).toHaveBeenCalledWith(
      'ada@example.test',
      `${URL_BASE}/forgot-password`,
      'Ada',
    );
  });

  it('goes out after a reset by code', async () => {
    const { auth } = build(account(), { sendPasswordChanged });
    const res = await auth.resetPassword({
      identifier: 'ada@example.test',
      code: '123456',
      newPassword: 'a-new-password-1',
    });
    expect(res).toHaveProperty('accessToken');
    expect(sendPasswordChanged).toHaveBeenCalledTimes(1);
    expect(sendPasswordChanged.mock.calls[0][0]).toBe('ada@example.test');
  });

  it('goes out after a change in the app, and not after one that was refused', async () => {
    const user = account();
    const { auth } = build(user, { sendPasswordChanged });
    const security = {
      changePassword: jest
        .fn()
        .mockResolvedValueOnce({ accessToken: 'a', refreshToken: 'r' })
        .mockRejectedValueOnce(new Error('CURRENT_PASSWORD_WRONG')),
    };
    const session = { accountFor: jest.fn().mockResolvedValue(user) };
    const controller = new AuthController(
      auth,
      {} as never,
      session as never,
      security as never,
    );
    const req = {} as never;
    const dto = {
      currentPassword: 'old-password-1',
      newPassword: 'new-password-2',
    };

    await controller.changePassword(dto, req);
    expect(sendPasswordChanged).toHaveBeenCalledTimes(1);
    expect(sendPasswordChanged.mock.calls[0][0]).toBe('ada@example.test');

    await expect(controller.changePassword(dto, req)).rejects.toThrow(
      'CURRENT_PASSWORD_WRONG',
    );
    expect(sendPasswordChanged).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an account with no email', account({ email: null })],
    [
      'a mobile sign-up whose email was never proven',
      account({ emailVerified: false, phoneVerifiedAt: new Date() }),
    ],
  ])('stays quiet for %s', async (_name, user) => {
    const { auth } = build(user, { sendPasswordChanged });
    await auth.resetPassword({
      identifier: '+2348031234412',
      code: '123456',
      newPassword: 'a-new-password-1',
    });
    expect(sendPasswordChanged).not.toHaveBeenCalled();
  });

  it('still reaches a person in the 30 days of a deletion, who changed the password themselves', () => {
    const { auth } = build(
      account({ status: 'pending_deletion', deletedAt: new Date() }),
      { sendPasswordChanged },
    );
    auth.notifyPasswordChanged(
      account({ status: 'pending_deletion', deletedAt: new Date() }),
    );
    expect(sendPasswordChanged).toHaveBeenCalledTimes(1);
  });

  it('never breaks the change: a mail that throws, rejects or does not exist changes nothing', async () => {
    for (const mail of [
      {
        sendPasswordChanged: () => {
          throw new Error('mailer down');
        },
      },
      { sendPasswordChanged: () => Promise.reject(new Error('mailer down')) },
      {},
    ]) {
      const { auth } = build(account(), mail);
      const res = await auth.resetPassword({
        identifier: 'ada@example.test',
        code: '123456',
        newPassword: 'a-new-password-1',
      });
      expect(res).toHaveProperty('accessToken');
    }
  });
});

describe('the welcome at the end of the app sign-up', () => {
  type Row = Record<string, unknown>;

  function build(user: Row) {
    const progress = new Map<string, Row>();
    const prisma = {
      wawuUser: { findUniqueOrThrow: () => Promise.resolve({ ...user }) },
      signupProgress: {
        findUnique: ({ where }: { where: { userId: string } }) =>
          Promise.resolve(
            progress.has(where.userId)
              ? { ...progress.get(where.userId) }
              : null,
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
      $queryRaw: () => Promise.resolve([]),
      $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    };
    const sendWelcome = jest.fn().mockResolvedValue(undefined);
    const service = new SignupSequenceService(
      prisma as never,
      new MemoryRateLimiter(),
      { sendWelcome } as never,
      { get: () => undefined } as never,
    );
    return { service, sendWelcome };
  }

  const mobile = (over: Row = {}) =>
    account({
      id: '00000000-0000-0000-0000-000000000001',
      phoneVerifiedAt: new Date(),
      accountType: 'user',
      ...over,
    }) as never;

  it('is sent when a discovering account finishes its last step, once', async () => {
    const user = mobile();
    const { service, sendWelcome } = build(user);
    await service.complete(user, 'email');
    await service.complete(user, 'interests');
    expect(sendWelcome).not.toHaveBeenCalled();
    await service.complete(user, 'follows');
    expect(sendWelcome).toHaveBeenCalledTimes(1);
    expect(sendWelcome).toHaveBeenCalledWith('ada@example.test', 'Ada');
    // A repeat tap (a double tap) answers where the sign-up stands and sends nothing more.
    await expect(service.complete(user, 'follows')).resolves.toMatchObject({
      step: 'done',
    });
    expect(sendWelcome).toHaveBeenCalledTimes(1);
  });

  it('is sent when an earning account finishes its set-up', async () => {
    const user = mobile({ accountType: 'creator' });
    const { service, sendWelcome } = build(user);
    await service.complete(user, 'email');
    expect(sendWelcome).not.toHaveBeenCalled();
    await service.complete(user, 'creator_setup');
    expect(sendWelcome).toHaveBeenCalledTimes(1);
  });

  it('is not sent to an email that was never proven, to no email, or to a closed account', async () => {
    for (const over of [
      { emailVerified: false },
      { email: null, emailVerified: false },
      { status: 'pending_deletion', deletedAt: new Date() },
    ]) {
      const user = mobile(over);
      const { service, sendWelcome } = build(user);
      await service.complete(user, 'email');
      await service.complete(user, 'interests');
      await service.complete(user, 'follows');
      expect(sendWelcome).not.toHaveBeenCalled();
    }
  });

  it('never breaks the last step: a mail that throws changes nothing', async () => {
    const user = mobile();
    const { service, sendWelcome } = build(user);
    sendWelcome.mockImplementation(() => {
      throw new Error('mailer down');
    });
    await service.complete(user, 'email');
    await service.complete(user, 'interests');
    await expect(service.complete(user, 'follows')).resolves.toMatchObject({
      step: 'done',
    });
  });
});
