import { isClosedAccount } from './closed-account';

/** JOIN-03 round 4, D7: which accounts a sign-up route treats as closed. */
describe('isClosedAccount', () => {
  const open = {
    status: 'active',
    deletedAt: null as Date | null,
    phone: '+2348031234567',
  };

  it('is false for an active account with a real phone', () => {
    expect(isClosedAccount(open)).toBe(false);
  });

  it('is true for a banned account, however the rest of the row reads', () => {
    expect(isClosedAccount({ ...open, status: 'banned' })).toBe(true);
  });

  it('is true for a deletion that has begun, with or without a stamp', () => {
    expect(isClosedAccount({ ...open, status: 'pending_deletion' })).toBe(true);
    expect(isClosedAccount({ ...open, deletedAt: new Date() })).toBe(true);
  });

  it('is true for a phone that is the deleted marker, whatever the status says', () => {
    expect(isClosedAccount({ ...open, phone: 'deleted:u1' })).toBe(true);
  });

  it('is true for an anonymised row, which carries all of the marks at once', () => {
    expect(
      isClosedAccount({
        status: 'banned',
        deletedAt: new Date(),
        phone: 'deleted:u1',
      }),
    ).toBe(true);
  });

  it('leaves a suspended account and a released-number account as they were (not closed here)', () => {
    expect(isClosedAccount({ ...open, status: 'suspended' })).toBe(false);
    expect(isClosedAccount({ ...open, phone: 'released:u1' })).toBe(false);
  });
});
