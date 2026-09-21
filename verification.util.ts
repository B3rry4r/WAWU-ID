/**
 * The two-tick verification model — WAWU ID's single derivation point.
 *
 * There is no five-step ladder. There are exactly TWO verifications, and they
 * are INDEPENDENT of each other because one person can hold both roles:
 *
 *   creator       purple tick   NGN 4,999 / year
 *   professional  green tick    NGN 9,999 / year
 *
 * Both ticks render when both are held. Nothing here picks a "winner" and
 * nothing collapses the pair into one badge.
 *
 * Storage is four nullable columns on `wawu_users` (see
 * 20260921120000_add_two_tick_verification). `verified` is NEVER a column: it
 * is derived from the expiry, server-side, by the one function below. A client
 * that compares dates itself draws a tick an hour after the money stopped.
 *
 * The derivation lives here once, and every read path calls it. Two copies of
 * a date comparison are two chances to disagree about who is verified.
 */

/** The two ticks, by the names the wire and the internal API use. */
export const VERIFICATION_TICKS = ['creator', 'professional'] as const;

export type VerificationTickName = (typeof VERIFICATION_TICKS)[number];

/**
 * One tick as it appears on the wire.
 *
 * `expiresAt === null` with `verified === true` means a perpetual,
 * admin-granted tick (a grandfathered account). `expiresAt === null` with
 * `verified === false` simply means the tick was never granted.
 */
export interface TickState {
  verified: boolean;
  /** ISO 8601, or null for perpetual / never granted. */
  expiresAt: string | null;
}

export interface VerificationState {
  /** Purple. */
  creator: TickState;
  /** Green. */
  professional: TickState;
}

/**
 * The four columns this module reads. Declared structurally so a Prisma
 * `select` of just these fields satisfies it as readily as a whole user row.
 */
export interface VerificationColumns {
  creatorVerifiedAt: Date | null;
  creatorVerifiedUntil: Date | null;
  professionalVerifiedAt: Date | null;
  professionalVerifiedUntil: Date | null;
}

/** The one date comparison in this service. Everything else calls through. */
function toTickState(
  verifiedAt: Date | null | undefined,
  verifiedUntil: Date | null | undefined,
  now: Date,
): TickState {
  const grantedAt = verifiedAt ?? null;
  const until = verifiedUntil ?? null;

  if (grantedAt === null) {
    return { verified: false, expiresAt: null };
  }

  // A null expiry is perpetual, not expired: that is how a grandfathered row
  // backfilled from the old ladder reads.
  const verified = until === null || until.getTime() > now.getTime();

  return { verified, expiresAt: until === null ? null : until.toISOString() };
}

/**
 * Turn a user row's four verification columns into the wire shape.
 *
 * `now` is injectable so a test can stand on either side of an expiry without
 * waiting a year; production callers pass nothing.
 */
export function deriveVerification(
  user: Partial<VerificationColumns> | null | undefined,
  now: Date = new Date(),
): VerificationState {
  return {
    creator: toTickState(
      user?.creatorVerifiedAt,
      user?.creatorVerifiedUntil,
      now,
    ),
    professional: toTickState(
      user?.professionalVerifiedAt,
      user?.professionalVerifiedUntil,
      now,
    ),
  };
}

/**
 * The column names behind one tick. Used by the internal grant/revoke route so
 * the tick name on the wire maps to storage in exactly one place.
 */
export const TICK_COLUMNS: Record<
  VerificationTickName,
  { at: keyof VerificationColumns; until: keyof VerificationColumns }
> = {
  creator: { at: 'creatorVerifiedAt', until: 'creatorVerifiedUntil' },
  professional: {
    at: 'professionalVerifiedAt',
    until: 'professionalVerifiedUntil',
  },
};
