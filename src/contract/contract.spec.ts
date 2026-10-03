import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WawuUser } from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import { AFTER_PHONE_STEPS } from '../auth/signup-sequence';
import { buildContract, contractText } from './build-contract';

type Schema = {
  properties?: Record<string, { enum?: string[]; items?: { enum?: string[] } }>;
  required?: string[];
};

describe('the published contract (contract/openapi.json)', () => {
  let doc: Awaited<ReturnType<typeof buildContract>>;
  const schema = (name: string) =>
    doc.components?.schemas?.[name] as unknown as Schema;

  beforeAll(async () => {
    doc = await buildContract();
  });

  it('is exactly what the code describes (run `npm run contract:build` after a change)', () => {
    const file = readFileSync(
      resolve(__dirname, '../../contract/openapi.json'),
      'utf8',
    );
    expect(contractText(doc)).toBe(file);
  });

  it('holds every route the app calls, and only those', () => {
    const ops = Object.entries(doc.paths).flatMap(([path, item]) =>
      Object.keys(item).map((m) => `${m.toUpperCase()} ${path}`),
    );
    expect(ops.sort()).toEqual(
      [
        'POST /auth/login',
        'POST /auth/refresh',
        'POST /auth/forgot-password',
        'POST /auth/signup',
        'POST /auth/phone/verify/start',
        'POST /auth/phone/verify/confirm',
        'POST /auth/signup/resume',
        'GET /auth/signup/progress',
        'POST /auth/signup/progress',
        'POST /auth/signup/email/start',
        'POST /auth/signup/email/confirm',
      ].sort(),
    );
    // Nothing internal or web-only leaks in.
    expect(JSON.stringify(doc)).not.toMatch(
      /internal|RegisterDto|X-Service-Key/,
    );
  });

  it("describes the sign-in answer's user with exactly the keys the service sends", async () => {
    const user = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'a@example.test',
      phone: '+2348031234412',
      firstName: 'Ada',
      middleName: null,
      lastName: 'Obi',
      country: 'NG',
      state: null,
      gender: null,
      occupation: null,
      accountType: 'creator',
      verificationTier: 'basic',
      trustScore: 0,
      creatorVerifiedAt: null,
      creatorVerifiedUntil: null,
      professionalVerifiedAt: null,
      professionalVerifiedUntil: null,
      status: 'active',
    } as unknown as WawuUser;
    const auth = new AuthService(
      {} as never,
      {
        issueTokens: () =>
          Promise.resolve({ accessToken: 'a', refreshToken: 'r' }),
      } as never,
      {} as never,
      {} as never,
      { get: () => undefined } as never,
    );
    const session = await auth.sessionFor(user);
    expect(Object.keys(session).sort()).toEqual(
      Object.keys(schema('Session').properties ?? {}).sort(),
    );
    expect(Object.keys(session.user).sort()).toEqual(
      Object.keys(schema('SessionUser').properties ?? {}).sort(),
    );
    // accountType is the one optional key: an account without one has none.
    expect(schema('SessionUser').required).not.toContain('accountType');
    const without = await auth.sessionFor({ ...user, accountType: null });
    expect('accountType' in without.user).toBe(false);
  });

  it('names the same steps the server enforces', () => {
    const steps = schema('SignupProgressSchema').properties ?? {};
    expect(steps.step.enum).toEqual([...AFTER_PHONE_STEPS, 'done']);
    expect(steps.steps.items?.enum).toEqual([...AFTER_PHONE_STEPS]);
    expect(schema('SignupProgressDto').properties?.step.enum).toEqual([
      ...AFTER_PHONE_STEPS,
    ]);
  });
});
