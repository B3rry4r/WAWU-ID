import { UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AuthService } from './auth.service';

/**
 * WHO MAY SIGN IN (AUTH-03).
 *
 * login() refuses an email account whose address was never confirmed. The
 * mobile sign-up never asks for the email code, so an account that proved its
 * PHONE instead must get in. Every account that has not proven its phone is
 * judged exactly as it was before: the first two cases below are the old
 * rule and must never change.
 */
describe('login: unverified email', () => {
  const password = 'correct horse battery';
  let hash: string;

  beforeAll(async () => {
    hash = await argon2.hash(password);
  });

  function build(user: Record<string, unknown>) {
    const base = {
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
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
      passwordHash: hash,
      emailVerified: false,
      phoneVerifiedAt: null,
      creatorVerifiedAt: null,
      creatorVerifiedUntil: null,
      professionalVerifiedAt: null,
      professionalVerifiedUntil: null,
      ...user,
    };
    const findFirst = jest.fn().mockResolvedValue(base);
    const prisma = { wawuUser: { findFirst } };
    const tokens = {
      issueTokens: jest
        .fn()
        .mockResolvedValue({ accessToken: 'a', refreshToken: 'r' }),
    };
    const mail = { sendLoginAlert: jest.fn() };
    const service = new AuthService(
      prisma as never,
      tokens as never,
      {} as never,
      mail as never,
      { get: () => undefined } as never,
    );
    return { service, tokens, findFirst, mail };
  }

  const attempt = (user: Record<string, unknown>) =>
    build(user).service.login({ identifier: 'ada@wawuafrica.com', password });

  it('still refuses an account whose email and phone are both unproven', async () => {
    const err = await attempt({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).getResponse()).toMatchObject({
      statusCode: 403,
      code: 'EMAIL_NOT_VERIFIED',
    });
  });

  it('still lets an account in once its email is confirmed', async () => {
    const out = await attempt({ emailVerified: true });
    expect(out.accessToken).toBe('a');
  });

  it('lets an account in when its phone is proven and its email is not', async () => {
    const { service, tokens } = build({ phoneVerifiedAt: new Date() });
    const out = await service.login({
      identifier: 'ada@wawuafrica.com',
      password,
    });
    expect(out.accessToken).toBe('a');
    expect(tokens.issueTokens).toHaveBeenCalledTimes(1);
  });

  it('still needs the right password, proven phone or not', async () => {
    const { service } = build({ phoneVerifiedAt: new Date() });
    await expect(
      service.login({
        identifier: 'ada@wawuafrica.com',
        password: 'wrong one',
      }),
    ).rejects.toMatchObject({ message: 'Invalid credentials' });
  });

  it('is unchanged for a phone-only account', async () => {
    const out = await attempt({ email: null });
    expect(out.accessToken).toBe('a');
  });

  it('sends no "was this you" mail to an email nobody proved', async () => {
    const proven = build({ phoneVerifiedAt: new Date() });
    await proven.service.login({ identifier: 'ada@wawuafrica.com', password });
    expect(proven.mail.sendLoginAlert).not.toHaveBeenCalled();
  });

  it('still sends it to every account that signs in the old way', async () => {
    const web = build({ emailVerified: true });
    await web.service.login({ identifier: 'ada@wawuafrica.com', password });
    expect(web.mail.sendLoginAlert).toHaveBeenCalledTimes(1);

    const both = build({ emailVerified: true, phoneVerifiedAt: new Date() });
    await both.service.login({ identifier: 'ada@wawuafrica.com', password });
    expect(both.mail.sendLoginAlert).toHaveBeenCalledTimes(1);
  });

  describe('a phone typed the local way', () => {
    it('finds a phone-verified account stored as +234 after the exact lookup misses', async () => {
      const { service, findFirst } = build({ phoneVerifiedAt: new Date() });
      findFirst.mockResolvedValueOnce(null);
      const out = await service.login({
        identifier: '0803 123 4412',
        password,
      });
      expect(out.accessToken).toBe('a');
      expect(findFirst).toHaveBeenCalledTimes(2);
      expect((findFirst.mock.calls as unknown[][])[1][0]).toEqual({
        where: { phone: '+2348031234412', phoneVerifiedAt: { not: null } },
        include: { phoneVerification: true },
      });
    });

    it('keeps the exact lookup first, so a legacy row is found exactly as before', async () => {
      const { service, findFirst } = build({ phone: '08031234412' });
      await service
        .login({ identifier: '08031234412', password })
        .catch(() => undefined);
      expect(findFirst).toHaveBeenCalledTimes(1);
      expect((findFirst.mock.calls as unknown[][])[0][0]).toEqual({
        where: { OR: [{ email: '08031234412' }, { phone: '08031234412' }] },
        include: { phoneVerification: true },
      });
    });

    it('still answers 404 for a number nobody holds', async () => {
      const { service, findFirst } = build({});
      findFirst.mockResolvedValue(null);
      await expect(
        service.login({ identifier: '08031234412', password }),
      ).rejects.toMatchObject({
        response: { statusCode: 404, code: 'USER_NOT_IN_WAWUID' },
      });
    });
  });

  describe('the answer to an account that has an account type', () => {
    it('carries accountType and occupation when the row has them', async () => {
      const out = await build({
        emailVerified: true,
        occupation: 'Photographer',
        accountType: 'creator',
      }).service.login({ identifier: 'ada@wawuafrica.com', password });
      expect(out.user).toMatchObject({
        occupation: 'Photographer',
        accountType: 'creator',
      });
    });

    it('leaves every account without one answering exactly as before: no accountType key', async () => {
      const out = await attempt({ emailVerified: true, accountType: null });
      expect(Object.keys(out.user).sort()).toEqual([
        'country',
        'email',
        'fullName',
        'gender',
        'id',
        'occupation',
        'phone',
        'state',
        'status',
        'trustScore',
        'verification',
        'verificationTier',
      ]);
      expect(out.user.occupation).toBeNull();
    });
  });
});
