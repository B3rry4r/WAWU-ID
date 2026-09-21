import { deriveVerification, TICK_COLUMNS } from './verification.util';

/**
 * THE ONE DATE COMPARISON IN THIS SERVICE.
 *
 * `verified` is not a column. If this function is wrong, every badge in the
 * ecosystem is wrong in the same direction at once: a tick drawn for an
 * account that stopped paying, or withheld from one that did. Four states
 * exist and all four are checked here, on both ticks, because the two are
 * independent and a bug that mixes them up would draw a green tick for a
 * purple grant.
 */
describe('deriveVerification', () => {
  const now = new Date('2026-09-21T12:00:00.000Z');

  it('draws the tick while the paid year is still running', () => {
    const state = deriveVerification(
      {
        creatorVerifiedAt: new Date('2026-03-01T00:00:00.000Z'),
        creatorVerifiedUntil: new Date('2027-03-01T00:00:00.000Z'),
        professionalVerifiedAt: null,
        professionalVerifiedUntil: null,
      },
      now,
    );

    expect(state.creator).toEqual({
      verified: true,
      expiresAt: '2027-03-01T00:00:00.000Z',
    });
  });

  it('drops the tick the moment the expiry is behind us, without anything having to run', () => {
    const state = deriveVerification(
      {
        creatorVerifiedAt: new Date('2025-03-01T00:00:00.000Z'),
        creatorVerifiedUntil: new Date('2026-03-01T00:00:00.000Z'),
        professionalVerifiedAt: null,
        professionalVerifiedUntil: null,
      },
      now,
    );

    // Still reports WHEN it lapsed: the client shows "renew", not "never had one".
    expect(state.creator).toEqual({
      verified: false,
      expiresAt: '2026-03-01T00:00:00.000Z',
    });
  });

  it('treats an expiry of exactly now as over, not as still running', () => {
    const state = deriveVerification(
      {
        creatorVerifiedAt: new Date('2025-09-21T12:00:00.000Z'),
        creatorVerifiedUntil: new Date(now),
        professionalVerifiedAt: null,
        professionalVerifiedUntil: null,
      },
      now,
    );

    expect(state.creator.verified).toBe(false);
  });

  it('reads a null expiry as perpetual, not as expired', () => {
    const state = deriveVerification(
      {
        creatorVerifiedAt: null,
        creatorVerifiedUntil: null,
        professionalVerifiedAt: new Date('2024-01-01T00:00:00.000Z'),
        professionalVerifiedUntil: null,
      },
      now,
    );

    expect(state.professional).toEqual({ verified: true, expiresAt: null });
  });

  it('reads a row that was never granted anything as two blank ticks', () => {
    const state = deriveVerification(
      {
        creatorVerifiedAt: null,
        creatorVerifiedUntil: null,
        professionalVerifiedAt: null,
        professionalVerifiedUntil: null,
      },
      now,
    );

    expect(state).toEqual({
      creator: { verified: false, expiresAt: null },
      professional: { verified: false, expiresAt: null },
    });
  });

  it('keeps the two ticks independent: both can be held at once', () => {
    const state = deriveVerification(
      {
        creatorVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
        creatorVerifiedUntil: new Date('2027-01-01T00:00:00.000Z'),
        professionalVerifiedAt: new Date('2026-05-01T00:00:00.000Z'),
        professionalVerifiedUntil: new Date('2027-05-01T00:00:00.000Z'),
      },
      now,
    );

    expect(state.creator.verified).toBe(true);
    expect(state.professional.verified).toBe(true);
  });

  it('does not let one lapsed tick take the other down with it', () => {
    const state = deriveVerification(
      {
        creatorVerifiedAt: new Date('2025-01-01T00:00:00.000Z'),
        creatorVerifiedUntil: new Date('2026-01-01T00:00:00.000Z'),
        professionalVerifiedAt: new Date('2026-05-01T00:00:00.000Z'),
        professionalVerifiedUntil: new Date('2027-05-01T00:00:00.000Z'),
      },
      now,
    );

    expect(state.creator.verified).toBe(false);
    expect(state.professional.verified).toBe(true);
  });

  it('maps each tick name to its own pair of columns', () => {
    expect(TICK_COLUMNS.creator).toEqual({
      at: 'creatorVerifiedAt',
      until: 'creatorVerifiedUntil',
    });
    expect(TICK_COLUMNS.professional).toEqual({
      at: 'professionalVerifiedAt',
      until: 'professionalVerifiedUntil',
    });
  });
});
