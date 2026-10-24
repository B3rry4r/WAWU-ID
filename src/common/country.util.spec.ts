import {
  COUNTRY_CODES,
  DEFAULT_COUNTRY_CODE,
  isCountryCode,
  toCountryCode,
} from './country.util';

describe('the country list', () => {
  it('holds the 249 officially assigned ISO 3166-1 alpha-2 codes, once each, in order', () => {
    expect(COUNTRY_CODES).toHaveLength(249);
    expect(new Set(COUNTRY_CODES).size).toBe(249);
    expect([...COUNTRY_CODES].sort()).toEqual([...COUNTRY_CODES]);
    for (const code of COUNTRY_CODES) expect(code).toMatch(/^[A-Z]{2}$/);
  });

  it('names a real country for every code (checked against the runtime locale data)', () => {
    const names = new Intl.DisplayNames(['en'], {
      type: 'region',
      fallback: 'none',
    });
    for (const code of COUNTRY_CODES) {
      expect(names.of(code)).toBeTruthy();
    }
  });

  it('holds every country the runtime knows, less the reserved and retired codes', () => {
    const names = new Intl.DisplayNames(['en'], {
      type: 'region',
      fallback: 'none',
    });
    // Not countries: exceptional reservations, groupings, test codes and
    // codes ISO retired (Kosovo's XK is user-assigned, not ISO's).
    const notOnTheList = new Set(
      'AC CP DG EA EU EZ IC QO TA UN XA XB XK ZZ AN BU CQ CS DD DY FX HV NH RH SU TP UK VD YD YU ZR'.split(
        ' ',
      ),
    );
    const known: string[] = [];
    for (let a = 65; a <= 90; a += 1) {
      for (let b = 65; b <= 90; b += 1) {
        const code = String.fromCharCode(a, b);
        if (names.of(code) && !notOnTheList.has(code)) known.push(code);
      }
    }
    expect(COUNTRY_CODES).toEqual(known);
  });

  it('has Nigeria as the default and on the list', () => {
    expect(DEFAULT_COUNTRY_CODE).toBe('NG');
    expect(isCountryCode('NG')).toBe(true);
  });
});

describe('toCountryCode', () => {
  it('accepts a code in any case with spaces round it', () => {
    expect(toCountryCode('gh')).toBe('GH');
    expect(toCountryCode(' Ng ')).toBe('NG');
    expect(toCountryCode('US')).toBe('US');
  });

  it.each(['', 'G', 'GHA', 'Ghana', 'UK', 'XK', 'ZZ', '12', 'N G'])(
    'refuses %p',
    (value) => {
      expect(toCountryCode(value)).toBeNull();
    },
  );

  it('refuses what is not text', () => {
    for (const value of [undefined, null, 234, {}, ['NG']]) {
      expect(toCountryCode(value)).toBeNull();
    }
  });
});
