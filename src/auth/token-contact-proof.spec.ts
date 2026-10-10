import type { WawuUser } from '@prisma/client';
import { TokensService } from './tokens.service';

/**
 * JOIN-03: the access token says which of the account's two contacts WAWU ID
 * has proven, so a resource server never has to trust a typed phone or email.
 * `emailVerified` is the account's `email_verified` and only with an email on
 * it; `phoneVerified` is `phone_verified_at` being set.
 */
const user = (over: Partial<WawuUser>): WawuUser =>
  ({
    id: 'u1',
    email: 'ada@example.test',
    emailVerified: false,
    phone: '+2348031234567',
    phoneVerifiedAt: null,
    firstName: 'Ada',
    middleName: null,
    lastName: 'Obi',
    country: 'Nigeria',
    verificationTier: 'basic',
    trustScore: 0,
    creatorVerifiedAt: null,
    creatorVerifiedUntil: null,
    professionalVerifiedAt: null,
    professionalVerifiedUntil: null,
    status: 'active',
    wawuafricaAppUserId: null,
    onboardingRef: null,
    beautyUserId: null,
    basketUserId: null,
    ...over,
  }) as unknown as WawuUser;

const payload = (u: WawuUser) =>
  (
    new TokensService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    ) as unknown as {
      buildAccessPayload(x: WawuUser): Record<string, unknown>;
    }
  ).buildAccessPayload(u);

describe('the access token says which contact is proven (JOIN-03)', () => {
  it('a web sign-up with a confirmed email and a typed phone proves the email only', () => {
    expect(payload(user({ emailVerified: true }))).toMatchObject({
      emailVerified: true,
      phoneVerified: false,
    });
  });

  it('a mobile sign-up that entered the phone code proves the phone, and not the email it never confirmed', () => {
    expect(payload(user({ phoneVerifiedAt: new Date() }))).toMatchObject({
      emailVerified: false,
      phoneVerified: true,
    });
  });

  it('an email-code sign-up (AUTH-07) proves the email and leaves the phone unproven', () => {
    expect(
      payload(user({ emailVerified: true, phoneVerifiedAt: null })),
    ).toMatchObject({ emailVerified: true, phoneVerified: false });
  });

  it('proves nothing for an account whose contacts were only typed', () => {
    expect(payload(user({}))).toMatchObject({
      emailVerified: false,
      phoneVerified: false,
    });
  });

  it('never calls an absent email proven, whatever the flag says', () => {
    expect(payload(user({ email: null, emailVerified: true }))).toMatchObject({
      emailVerified: false,
    });
  });

  it('a released phone (`released:<id>`, never proven) is an empty phone and not proven', () => {
    expect(
      payload(
        user({
          phone: 'released:u1',
          phoneVerifiedAt: null,
          emailVerified: true,
        }),
      ),
    ).toMatchObject({ phone: '', phoneVerified: false, emailVerified: true });
  });

  it('keeps every claim it had: email, phone, ticks, status', () => {
    const p = payload(user({ emailVerified: true }));
    for (const k of [
      'sub',
      'email',
      'phone',
      'firstName',
      'verification',
      'status',
    ])
      expect(p).toHaveProperty(k);
  });
});
