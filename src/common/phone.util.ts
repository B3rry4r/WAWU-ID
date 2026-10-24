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
 * in the phone field) before the Nigerian reading, and in no other country.
 */

/** Nigerian mobile numbers: 10 digits after the country code, starting 7, 8 or 9. */
const NG_NATIONAL = /^[789]\d{9}$/;
/** Countries whose numbers are counted as a larger neighbour's (see `phoneCountry`). */
const PHONE_COUNTRY_OF: Record<string, string> = {
  AC: 'SH',
  TA: 'SH',
  GG: 'GB',
  JE: 'GB',
  IM: 'GB',
};

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
 * sign-up, a phone change.
 *
 * A number written with its country code (`+`, or `00`) is read in that
 * country, whatever else is sent. A number written without one is read in the
 * country the person named (`countryHint`, two letters) FIRST when it is not
 * Nigeria, so `07400123456` with `GB` is a UK mobile and `7135551234` with `US`
 * is Houston; only when it is not a valid number there is the Nigerian reading
 * tried, so a Nigerian who lives abroad and types `08037770101` still gets
 * `+2348037770101`. With no country named, or Nigeria named, the Nigerian
 * reading is the only one and is exactly what it was before GEO-01.
 */
export function normalisePhone(
  input: string,
  countryHint?: string | null,
): string | null {
  const stripped = input.trim().replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(stripped)) return null;

  // Written with a country code: that code decides. Nigeria's own code means
  // a Nigerian number, and one that fails Nigeria's rule is not a number.
  if (stripped.startsWith('+') || stripped.startsWith('00')) {
    const plus = stripped.startsWith('+') ? stripped : `+${stripped.slice(2)}`;
    if (plus.startsWith('+234')) return nigerian(stripped) ?? null;
    return valid(plus);
  }

  // No country code. A country other than Nigeria that the person named reads
  // the number first.
  const named = toCountryCode(countryHint ?? undefined);
  if (named && named !== 'NG' && isSupportedCountry(named)) {
    const there = valid(stripped, named);
    if (there) return there;
  }

  const ng = nigerian(stripped);
  return typeof ng === 'string' ? ng : null;
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
  // part of Saint Helena in the country list. Guernsey, Jersey and the Isle of
  // Man share +44 with the United Kingdom, their mobile ranges are carried
  // between all four, and a person with a +44 number lives in the United
  // Kingdom far more often than in a Crown dependency, so the number's country
  // is GB; the person can send another. Every other shared calling code is
  // read by the library's own ranges (Canada from the United States, Kazakhstan
  // from Russia), which are geographic.
  const country = PHONE_COUNTRY_OF[parsed.country ?? ''] ?? parsed.country;
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
