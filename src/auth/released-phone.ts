/**
 * BACKEND_GAPS G-16 (AUTH-05): when the owner releases a number held by two
 * accounts (scripts/data/g16-duplicate-phones.mjs), the account that gives it
 * up stores `released:<its id>` in the phone column, which is NOT NULL and
 * unique. That marker is not a phone number, so it never leaves this service
 * as one: the token's `phone` claim and the account answer carry an empty
 * string instead (the Hub treats an empty phone as none, so nothing is ever
 * texted, matched or sent to a provider with the marker). Every other phone
 * is carried exactly as stored.
 */
export const RELEASED_PHONE_PREFIX = 'released:';

export function phoneForClients(stored: string): string {
  return typeof stored === 'string' && stored.startsWith(RELEASED_PHONE_PREFIX)
    ? ''
    : stored;
}
