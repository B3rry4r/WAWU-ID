import { AuthService } from './auth.service';

/**
 * POST /auth/forgot-password tells a caller that asked for an emailed link how
 * long the link lasts (the app's "Check your email" screen shows it, AUTH-01).
 * The figure is the token's real lifetime, and it is the same in every answer
 * to such a request, so it reveals nothing about which accounts exist. A
 * request for the SMS code (the default) is answered exactly as it always was.
 */
describe('forgot password: the link lifetime', () => {
  const sent = 'If an account exists, a reset code has been sent.';

  function build(user: Record<string, unknown> | null) {
    const prisma = {
      wawuUser: { findFirst: jest.fn().mockResolvedValue(user) },
      passwordResetToken: { create: jest.fn().mockResolvedValue({}) },
    };
    const otp = { generateAndSend: jest.fn().mockResolvedValue(undefined) };
    const mail = { sendPasswordReset: jest.fn().mockResolvedValue(undefined) };
    const config = { get: () => 'https://app.example.test' };
    const auth = new AuthService(
      prisma as never,
      {} as never,
      otp as never,
      mail as never,
      config as never,
    );
    return { auth, prisma, otp, mail };
  }

  const account = {
    id: 'u1',
    email: 'ada@wawuafrica.com',
    phone: '+2348031234412',
    firstName: 'Ada',
    emailVerified: true,
    phoneVerifiedAt: null,
  };

  it('answers the lifetime that the stored token really has', async () => {
    const { auth, prisma, mail } = build(account);
    const before = Date.now();
    const res = await auth.forgotPassword('ada@wawuafrica.com', 'email');
    const created = (
      prisma.passwordResetToken.create.mock.calls[0] as [
        { data: { expiresAt: Date } },
      ]
    )[0];
    const lifetime = (created.data.expiresAt.getTime() - before) / 1000;
    expect(res).toEqual({ message: sent, expiresInSeconds: 3600 });
    expect(Math.abs(lifetime - 3600)).toBeLessThan(5);
    expect(mail.sendPasswordReset).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no such account', null],
    [
      'a mobile sign-up whose email was never proven',
      { ...account, emailVerified: false, phoneVerifiedAt: new Date() },
    ],
    ['an account with no email', { ...account, email: null }],
  ])('answers the same figure for %s', async (_name, user) => {
    const { auth, mail } = build(user);
    const res = await auth.forgotPassword('ada@wawuafrica.com', 'email');
    expect(res).toEqual({ message: sent, expiresInSeconds: 3600 });
    expect(mail.sendPasswordReset).not.toHaveBeenCalled();
  });

  it.each([undefined, 'sms' as const])(
    'a request for the SMS code (%s) is answered exactly as before',
    async (method) => {
      const { auth, otp } = build(account);
      const res = await auth.forgotPassword('ada@wawuafrica.com', method);
      expect(Object.keys(res)).toEqual(['message']);
      expect(res).toEqual({ message: sent });
      expect(otp.generateAndSend).toHaveBeenCalledTimes(1);
    },
  );
});
