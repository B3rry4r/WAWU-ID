/**
 * Canonical gender handling for WAWU-ID (the identity authority).
 *
 * Gender is a NULLABLE field with two canonical lowercase values:
 *   'male' | 'female'
 *
 * Other systems provision/collect gender THROUGH WAWU-ID, so input can arrive
 * in mixed casing or as a single-letter code. `normalizeGender` maps any
 * accepted spelling to a canonical value, and anything unrecognised (or
 * null/undefined/empty) to `null` — legacy users simply have no gender.
 */
export type Gender = 'male' | 'female';

export function normalizeGender(input: unknown): Gender | null {
  if (typeof input !== 'string') {
    return null;
  }
  const v = input.trim().toLowerCase();
  switch (v) {
    case 'male':
    case 'm':
      return 'male';
    case 'female':
    case 'f':
      return 'female';
    default:
      return null;
  }
}
