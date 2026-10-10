import { normalisePhone } from '../common/phone.util';

/**
 * Whether the account's CURRENT phone is a number it has proven (JOIN-03
 * round 2, D1). `phone_verified_at` alone is not enough: the internal
 * phone-change routes write a new number and leave it set. The account vouches
 * for its phone only while the number the sign-up code went to
 * (`phone_verified_for`) is still the number it holds.
 *
 * "The same number" is read the way sign-up reads it: `0803...`, `234803...`
 * and `+234803...` are one phone. Anything that does not read as a phone (a
 * `released:<id>` or `deleted:<id>` marker) is compared as written, so it
 * never matches a real number.
 */
export interface PhoneProofFields {
  phone: string;
  phoneVerifiedAt: Date | null;
  phoneVerifiedFor: string | null;
}

export function phoneIsProven(user: PhoneProofFields): boolean {
  // A row that carries no proof, or no phone, proves nothing: `null` is the
  // column's own answer, anything that is not text is a row read half-way.
  if (
    !user.phoneVerifiedAt ||
    typeof user.phoneVerifiedFor !== 'string' ||
    typeof user.phone !== 'string'
  ) {
    return false;
  }
  if (user.phoneVerifiedFor === user.phone) return true;
  const proven = normalisePhone(user.phoneVerifiedFor);
  return proven !== null && proven === normalisePhone(user.phone);
}
