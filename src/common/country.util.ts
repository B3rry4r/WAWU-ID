/**
 * Countries, as two capital letters (ISO 3166-1 alpha-2), the one form the
 * account's country of residence is stored and answered in (GEO-01, R-85).
 *
 * The list is the 249 officially assigned codes. It is written out here rather
 * than read from the runtime's locale data, because a code that is accepted on
 * one server and refused on another (an older ICU) is how two instances of one
 * service end up disagreeing about an account. Exceptionally reserved and
 * retired codes (UK, AN, YU, XK and the like) are not on it. The Hub serves the
 * list the app shows (GEO-02); this one only decides what WAWU ID will store.
 */
export const COUNTRY_CODES: readonly string[] = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI ' +
  'BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN ' +
  'CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK ' +
  'FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM ' +
  'HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN ' +
  'KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ' +
  'ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP ' +
  'NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
  'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF ' +
  'TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI ' +
  'VN VU WF WS YE YT ZA ZM ZW '
)
  .trim()
  .split(' ');

const KNOWN = new Set(COUNTRY_CODES);

/** The country a person lives in when nothing else says (Nigeria, R-85). */
export const DEFAULT_COUNTRY_CODE = 'NG';

/** True for exactly two capital letters that name a country on the list. */
export function isCountryCode(value: unknown): value is string {
  return typeof value === 'string' && KNOWN.has(value);
}

/**
 * What a client typed as a country, in the stored form, or null when it names
 * no country on the list. Case and surrounding spaces are not a mistake
 * (`gh `), but a name (`Ghana`) or a three-letter code (`GHA`) is refused:
 * the app sends the code its country list gave it.
 */
export function toCountryCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return isCountryCode(code) ? code : null;
}
