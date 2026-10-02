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
