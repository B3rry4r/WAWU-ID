import { signupStillThere } from './signup-still-there';

/**
 * JOIN-03 round 6 (the verifier's N35). `FOR SHARE` in `signupStillThere` is
 * what makes a confirm that has just taken a wrong-code guess wait for an
 * anonymise that has deleted the sign-up's code row and not yet committed
 * (round 5, D9). A double of the database cannot see a lock, so the other half
 * of this guard is a real one: `npm run test:erase-local` holds a deleting
 * transaction open on a real Postgres and checks the call waits for it. This
 * spec is the part that runs with the unit tests: the statement it sends must
 * ask for the lock, on the code row, by id.
 */
describe('signupStillThere', () => {
  const ID = '00000000-0000-4000-8000-0000000000e1';

  const recording = (rows: Array<{ id: string }>) => {
    const sent: Array<{ text: string; values: unknown[] }> = [];
    const prisma = {
      $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        sent.push({ text: strings.join('?'), values });
        return Promise.resolve(rows);
      },
    };
    return { prisma, sent };
  };

  it('reads the code row with FOR SHARE, so it waits for a transaction that has deleted the row and not committed', async () => {
    const { prisma, sent } = recording([{ id: ID }]);
    await signupStillThere(prisma as never, ID);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/\bFOR SHARE\b/);
    expect(sent[0].text).toMatch(/FROM phone_verifications\b/);
    // by the code row's id, as a parameter and not spliced into the text
    expect(sent[0].text).toMatch(/WHERE id = \?::uuid/);
    expect(sent[0].values).toEqual([ID]);
  });

  it('is true while the row is there and false once it is gone', async () => {
    expect(
      await signupStillThere(recording([{ id: ID }]).prisma as never, ID),
    ).toBe(true);
    expect(await signupStillThere(recording([]).prisma as never, ID)).toBe(
      false,
    );
  });
});
