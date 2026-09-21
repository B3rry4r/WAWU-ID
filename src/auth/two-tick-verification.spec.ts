import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { InternalController } from './internal.controller';

/**
 * GRANTING AND REVOKING THE TWO TICKS.
 *
 * Driven through the controller rather than the service, because the route is
 * what the Hub actually calls: the service key, the DTO field names and the
 * response envelope are all part of what has to stay true across three repos.
 *
 * What these assert, in order of how much it would cost to get wrong:
 *   - a grant writes an expiry and the response says the tick draws
 *   - a revoke clears the tick, and clears only the one named
 *   - the other tick is never touched: one person can hold both
 *   - a row as the backfill leaves it reads back as a PERPETUAL professional
 *     tick, which is the whole point of grandfathering the old ladder
 */

const SERVICE_KEY = 'test-service-key';

/** A user row with no ticks, as a fresh signup sits in the table. */
function baseUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    email: 'ada@wawuafrica.com',
    phone: '2348000000001',
    firstName: 'Ada',
    middleName: null,
    lastName: 'Obi',
    country: 'Nigeria',
    state: null,
    gender: null,
    verificationTier: 'basic',
    trustScore: 0,
    status: 'active',
    creatorVerifiedAt: null,
    creatorVerifiedUntil: null,
    professionalVerifiedAt: null,
    professionalVerifiedUntil: null,
    ...overrides,
  };
}

/**
 * Controller + real AuthService over a prisma double whose `update` applies
 * the patch to the row, so the response under test is derived from what was
 * actually written rather than from a canned return value.
 */
function build(row: Record<string, unknown>) {
  const update = jest.fn(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ ...row, ...data }),
  );
  const prisma = {
    wawuUser: {
      findUnique: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue([row]),
      update,
    },
  };
  const mail = { sendAccountApproved: jest.fn().mockResolvedValue(undefined) };
  const service = new AuthService(
    prisma as never,
    {} as never,
    {} as never,
    mail as never,
    { get: () => undefined } as never,
  );
  const controller = new InternalController(service, {
    get: (key: string) =>
      key === 'INTERNAL_SERVICE_KEY' ? SERVICE_KEY : undefined,
  } as never);
  return { controller, service, prisma, update, mail };
}

