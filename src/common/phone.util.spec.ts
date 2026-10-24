import {
  comparablePhone,
  normalisePhone,
  phoneCountry,
  phoneVariants,
  resolveCountryCode,
} from './phone.util';

describe('normalisePhone', () => {
  it.each([
    ['08031234412', '+2348031234412'],
    ['0803 123 4412', '+2348031234412'],
    ['+234 803 123 4412', '+2348031234412'],
    ['+2348031234412', '+2348031234412'],
    ['2348031234412', '+2348031234412'],
    ['002348031234412', '+2348031234412'],
    ['+2340803 123 4412', '+2348031234412'],
    ['(0803) 123-4412', '+2348031234412'],
    ['07012345678', '+2347012345678'],
    ['09012345678', '+2349012345678'],
  ])('writes %s as %s', (typed, stored) => {
    expect(normalisePhone(typed)).toBe(stored);
  });

  // FIX-99 (L2): the 0 left off. Ten digits starting 7, 8 or 9.
  it.each([
    ['8031234567', '+2348031234567'],
    ['803 123 4567', '+2348031234567'],
    ['(803) 123-4567', '+2348031234567'],
    ['7012345678', '+2347012345678'],
    ['9012345678', '+2349012345678'],
  ])('writes %s, typed without the leading 0, as %s', (typed, stored) => {
    expect(normalisePhone(typed)).toBe(stored);
  });

  it('writes the ten-digit and the 0 spellings of one number the same way', () => {
    expect(normalisePhone('8031234567')).toBe(normalisePhone('08031234567'));
  });

  it.each([
    '803123456',
    '80312345678',
    '6031234567',
    '1031234567',
    '0000000000',
  ])('still refuses %p, which is not a ten-digit mobile number', (typed) => {
    expect(normalisePhone(typed)).toBeNull();
  });

  it('passes an international number through as typed', () => {
    expect(normalisePhone('+14155550123')).toBe('+14155550123');
  });

  it.each([
    '',
    'abc',
    '0803123441',
    '080312344123',
    '06031234412',
    '12345678',
    '+12',
    '+234803123441',
  ])('refuses %p', (typed) => {
    expect(normalisePhone(typed)).toBeNull();
  });

  it('lists every spelling of a Nigerian number, and one of any other', () => {
    expect(phoneVariants('+2348031234412')).toEqual([
      '+2348031234412',
      '2348031234412',
      '08031234412',
    ]);
    expect(phoneVariants('+14155550123')).toEqual(['+14155550123']);
  });
});

// GEO-01 (R-85): a phone from any country, in E.164, valid numbers only.
describe('normalisePhone, any country', () => {
  it.each([
    ['+233 24 123 4567', '+233241234567'],
    ['+233 (0) 24 123 4567', '+233241234567'],
    ['00233241234567', '+233241234567'],
    ['0044 7911 123456', '+447911123456'],
    ['+44 7911 123456', '+447911123456'],
    ['+1 (415) 555-2671', '+14155552671'],
    ['+1 204 555 0123', '+12045550123'],
    ['+91 98765 43210', '+919876543210'],
    ['+49 1511 2345678', '+4915112345678'],
    ['+971 50 123 4567', '+971501234567'],
    ['+27 82 123 4567', '+27821234567'],
    ['+254 712 345678', '+254712345678'],
    ['+86 138 1234 5678', '+8613812345678'],
  ])('writes %s as %s', (typed, stored) => {
    expect(normalisePhone(typed)).toBe(stored);
  });

  it.each([
    '+1 111 111 1111',
    '+14150000000',
    '+999 123 456 789',
    '+44 79',
    '+233 24 123',
    '+233 24 123 4567 89',
    '+12',
    '+0 800 123 4567',
  ])('refuses %p, which no country has', (typed) => {
    expect(normalisePhone(typed)).toBeNull();
  });

  it('reads a number without a country code only in the country named', () => {
    expect(normalisePhone('024 123 4567')).toBeNull();
    expect(normalisePhone('024 123 4567', 'GH')).toBe('+233241234567');
    expect(normalisePhone('233241234567', 'GH')).toBe('+233241234567');
    expect(normalisePhone('(415) 555-2671', 'US')).toBe('+14155552671');
    expect(normalisePhone('024 123 4567', 'US')).toBeNull();
    expect(normalisePhone('024 123 4567', 'ZZ')).toBeNull();
    expect(normalisePhone('024 123 4567', 'gh')).toBe('+233241234567');
  });

  it('reads a Nigerian number the way it always did, whatever country is named', () => {
    for (const hint of [undefined, 'NG', 'GH', 'US', 'ZZ']) {
      expect(normalisePhone('0803 123 4412', hint)).toBe('+2348031234412');
      expect(normalisePhone('8031234412', hint)).toBe('+2348031234412');
      expect(normalisePhone('2348031234412', hint)).toBe('+2348031234412');
      expect(normalisePhone('+234 803 123 4412', hint)).toBe('+2348031234412');
      expect(normalisePhone('002348031234412', hint)).toBe('+2348031234412');
    }
  });

  it('keeps Nigeria its own rule: ten digits after +234 starting 7, 8 or 9', () => {
    expect(normalisePhone('+2347712345678')).toBe('+2347712345678');
    expect(normalisePhone('+23412345678')).toBeNull();
    expect(normalisePhone('+234803123441', 'GH')).toBeNull();
    expect(normalisePhone('00234803123441', 'GH')).toBeNull();
  });

  it('refuses letters and signs inside a number', () => {
    expect(normalisePhone('+233 24 ABC 4567')).toBeNull();
    expect(normalisePhone('++233241234567')).toBeNull();
    expect(normalisePhone('+233241234567x12')).toBeNull();
  });
});

