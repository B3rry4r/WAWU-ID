import {
  isSupportedCountry,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/max';
import {
  DEFAULT_COUNTRY_CODE,
  isCountryCode,
  toCountryCode,
} from './country.util';

/**
 * Phone numbers as people type them, and the one form the sign-up path stores.
 *
 * Every phone is stored in E.164: `+`, the country's calling code and the
 * number, no spaces (`+2348031234412`, `+233241234567`, `+14155552671`). The
 * same person cannot open two accounts by writing their number two ways, and
 * the SMS provider (which wants a country code) is always given one.
 *
 * A Nigerian number is written `0803 123 4412`, `+234 803 123 4412`,
 * `2348031234412`, `002348031234412` or `8031234412`, and all of them are the
 * same phone. That rule is exactly what it was before GEO-01 (R-85): ten digits
 * after +234 starting 7, 8 or 9. Nothing that signs in today stops working.
 *
 * A number from any other country must be a VALID number for that country
 * (libphonenumber-js, which carries Google's rules for every country), written
 * with its `+` and country code, or `00` and the code. Without a `+` it is read
 * in the country the caller names (`countryHint`, the country the person chose
 * in the phone field), and in no other.
 */

/** Nigerian mobile numbers: 10 digits after the country code, starting 7, 8 or 9. */
const NG_NATIONAL = /^[789]\d{9}$/;
/** What WAWU ID accepted from a non-Nigerian number before GEO-01: `+` and 8 to 15 digits, as typed. */
const LEGACY_INTERNATIONAL = /^\+[1-9]\d{7,14}$/;

/**
 * The Nigerian reading of `stripped`: the E.164 number, null when it is
 * written as a Nigerian number but is not one, undefined when it is not
 * written as a Nigerian number at all.
 */
function nigerian(stripped: string): string | null | undefined {
  let digits: string;
  if (stripped.startsWith('+234')) digits = stripped.slice(4);
  else if (stripped.startsWith('00234')) digits = stripped.slice(5);
  else if (stripped.startsWith('234')) digits = stripped.slice(3);
  else if (stripped.startsWith('0') && !stripped.startsWith('00')) {
    digits = stripped.slice(1);
  } else if (stripped.startsWith('+')) {
    return undefined;
  } else if (NG_NATIONAL.test(stripped)) {
    // Ten digits with no 0 and no country code (8031234567): the number as
    // people write it when they leave the 0 off.
    digits = stripped;
  } else {
    return undefined;
  }

  // The local form may keep a stray leading 0 after the country code
  // (+2340803...), which is a common typing slip.
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);

  return NG_NATIONAL.test(digits) ? `+234${digits}` : null;
}

/** E.164 of `text` when it is a valid number (read in `region` when it has no country code), else null. */
function valid(text: string, region?: CountryCode): string | null {
  const parsed = parsePhoneNumberFromString(text, region);
  return parsed?.isValid() ? parsed.number : null;
}

/**
 * Normalised form (E.164), or null when the text is not a usable phone number.
 * This is the strict reading, for a number a person is giving us now: the
 * sign-up, a phone change. `countryHint` is the country (two letters) the
 * person picked in the phone field; it only matters for a number written
 * without a country code and not as a Nigerian number.
 */
export function normalisePhone(
  input: string,
  countryHint?: string | null,
): string | null {
  const stripped = input.trim().replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(stripped)) return null;

  const ng = nigerian(stripped);
  if (typeof ng === 'string') return ng;

  // Written with a country code: that code decides. Nigeria's own code means
  // a Nigerian number, and one that fails Nigeria's rule is not a number.
  if (stripped.startsWith('+') || stripped.startsWith('00')) {
    const plus = stripped.startsWith('+') ? stripped : `+${stripped.slice(2)}`;
    return plus.startsWith('+234') ? null : valid(plus);
  }

  // No country code, and not a Nigerian number: the country the person
  // picked, or nothing.
  const hint = toCountryCode(countryHint ?? undefined);
  if (hint && isSupportedCountry(hint)) {
    return valid(stripped, hint);
  }
  return null;
}

/**
 * The form to COMPARE a number in against what is already stored: the strict
 * reading when there is one, else what WAWU ID read before GEO-01 (a `+` number
 * as typed, 8 to 15 digits). A lookup must keep finding the rows it found
 * (login, duplicate checks, erased identifiers, holds); only a number being
 * given now has to be valid.
 */
export function comparablePhone(input: string): string | null {
  const strict = normalisePhone(input);
  if (strict) return strict;
  const stripped = input.trim().replace(/[\s\-().]/g, '');
  return LEGACY_INTERNATIONAL.test(stripped) && !stripped.startsWith('+234')
    ? stripped
    : null;
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

/**
 * The country a number belongs to (two letters, from the list), null when it
 * belongs to none. `+44 7911 ...` is Guernsey and `+1 415 ...` is the United
 * States: the number's own country, which is not always where the person lives.
 */
export function phoneCountry(e164: string): string | null {
  // Nigeria's rule is wider than the library's for a mobile number (see top).
  if (e164.startsWith('+234')) return 'NG';
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed?.isValid()) return null;
  // Ascension and Tristan da Cunha have calling codes of their own but are
  // part of Saint Helena in the country list.
  const country =
    parsed.country === 'AC' || parsed.country === 'TA' ? 'SH' : parsed.country;
  return country && isCountryCode(country) ? country : null;
}

/**
 * The country of residence a new account gets (R-85): the one the client sent,
 * else the phone's own country, else Nigeria. Null only when the client sent
 * a country that is not on the list: that is a mistake to tell it about, not
 * one to guess around.
 */
export function resolveCountryCode(
  sent: string | null | undefined,
  phone: string,
): string | null {
  if (typeof sent === 'string' && sent.trim() !== '') {
    return toCountryCode(sent);
  }
  return phoneCountry(phone) ?? DEFAULT_COUNTRY_CODE;
}
