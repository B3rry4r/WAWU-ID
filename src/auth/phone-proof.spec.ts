import { phoneIsProven } from './phone-proof';

/**
 * JOIN-03 round 4, M12: a number that cannot be read as a number is never "the
 * same number" as another such text. `normalisePhone` answers null for both,
 * and null equals null: the `proven !== null` guard is what stops that.
 */
describe('phoneIsProven with texts that are not numbers', () => {
  const at = new Date('2026-10-01T10:00:00Z');
  const fields = (phone: string, phoneVerifiedFor: string | null) => ({
    phone,
    phoneVerifiedAt: at,
    phoneVerifiedFor,
  });

  it('does not take two DIFFERENT texts that are not numbers for one number', () => {
    expect(phoneIsProven(fields('12345', '67890'))).toBe(false);
    expect(phoneIsProven(fields('abc', 'xyz'))).toBe(false);
    expect(phoneIsProven(fields('0000', '1111'))).toBe(false);
    expect(phoneIsProven(fields('+1234', '+5678'))).toBe(false);
  });

  it('does not take a text that is not a number for a number, either way round', () => {
    expect(phoneIsProven(fields('12345', '+2348031234567'))).toBe(false);
    expect(phoneIsProven(fields('+2348031234567', '12345'))).toBe(false);
  });

  it('still reads the spellings of one real number as one number', () => {
    expect(phoneIsProven(fields('08031234567', '+2348031234567'))).toBe(true);
    expect(phoneIsProven(fields('2348031234567', '08031234567'))).toBe(true);
  });

  it('still reads two different real numbers as different', () => {
    expect(phoneIsProven(fields('08031234567', '+2348031234568'))).toBe(false);
  });
});