describe('comparablePhone', () => {
  it('is the strict reading wherever there is one', () => {
    expect(comparablePhone('0803 123 4412')).toBe('+2348031234412');
    expect(comparablePhone('+233 24 123 4567')).toBe('+233241234567');
    expect(comparablePhone('0044 7911 123456')).toBe('+447911123456');
  });

  it('still reads a stored plus number that is not a valid one, as it was read before', () => {
    // These were found by login and the duplicate checks before GEO-01, and a
    // lookup must keep finding them.
    expect(comparablePhone('+1 111 111 1111')).toBe('+11111111111');
    expect(comparablePhone('+999 123 456 789')).toBe('+999123456789');
    expect(comparablePhone('+14150000000')).toBe('+14150000000');
  });

  it('is still nothing for a number that never was one', () => {
    for (const typed of ['', 'abc', '+12', '12345678', '+234803123441']) {
      expect(comparablePhone(typed)).toBeNull();
    }
  });
});

describe('phoneCountry and resolveCountryCode', () => {
  it.each([
    ['+2348031234412', 'NG'],
    ['+2347712345678', 'NG'],
    ['+233241234567', 'GH'],
    ['+14155552671', 'US'],
    ['+12045550123', 'CA'],
    ['+447911123456', 'GB'],
    ['+441534123456', 'GB'],
    ['+441481256789', 'GB'],
    ['+441624500123', 'GB'],
    ['+442071838750', 'GB'],
    ['+24761234', 'SH'],
  ])('puts %s in %s', (phone, country) => {
    expect(phoneCountry(phone)).toBe(country);
  });

  it('puts a number that is not valid in no country', () => {
    expect(phoneCountry('+11111111111')).toBeNull();
    expect(phoneCountry('not a phone')).toBeNull();
  });

  it("gives a new account the country sent, else the phone's, else NG", () => {
    expect(resolveCountryCode('gh', '+2348031234412')).toBe('GH');
    expect(resolveCountryCode(' US ', '+2348031234412')).toBe('US');
    expect(resolveCountryCode(undefined, '+233241234567')).toBe('GH');
    expect(resolveCountryCode(null, '+233241234567')).toBe('GH');
    expect(resolveCountryCode('', '+233241234567')).toBe('GH');
    expect(resolveCountryCode(undefined, '+2348031234412')).toBe('NG');
    expect(resolveCountryCode(undefined, '+11111111111')).toBe('NG');
    expect(resolveCountryCode(undefined, 'not a phone')).toBe('NG');
  });

  it('refuses a country that is not on the list', () => {
    for (const sent of ['XX', 'UK', 'GHA', 'G', 'Ghana', '12', 'AN', 'XK']) {
      expect(resolveCountryCode(sent, '+2348031234412')).toBeNull();
    }
  });
});

// GEO-01 round 1: a country that is named reads the number first.
describe('normalisePhone, a country named', () => {
  it.each([
    ['07400123456', 'GB', '+447400123456'],
    ['07911 123456', 'GB', '+447911123456'],
    ['7400123456', 'GB', '+447400123456'],
    ['7135551234', 'US', '+17135551234'],
    ['(713) 555-1234', 'US', '+17135551234'],
    ['0245550114', 'GH', '+233245550114'],
    ['245550114', 'GH', '+233245550114'],
    ['024 555 0114', 'gh', '+233245550114'],
  ])(
    'reads %s in %s as %s, not as a Nigerian number',
    (typed, hint, stored) => {
      expect(normalisePhone(typed, hint)).toBe(stored);
    },
  );

  it('falls back to the Nigerian reading only when the number is not valid in the country named', () => {
    // A Nigerian living abroad who types the number the local way.
    expect(normalisePhone('08037770101', 'GB')).toBe('+2348037770101');
    expect(normalisePhone('08037770101', 'GH')).toBe('+2348037770101');
    expect(normalisePhone('8031234412', 'US')).toBe('+2348031234412');
    // Valid in the country named, so it is read there: 803 is South Carolina.
    expect(normalisePhone('8037770101', 'US')).toBe('+18037770101');
    // Not valid in the country named and not a Nigerian number: refused.
    expect(normalisePhone('0245550', 'GB')).toBeNull();
    expect(normalisePhone('024 555 0114', 'GB')).toBeNull();
  });

  it('reads a number the way it always was when Nigeria is named, or nothing is', () => {
    for (const hint of [undefined, null, '', 'NG', 'ng', 'ZZ']) {
      expect(normalisePhone('07400123456', hint)).toBe('+2347400123456');
      expect(normalisePhone('7135551234', hint)).toBe('+2347135551234');
      expect(normalisePhone('0803 123 4412', hint)).toBe('+2348031234412');
      expect(normalisePhone('8031234412', hint)).toBe('+2348031234412');
    }
  });

  it('keeps a number written with a country code in its own country, whatever is named', () => {
    for (const hint of [undefined, 'NG', 'GB', 'US', 'GH']) {
      expect(normalisePhone('+234 803 123 4412', hint)).toBe('+2348031234412');
      expect(normalisePhone('002348031234412', hint)).toBe('+2348031234412');
      expect(normalisePhone('+44 7400 123456', hint)).toBe('+447400123456');
      expect(normalisePhone('+233 24 555 0114', hint)).toBe('+233245550114');
    }
  });
});
