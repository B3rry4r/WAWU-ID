import { JwtService } from '@nestjs/jwt';
import type { WawuUser } from '@prisma/client';
import { generateKeyPairSync } from 'crypto';
import { AuthService } from './auth.service';
import { phoneForClients } from './released-phone';
import { TokensService } from './tokens.service';

/**
 * G-16 (AUTH-05 fix round 1, U1): a number released by the owner's script
 * leaves `released:<id>` in the phone column. That marker never reaches the
 * Hub or the app as a phone.
 */
describe('a released phone number', () => {
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const jwt = new JwtService({
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
  });
  const prisma = {
    phoneVerification: { findUnique: () => Promise.resolve(null) },
    refreshToken: { create: () => Promise.resolve({}) },
  };
  const tokens = new TokensService(
    jwt,
    {
      get: () => undefined,
      getOrThrow: (k: string) => (k === 'JWT_EXPIRES_IN' ? '15m' : '30d'),
    } as never,
    { kid: 'k1' } as never,
    prisma as never,
  );
  const auth = new AuthService(
    prisma as never,
    tokens,
    {} as never,
    {} as never,
    { get: () => undefined } as never,
  );
  const ID = '00000000-0000-0000-0000-00000000000b';
  const user = (phone: string) =>
    ({
      id: ID,
      email: 'kept@example.test',
      phone,
      firstName: 'K',
      middleName: null,
      lastName: 'E',
      country: 'NG',
      state: null,
      gender: null,
      occupation: null,
      accountType: null,
      verificationTier: 'basic',
      trustScore: 0,
      creatorVerifiedAt: null,
      creatorVerifiedUntil: null,
      professionalVerifiedAt: null,
      professionalVerifiedUntil: null,
      status: 'active',
      phoneVerifiedAt: null,
      wawuafricaAppUserId: null,
      onboardingRef: null,
      beautyUserId: null,
      basketUserId: null,
    }) as unknown as WawuUser;

  it('is carried as an empty phone in the access token and the account answer', async () => {
    const session = await auth.sessionFor(user(`released:${ID}`));
    expect(session.user.phone).toBe('');
    const claims = jwt.decode<{ phone: string }>(session.accessToken);
    expect(claims.phone).toBe('');
    expect(session.accessToken).not.toContain('released');
    expect(JSON.stringify(session.user)).not.toContain('released');
  });

  it('leaves every real phone exactly as stored', async () => {
    for (const phone of [
      '08031110001',
      '+2348031110001',
      '0803 111 0001',
      '+447700900123',
    ]) {
      expect(phoneForClients(phone)).toBe(phone);
      const session = await auth.sessionFor(user(phone));
      expect(session.user.phone).toBe(phone);
      expect(jwt.decode<{ phone: string }>(session.accessToken).phone).toBe(
        phone,
      );
    }
  });

  it('is never sent a reset code, while a real phone still is', async () => {
    const generateAndSend = jest.fn(() => Promise.resolve());
    let stored = `released:${ID}`;
    const resets = new AuthService(
      {
        wawuUser: {
          findFirst: () => Promise.resolve({ ...user(stored), email: null }),
        },
      } as never,
      tokens,
      { generateAndSend } as never,
      {} as never,
      { get: () => undefined } as never,
    );
    await resets.forgotPassword('kept@example.test', 'sms');
    expect(generateAndSend).not.toHaveBeenCalled();
    stored = '08031110001';
    await resets.forgotPassword('08031110001', 'sms');
    expect(generateAndSend).toHaveBeenCalledWith('08031110001');
  });
});
