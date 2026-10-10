import type { WawuUser } from '@prisma/client';
import { TokensService } from './tokens.service';

/**
 * JOIN-03: the access token says which of the account's two contacts WAWU ID
 * has proven, so a resource server never has to trust a typed phone or email.
 * `emailVerified` is the account's `email_verified` and only with an email on
 * it; `phoneVerified` is `phone_verified_at` being set AND the number it was
 * set for (`phone_verified_for`) still being the account's phone (round 2, D1:
 * the internal phone-change routes write a new number and leave
 * `phone_verified_at` alone).
 */
const user = (over: Partial<WawuUser>): WawuUser =>
  ({
    id: 'u1',
    email: 'ada@example.test',
    emailVerified: false,
    phone: '+2348031234567',
    phoneVerifiedAt: null,
    phoneVerifiedFor: null,
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
    expect(
      payload(
        user({
          phoneVerifiedAt: new Date(),
          phoneVerifiedFor: '+2348031234567',
        }),
      ),
    ).toMatchObject({ emailVerified: false, phoneVerified: true });
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

  describe('round 2, D1: a phone nobody proved is never vouched for', () => {
    const proven = {
      phoneVerifiedAt: new Date(),
      phoneVerifiedFor: '+2348031234567',
    };

    it('says false after the phone was changed through an internal route, with phone_verified_at still set', () => {
      // PATCH /internal/users/:id/phone writes the digits and nothing else.
      expect(
        payload(user({ ...proven, phone: '2348099999999' })),
      ).toMatchObject({ phone: '2348099999999', phoneVerified: false });
      // The same for the request and confirm pair (a code mailed to the account's own address).
      expect(
        payload(user({ ...proven, phone: '+2348077777777' })),
      ).toMatchObject({ phoneVerified: false });
    });

    it('stays true when the account holds the number it proved, written another way', () => {
      for (const written of ['08031234567', '2348031234567', '+2348031234567'])
        expect(payload(user({ ...proven, phone: written }))).toMatchObject({
          phoneVerified: true,
        });
      expect(
        payload(
          user({
            phoneVerifiedAt: new Date(),
            phoneVerifiedFor: '08031234567',
            phone: '+2348031234567',
          }),
        ),
      ).toMatchObject({ phoneVerified: true });
    });

    it('says false when phone_verified_at is set but no number was recorded', () => {
      expect(
        payload(user({ phoneVerifiedAt: new Date(), phoneVerifiedFor: null })),
      ).toMatchObject({ phoneVerified: false });
    });

    it('says false when a number is recorded but phone_verified_at is empty', () => {
      expect(
        payload(
          user({ phoneVerifiedAt: null, phoneVerifiedFor: '+2348031234567' }),
        ),
      ).toMatchObject({ phoneVerified: false });
    });

    it('a released or deleted marker never matches the number it replaced', () => {
      expect(payload(user({ ...proven, phone: 'released:u1' }))).toMatchObject({
        phone: '',
        phoneVerified: false,
      });
      expect(payload(user({ ...proven, phone: 'deleted:u1' }))).toMatchObject({
        phoneVerified: false,
      });
    });

    it('a number that only looks like the proved one is a different number', () => {
      expect(
        payload(user({ ...proven, phone: '+2348031234568' })),
      ).toMatchObject({ phoneVerified: false });
      expect(
        payload(user({ ...proven, phone: '+23480312345670' })),
      ).toMatchObject({ phoneVerified: false });
    });

    it('does not change the email proof or any other claim', () => {
      const changed = payload(
        user({ ...proven, phone: '2348099999999', emailVerified: true }),
      );
      expect(changed).toMatchObject({
        emailVerified: true,
        phoneVerified: false,
        status: 'active',
      });
    });
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
