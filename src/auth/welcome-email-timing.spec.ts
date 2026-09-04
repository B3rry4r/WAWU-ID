import { AuthService } from './auth.service';

/**
 * WHEN THE WELCOME EMAIL IS ALLOWED TO GO OUT.
 *
 * It used to be sent from register(), which is wrong twice over: the address
 * has not been proven yet (so it goes to typos, permanently), and the person
 * cannot sign in yet (login refuses an unverified email) so "see you inside"
 * is a lie for as long as they take to enter the code. Landing beside the
 * verification code, it also read as a second, contradictory signup email.
 *
 * It belongs to the moment the code is confirmed, exactly once.
 */
describe('welcome email timing', () => {
  const sendWelcome = jest.fn();

  /** Only the surface these two methods touch. */
  function build(user: Record<string, unknown>) {
    const mail = { sendWelcome, sendLoginAlert: jest.fn() };
    const prisma = {
      wawuUser: {
        findUnique: jest.fn().mockResolvedValue(user),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(user),
        update: jest.fn(),
      },
      emailVerificationCode: {
        findFirst: jest.fn(),
        deleteMany: jest.fn(),
        delete: jest.fn(),
      },
      userProfile: { create: jest.fn() },
      $transaction: jest.fn(async (ops: unknown[]) => [
        { ...user, emailVerified: true },
        ...ops.slice(1).map(() => ({})),
      ]),
    };
    const tokens = {
      issueTokens: jest.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r' }),
    };
    const service = new AuthService(
      prisma as never,
      tokens as never,
      {} as never,
      mail as never,
      { get: () => undefined } as never,
    );
    return { service, prisma };
  }

  beforeEach(() => sendWelcome.mockClear());

  it('does not send at registration, before the address is proven', async () => {
    const { service } = build({
      id: 'u1',
      email: 'new@wawuafrica.com',
      firstName: 'Ada',
      emailVerified: false,
    });

    await service
      .register({
        email: 'new@wawuafrica.com',
        password: 'correct horse battery',
        firstName: 'Ada',
        lastName: 'Obi',
        fullName: 'Ada Obi',
        phone: '+2348012345678',
      } as never)
      .catch(() => undefined); // shape of register's own deps is not under test

    expect(sendWelcome).not.toHaveBeenCalled();
  });

  it('sends once when the code is confirmed', async () => {
    const { service, prisma } = build({
      id: 'u1',
      email: 'new@wawuafrica.com',
      firstName: 'Ada',
      emailVerified: false,
    });
    prisma.emailVerificationCode.findFirst.mockResolvedValue({
      id: 'c1',
      codeHash: 'hash',
      expiresAt: new Date(Date.now() + 60_000),
    });
    jest.spyOn(require('argon2'), 'verify').mockResolvedValue(true as never);

    await service.emailVerifyConfirm('new@wawuafrica.com', '123456');

    expect(sendWelcome).toHaveBeenCalledTimes(1);
    expect(sendWelcome).toHaveBeenCalledWith('new@wawuafrica.com', 'Ada');
  });

  it('does not send again to an address that is already verified', async () => {
    const { service, prisma } = build({
      id: 'u1',
      email: 'new@wawuafrica.com',
      firstName: 'Ada',
      emailVerified: true, // a second device, or a stale tab replaying a code
    });
    prisma.emailVerificationCode.findFirst.mockResolvedValue({
      id: 'c1',
      codeHash: 'hash',
      expiresAt: new Date(Date.now() + 60_000),
    });
    jest.spyOn(require('argon2'), 'verify').mockResolvedValue(true as never);

    await service.emailVerifyConfirm('new@wawuafrica.com', '123456');

    expect(sendWelcome).not.toHaveBeenCalled();
  });
});
