/**
 * Phone numbers as people type them, and the one form the sign-up path stores.
 *
 * A Nigerian number is written `0803 123 4412`, `+234 803 123 4412`,
 * `2348031234412` or `002348031234412`, and all of them are the same phone.
 * Sign-up stores `+2348031234412` so the same person cannot open two accounts
 * by writing their number two ways, and so the SMS provider (which wants a
 * country code) is always given one.
 *
 * A number that is not Nigerian is accepted when it is already written in
 * international form (`+` and 8 to 15 digits) and is passed through as typed.
 */

/** Nigerian mobile numbers: 10 digits after the country code, starting 7, 8 or 9. */
const NG_NATIONAL = /^[789]\d{9}$/;
const INTERNATIONAL = /^\+[1-9]\d{7,14}$/;

/** Normalised form, or null when the text is not a usable phone number. */
export function normalisePhone(input: string): string | null {
  const stripped = input.trim().replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(stripped)) return null;

  let digits = stripped;
  if (digits.startsWith('+234')) digits = digits.slice(4);
  else if (digits.startsWith('00234')) digits = digits.slice(5);
  else if (digits.startsWith('234')) digits = digits.slice(3);
  else if (digits.startsWith('0') && !digits.startsWith('00')) {
    digits = digits.slice(1);
  } else if (digits.startsWith('+')) {
    return INTERNATIONAL.test(digits) ? digits : null;
  } else {
    return null;
  }

  // The local form may keep a stray leading 0 after the country code
  // (+2340803...), which is a common typing slip.
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);

  return NG_NATIONAL.test(digits) ? `+234${digits}` : null;
}

/**
 * Every spelling an existing row might hold for the same Nigerian number, so
 * a duplicate check sees `08031234412` when asked about `+2348031234412`.
 * Non-Nigerian numbers have one spelling.
 */
export function phoneVariants(normalised: string): string[] {
  if (!normalised.startsWith('+234')) return [normalised];
  const national = normalised.slice(4);
  return [normalised, `234${national}`, `0${national}`];
}