describe('PATCH /internal/users/:userId/verification (grant)', () => {
  it('stamps the expiry the tick was bought to and reports it as drawn', async () => {
    const { controller, update } = build(baseUser());

    const res = await controller.updateVerification(
      'u1',
      {
        tick: 'creator',
        granted: true,
        expiresAt: '2027-09-21T00:00:00.000Z',
      },
      SERVICE_KEY,
    );

    const written = update.mock.calls[0][0].data;
    expect(written.creatorVerifiedAt).toBeInstanceOf(Date);
    expect((written.creatorVerifiedUntil as Date).toISOString()).toBe(
      '2027-09-21T00:00:00.000Z',
    );

    expect(res.data.verification.creator).toEqual({
      verified: true,
      expiresAt: '2027-09-21T00:00:00.000Z',
    });
  });

  it('leaves the other tick exactly as it found it', async () => {
    const { controller, update } = build(baseUser());

    const res = await controller.updateVerification(
      'u1',
      { tick: 'creator', granted: true, expiresAt: '2027-09-21T00:00:00.000Z' },
      SERVICE_KEY,
    );

    const written = update.mock.calls[0][0].data;
    expect(written).not.toHaveProperty('professionalVerifiedAt');
    expect(written).not.toHaveProperty('professionalVerifiedUntil');
    expect(res.data.verification.professional).toEqual({
      verified: false,
      expiresAt: null,
    });
  });

  it('grants a perpetual tick when no expiry is named', async () => {
    const { controller, update } = build(baseUser());

    const res = await controller.updateVerification(
      'u1',
      { tick: 'professional', granted: true },
      SERVICE_KEY,
    );

    expect(update.mock.calls[0][0].data.professionalVerifiedUntil).toBeNull();
    expect(res.data.verification.professional).toEqual({
      verified: true,
      expiresAt: null,
    });
  });

  it('still carries the legacy verificationTier field, untouched', async () => {
    const { controller } = build(baseUser({ verificationTier: 'basic' }));

    const res = await controller.updateVerification(
      'u1',
      { tick: 'creator', granted: true, expiresAt: '2027-09-21T00:00:00.000Z' },
      SERVICE_KEY,
    );

    expect(res.data.verificationTier).toBe('basic');
  });

  it('refuses a caller without the service key, and writes nothing', async () => {
    const { controller, update } = build(baseUser());

    await expect(
      controller.updateVerification(
        'u1',
        { tick: 'creator', granted: true },
        'wrong-key',
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(update).not.toHaveBeenCalled();
  });

  it('404s on an unknown user rather than creating one', async () => {
    const { controller, prisma, update } = build(baseUser());
    prisma.wawuUser.findUnique.mockResolvedValue(null);

    await expect(
      controller.updateVerification(
        'nobody',
        { tick: 'creator', granted: true },
        SERVICE_KEY,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('PATCH /internal/users/:userId/verification (revoke)', () => {
  const held = baseUser({
    creatorVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    creatorVerifiedUntil: new Date('2027-01-01T00:00:00.000Z'),
    professionalVerifiedAt: new Date('2026-02-01T00:00:00.000Z'),
    professionalVerifiedUntil: new Date('2027-02-01T00:00:00.000Z'),
  });

  it('clears both columns of the named tick, so it reads as no tick at all', async () => {
    const { controller, update } = build({ ...held });

    const res = await controller.updateVerification(
      'u1',
      { tick: 'creator', granted: false },
      SERVICE_KEY,
    );

    expect(update.mock.calls[0][0].data).toEqual({
      creatorVerifiedAt: null,
      creatorVerifiedUntil: null,
    });
    expect(res.data.verification.creator).toEqual({
      verified: false,
      expiresAt: null,
    });
  });

  it('does not take the other tick down with it', async () => {
    const { controller } = build({ ...held });

    const res = await controller.updateVerification(
      'u1',
      { tick: 'creator', granted: false },
      SERVICE_KEY,
    );

    expect(res.data.verification.professional).toEqual({
      verified: true,
      expiresAt: '2027-02-01T00:00:00.000Z',
    });
  });

  it('ignores an expiry sent alongside a revoke', async () => {
    const { controller, update } = build({ ...held });

    await controller.updateVerification(
      'u1',
      {
        tick: 'professional',
        granted: false,
        expiresAt: '2030-01-01T00:00:00.000Z',
      },
      SERVICE_KEY,
    );

    expect(update.mock.calls[0][0].data).toEqual({
      professionalVerifiedAt: null,
      professionalVerifiedUntil: null,
    });
  });

  it('sends no account-approved email on a revoke', async () => {
    const { controller, mail } = build({ ...held });

    await controller.updateVerification(
      'u1',
      { tick: 'creator', granted: false },
      SERVICE_KEY,
    );

    expect(mail.sendAccountApproved).not.toHaveBeenCalled();
  });
});

/**
 * The grandfathering promise, checked end to end.
 *
 * 20260921120000_add_two_tick_verification sets professional_verified_at =
 * CURRENT_TIMESTAMP and leaves professional_verified_until NULL for every row
 * on one of the four trusted tiers. Those accounts never paid an annual fee,
 * so a tick that quietly lapsed a year later would take away a badge nobody
 * was ever charged for.
 */
describe('a row as the backfill leaves it', () => {
  const backfilled = baseUser({
    verificationTier: 'certified_professional',
    professionalVerifiedAt: new Date('2026-09-21T12:00:00.000Z'),
    professionalVerifiedUntil: null,
  });

  it('reads back as a perpetual professional tick, with no creator tick', async () => {
    const { controller, prisma } = build(backfilled);
    prisma.wawuUser.findMany.mockResolvedValue([
      {
        id: 'u1',
        firstName: 'Ada',
        lastName: 'Obi',
        verificationTier: 'certified_professional',
        creatorVerifiedAt: null,
        creatorVerifiedUntil: null,
        professionalVerifiedAt: new Date('2026-09-21T12:00:00.000Z'),
        professionalVerifiedUntil: null,
      },
    ]);

    const res = await controller.lookupUsers(
      { ids: ['11111111-1111-4111-8111-111111111111'] },
      SERVICE_KEY,
    );

    expect(res.data[0].verification).toEqual({
      creator: { verified: false, expiresAt: null },
      professional: { verified: true, expiresAt: null },
    });
  });

  it('is still verified long after a paid year would have run out', async () => {
    const { service } = build(backfilled);

    const res = await service.setVerification('u1', 'creator', false);

    // The professional tick was not touched by the creator revoke, and it has
    // no expiry to outlive.
    expect(res.verification.professional).toEqual({
      verified: true,
      expiresAt: null,
    });
  });
});
