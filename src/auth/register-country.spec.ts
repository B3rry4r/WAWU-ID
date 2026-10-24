import { ConflictException, HttpException } from '@nestjs/common';
import { AuthService } from './auth.service';

/**
 * POST /auth/register (the web's sign-up) and the country of residence
 * (GEO-01, round 1): a country that is not on the list is refused before the
 * sweep of expired sign-ups and before the duplicate check, so it answers 400
 * COUNTRY_INVALID whether or not the phone is free, as POST /auth/signup does.
 */
describe('register: a bad countryCode is refused before anything else', () => {
  function build(existing: unknown) {
    const row = {
      id: 'u1',
      email: 'ada@example.test',
      phone: '08031234412',
      firstName: 'Ada',
      middleName: null,
      lastName: 'Obi',
      country: 'Nigeria',
      countryCode: 'NG',
      state: null,
      gender: null,
      occupation: null,
      accountType: null,
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
      creatorVerifiedAt: null,
      creatorVerifiedUntil: null,
      professionalVerifiedAt: null,
      professionalVerifiedUntil: null,
    };
    const wawuUser = {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(existing),
      create: jest.fn().mockResolvedValue(row),
    };
    const prisma = {
      wawuUser,
      $transaction: (fn: (tx: unknown) => unknown) => fn({ wawuUser }),
    };
    const tokens = {
      issueTokens: jest
        .fn()
        .mockResolvedValue({ accessToken: 'a', refreshToken: 'r' }),
    };
    const service = new AuthService(
      prisma as never,
      tokens as never,
      {} as never,
      {} as never,
      { get: () => undefined } as never,
    );
    return { service, wawuUser };
  }

  const dto = {
    email: 'ada@example.test',
    phone: '08031234412',
    country: 'Nigeria',
    firstName: 'Ada',
    lastName: 'Obi',
    password: 'a-long-password',
  };

  /** The countryCode the account was created with. */
  const createdCountry = (create: jest.Mock): string =>
    (create.mock.calls as Array<[{ data: { countryCode: string } }]>)[0][0].data
      .countryCode;

  async function failure(p: Promise<unknown>): Promise<HttpException> {
    try {
      await p;
    } catch (err) {
      return err as HttpException;
    }
    throw new Error('expected the call to fail');
  }

  it.each([
    ['a free phone', null],
    ['a phone another account holds', { id: 'other' }],
  ])(
    'answers 400 COUNTRY_INVALID for %s, writes nothing and looks nothing up',
    async (_n, existing) => {
      const { service, wawuUser } = build(existing);
      const err = await failure(
        service.register({ ...dto, countryCode: 'XX' }),
      );
      expect(err).not.toBeInstanceOf(ConflictException);
      expect(err.getStatus()).toBe(400);
      expect(err.getResponse()).toMatchObject({ code: 'COUNTRY_INVALID' });
      expect(wawuUser.findMany).not.toHaveBeenCalled();
      expect(wawuUser.findFirst).not.toHaveBeenCalled();
      expect(wawuUser.create).not.toHaveBeenCalled();
    },
  );

  it('still answers 409 for a taken phone when the country is fine or absent', async () => {
    for (const countryCode of [undefined, 'NG', 'gh']) {
      const { service, wawuUser } = build({ id: 'other' });
      const err = await failure(service.register({ ...dto, countryCode }));
      expect(err).toBeInstanceOf(ConflictException);
      expect(wawuUser.create).not.toHaveBeenCalled();
    }
  });

  it("keeps the country sent, and the phone's own when none is sent", async () => {
    const sent = build(null);
    await sent.service.register({ ...dto, countryCode: 'gh' });
    expect(createdCountry(sent.wawuUser.create)).toBe('GH');
    const none = build(null);
    await none.service.register({ ...dto });
    expect(createdCountry(none.wawuUser.create)).toBe('NG');
  });
});
