import * as argon2 from 'argon2';
import { AuthService } from './auth.service';

/**
 * A mobile user who changes their number through the existing internal flow
 * keeps the right to sign in. The proof on the row (`phone_verified_at`) says
 * this account came through a confirmed sign-up; it is not about one number,
 * and clearing it would leave an account with an unproven email (every mobile
 * sign-up) refused with EMAIL_NOT_VERIFIED. Both routes write the phone and
 * nothing else, exactly as they did before sign-up existed.
 */
describe('changing the phone number', () => {
  const row = {
    id: 'u1',
    email: 'ada@wawuafrica.com',
    phone: '+2348031234412',
    phoneVerifiedAt: new Date('2026-10-01T00:00:00Z'),
    emailVerified: false,
    verificationTier: 'basic',
    trustScore: 0,
    status: 'active',
    creatorVerifiedAt: null,
    creatorVerifiedUntil: null,
    professionalVerifiedAt: null,
    professionalVerifiedUntil: null,
  };

  let codeHash: string;
  beforeAll(async () => {
    codeHash = await argon2.hash('123456');
  });

  function build() {
    const update = jest.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...row, ...args.data }),
    );
    const prisma = {
      wawuUser: {
        findUnique: jest.fn().mockResolvedValue(row),
        findFirst: jest.fn().mockResolvedValue(null),
        update,
      },
      phoneChangeRequest: {
        findFirst: jest.fn().mockResolvedValue({
          newPhone: '08099900011',
          codeHash,
          expiresAt: new Date(Date.now() + 60_000),
        }),
        deleteMany: jest.fn(),
      },
      $transaction: jest.fn((ops: Array<Promise<unknown>>) => Promise.all(ops)),
    };
    const service = new AuthService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      { get: () => undefined } as never,
    );
    return { service, update };
  }

  it('updatePhone writes the phone and leaves the proof alone', async () => {
    const { service, update } = build();
    await service.updatePhone('u1', '08099900011');
    expect(update.mock.calls[0][0].data).toEqual({ phone: '08099900011' });
  });

  it('confirmPhoneChange writes the phone and leaves the proof alone', async () => {
    const { service, update } = build();
    await service.confirmPhoneChange('u1', '123456');
    expect(update.mock.calls[0][0].data).toEqual({ phone: '08099900011' });
  });
});
