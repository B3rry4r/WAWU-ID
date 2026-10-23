import { normalisePhone, phoneVariants } from './phone.util';

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
