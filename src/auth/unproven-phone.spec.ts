import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { fakePrisma, type UserRow } from '../testing/fake-signup-prisma';
import { AuthService } from './auth.service';
import {
  applyClashPlan,
  holdsUnprovenPhone,
  numberHeld,
  planClashes,
  takeProvenNumber,
  type Clash,
} from './unproven-phone';

/**
 * A phone is held only once it is proven, and changes hands only when a newer
 * sign-up proves it (AUTH-07 rounds 2 and 3). The sign-up services' behaviour
 * is in their own specs; this holds the rule itself, the one write that gives
 * a number up, and the three places that would otherwise read a number nobody
 * proved as a way to reach its account.
 */
describe('a phone is held only once it is proven', () => {
  const EMAIL = 'new@example.test';
  const PHONE = '+2348031234412';
  const VARIANTS = [PHONE, '08031234412', '2348031234412'];

  const account = (over: Partial<Clash> = {}): Clash => ({
    id: 'a1',
    email: 'someone@example.test',
    phone: PHONE,
    emailVerified: true,
    phoneVerifiedAt: null,
    phoneVerification: null,
    signupProgress: null,
    ...over,
  });

  describe('holdsUnprovenPhone', () => {
    it('is true for an account that finished a mailed sign-up and never proved its number', () => {
      expect(
        holdsUnprovenPhone({ phoneVerifiedAt: null, signupProgress: {} }),
      ).toBe(true);
    });

    it('is false once the number is proven, in the sequence or not', () => {
      expect(
        holdsUnprovenPhone({
          phoneVerifiedAt: new Date(),
          signupProgress: {},
        }),
      ).toBe(false);
      expect(
        holdsUnprovenPhone({
          phoneVerifiedAt: new Date(),
          signupProgress: null,
        }),
      ).toBe(false);
    });

    it('is false for a long-standing account that was never in the sign-up sequence', () => {
      expect(holdsUnprovenPhone({ phoneVerifiedAt: null })).toBe(false);
      expect(
        holdsUnprovenPhone({ phoneVerifiedAt: null, signupProgress: null }),
      ).toBe(false);
    });
  });

  describe('planClashes', () => {
    it('plans nothing when nobody holds the email or the number', () => {
      const plan = planClashes([], EMAIL, VARIANTS);
      expect(plan).toEqual({
        remove: [],
        typedHolders: [],
        claimEmail: false,
      });
      expect(numberHeld(plan)).toBe(false);
    });

    it('removes an unconfirmed sign-up, as it always did', () => {
      const pending = account({ phoneVerification: { id: 'p' } });
      expect(planClashes([pending], EMAIL, VARIANTS).remove).toEqual(['a1']);
    });

    it('takes nothing from an account that only typed its number, in any of its written forms: the new sign-up goes ahead without the number', () => {
      for (const phone of VARIANTS) {
        const typed = account({ phone, signupProgress: {} });
        const plan = planClashes([typed], EMAIL, VARIANTS);
        expect(plan).toEqual({
          remove: [],
          typedHolders: ['a1'],
          claimEmail: false,
        });
        expect(numberHeld(plan)).toBe(true);
      }
    });

    it('refuses a number that was proven', () => {
      const proven = account({
        phoneVerifiedAt: new Date(),
        signupProgress: {},
      });
      expect(() => planClashes([proven], EMAIL, VARIANTS)).toThrow(
        ConflictException,
      );
    });

    it('refuses a number on a long-standing account (it is not in the sign-up sequence)', () => {
      expect(() => planClashes([account()], EMAIL, VARIANTS)).toThrow(
        ConflictException,
      );
    });

    it('refuses the same email with the same number: that is an account that exists', () => {
      const same = account({ email: EMAIL, signupProgress: {} });
      expect(() => planClashes([same], EMAIL, VARIANTS)).toThrow(
        ConflictException,
      );
    });

    it('refuses an email an account holds, whatever else is in the way', () => {
      const typed = account({ id: 'typed', signupProgress: {} });
      const emailHolder = account({
        id: 'mail',
        email: EMAIL,
        phone: '+2348099900011',
      });
      expect(() => planClashes([typed, emailHolder], EMAIL, VARIANTS)).toThrow(
        ConflictException,
      );
    });

    it('still lets a person claim an email a phone-proven mobile account never proved', () => {
      const holder = account({
        email: EMAIL,
        phone: '+2348077700022',
        emailVerified: false,
        phoneVerifiedAt: new Date(),
      });
      expect(planClashes([holder], EMAIL, VARIANTS)).toEqual({
        remove: [],
        typedHolders: [],
        claimEmail: true,
      });
    });
  });

  describe('applyClashPlan', () => {
    it('removes the unconfirmed sign-ups in the way and writes to no other account', async () => {
      const calls: Array<[string, unknown]> = [];
      const client = {
        wawuUser: {
          deleteMany: (arg: unknown) => {
            calls.push(['deleteMany', arg]);
            return Promise.resolve({ count: 1 });
          },
          updateMany: (arg: unknown) => {
            calls.push(['updateMany', arg]);
            return Promise.resolve({ count: 1 });
          },
          update: (arg: unknown) => {
            calls.push(['update', arg]);
            return Promise.resolve({});
          },
        },
      } as never;
      await applyClashPlan(client, {
        remove: ['gone'],
        typedHolders: ['a1'],
        claimEmail: false,
      });
      expect(calls).toEqual([['deleteMany', { where: { id: 'gone' } }]]);
    });
  });

  describe('takeProvenNumber (a newer sign-up proved the number)', () => {
    const row = (over: Partial<UserRow> = {}): UserRow => ({
      id: 'a1',
      email: 'someone@example.test',
      phone: PHONE,
      emailVerified: true,
      phoneVerifiedAt: null,
      passwordHash: 'x',
      occupation: null,
      accountType: null,
      phoneVerification: null,
      ...over,
    });
    const newcomer = row({
      id: 'new',
      email: EMAIL,
      phone: 'released:new',
      emailVerified: false,
    });

    function world(...others: UserRow[]) {
      const prisma = fakePrisma();
      prisma.users.push(...others, newcomer);
      return prisma;
    }
    const take = (prisma: ReturnType<typeof fakePrisma>) =>
      takeProvenNumber(prisma as never, 'new', VARIANTS);

    it('makes an account that only typed the number give it up, in any of its written forms, and keeps everything else of it', async () => {
      for (const phone of VARIANTS) {
        const typed = row({ phone });
        const prisma = world(typed);
        prisma.progress.push('a1');
        await take(prisma);
        expect(typed).toMatchObject({
          phone: 'released:a1',
          email: 'someone@example.test',
          emailVerified: true,
          passwordHash: 'x',
        });
      }
    });

    it('removes an unconfirmed sign-up that holds the number', async () => {
      const pending = row({
        phoneVerification: { id: 'c1' } as never,
        emailVerified: false,
      });
      const prisma = world(pending);
      await take(prisma);
      expect(prisma.users.map((u) => u.id)).toEqual(['new']);
    });

    it('refuses, and changes nothing, when the number is proven', async () => {
      const proven = row({ phoneVerifiedAt: new Date() });
      const prisma = world(proven);
      prisma.progress.push('a1');
      await expect(take(prisma)).rejects.toBeInstanceOf(ConflictException);
      expect(proven.phone).toBe(PHONE);
    });

    it('refuses, and changes nothing, for a long-standing account that is not in the sign-up sequence', async () => {
      const web = row();
      const prisma = world(web);
      await expect(take(prisma)).rejects.toBeInstanceOf(ConflictException);
      expect(web.phone).toBe(PHONE);
    });

    it('refuses as taken when the number was proven or changed between the read and the write', async () => {
      const typed = row();
      const prisma = world(typed);
      prisma.progress.push('a1');
      // proven in the very moment between the lookup and the guarded write
      const real = prisma.wawuUser.updateMany;
      prisma.wawuUser.updateMany = (arg: never) => {
        typed.phoneVerifiedAt = new Date();
        return real(arg);
      };
      await expect(take(prisma)).rejects.toBeInstanceOf(ConflictException);
      expect(typed.phone).toBe(PHONE);
    });

    it('never touches the account that is taking the number', async () => {
      const prisma = world();
      await take(prisma);
      expect(newcomer.phone).toBe('released:new');
      expect(prisma.users).toHaveLength(1);
    });
  });

  // ── what must not read a number nobody proved ──────────────────────────────

  describe('a number the account only typed is not a way to reach the account', () => {
    const typed = {
      id: 'u1',
      email: 'ada@example.test',
      phone: '+2348031234412',
      firstName: 'Ada',
      emailVerified: true,
      phoneVerifiedAt: null,
      passwordHash: 'x',
      signupProgress: { userId: 'u1' },
      phoneVerification: null,
    };
    const web = { ...typed, signupProgress: null };
    const proven = { ...typed, phoneVerifiedAt: new Date() };

    /**
     * As Prisma answers a lookup: a relation is on the row only when the call
     * asks for it with `include`. A stub that handed every call the sign-up
     * sequence would pass whether or not the guard ever loaded it (round 2's
     * D2: five guards were held by nothing for that reason).
     */
    const answering = (user: Record<string, unknown> | null) =>
      jest.fn((args?: { include?: Record<string, unknown> }) => {
        if (!user) return Promise.resolve(null);
        const { signupProgress, phoneVerification, ...bare } = user;
        return Promise.resolve({
          ...bare,
          ...(args?.include?.phoneVerification ? { phoneVerification } : {}),
          ...(args?.include?.signupProgress ? { signupProgress } : {}),
        });
      });

    function build(user: Record<string, unknown> | null) {
      const prisma = {
        wawuUser: {
          findFirst: answering(user),
          findUnique: answering(user),
          create: jest.fn().mockResolvedValue(user),
          update: jest.fn().mockResolvedValue(user),
        },
        refreshToken: { deleteMany: jest.fn() },
      };
      const otp = {
        generateAndSend: jest.fn().mockResolvedValue(undefined),
        verify: jest.fn().mockResolvedValue(true),
      };
      const tokens = {
        issueTokens: jest
          .fn()
          .mockResolvedValue({ accessToken: 'a', refreshToken: 'r' }),
      };
      const auth = new AuthService(
        prisma as never,
        tokens as never,
        otp as never,
        {} as never,
        { get: () => undefined } as never,
      );
      return { auth, prisma, otp, tokens };
    }

    it('sends no reset code to it', async () => {
      const { auth, otp } = build(typed);
      const answer = await auth.forgotPassword(typed.phone, 'sms');
      expect(answer).toEqual({
        message: 'If an account exists, a reset code has been sent.',
      });
      expect(otp.generateAndSend).not.toHaveBeenCalled();
    });

    it('still sends one to a long-standing account, or one whose number was proven', async () => {
      for (const user of [web, proven]) {
        const { auth, otp } = build(user);
        await auth.forgotPassword(typed.phone, 'sms');
        expect(otp.generateAndSend).toHaveBeenCalledTimes(1);
      }
    });

    it('does not reset a password with a code for it, and answers as for any wrong code', async () => {
      const { auth, prisma } = build(typed);
      const err = await auth
        .resetPassword({
          identifier: typed.phone,
          code: '123456',
          newPassword: 'a-brand-new-password',
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as UnauthorizedException).message).toBe(
        'Invalid or expired reset code',
      );
      expect(prisma.wawuUser.update).not.toHaveBeenCalled();
    });

    it('does not sign in to the account with a code for it', async () => {
      const { auth, tokens } = build(typed);
      const err = await auth
        .otpVerify(typed.phone, '123456')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as UnauthorizedException).message).toBe(
        'Invalid or expired OTP',
      );
      expect(tokens.issueTokens).not.toHaveBeenCalled();
    });

    it('is unchanged for a long-standing account and for one whose number was proven', async () => {
      for (const user of [web, proven]) {
        const reset = build(user);
        const out = await reset.auth.resetPassword({
          identifier: typed.phone,
          code: '123456',
          newPassword: 'a-brand-new-password',
        });
        expect(out).toHaveProperty('accessToken', 'a');
        const otp = build(user);
        expect(await otp.auth.otpVerify(typed.phone, '123456')).toHaveProperty(
          'accessToken',
          'a',
        );
      }
    });
  });
});
