import { erasedKeys, SIGNUP_EMAIL_BUDGET } from './erased-identifiers';

/** JOIN-03 round 4, N16: the keys an anonymise removes, from what the person held. */
describe('erasedKeys', () => {
  it('names every spelling of a Nigerian number, the one as stored too', () => {
    const { keys, budgets } = erasedKeys({
      phones: ['0803 123 4567'],
      emails: [],
    });
    for (const spelling of [
      '0803 123 4567',
      '+2348031234567',
      '2348031234567',
      '08031234567',
    ]) {
      expect(keys).toContain(spelling);
      expect(budgets).toContain(spelling);
    }
  });

  it('keeps a number that is not Nigerian as it was written, with no invented spellings', () => {
    const { keys } = erasedKeys({ phones: ['+14155550100'], emails: [] });
    expect(keys).toEqual(['+14155550100']);
  });

  it('names an address, and its wrong-code budget under the sign-up prefix', () => {
    const { keys, budgets } = erasedKeys({
      phones: [],
      emails: ['ada@example.test'],
    });
    expect(keys).toEqual(['ada@example.test']);
    expect(budgets).toEqual([`${SIGNUP_EMAIL_BUDGET}ada@example.test`]);
    expect(SIGNUP_EMAIL_BUDGET).toBe('signup-email:');
  });

  it('names nothing for a marker, an empty text, a blank one or no value', () => {
    expect(
      erasedKeys({
        phones: ['deleted:u1', 'released:u1', '', '   ', null, undefined],
        emails: [null, undefined, '', '  '],
      }),
    ).toEqual({ keys: [], budgets: [] });
  });

  it('lists each key once however many fields name it', () => {
    const { keys } = erasedKeys({
      phones: ['+2348031234567', '+2348031234567', '08031234567'],
      emails: ['a@example.test', 'a@example.test'],
    });
    expect(new Set(keys).size).toBe(keys.length);
  });
});
