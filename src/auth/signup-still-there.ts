import type { PrismaService } from '../prisma/prisma.service';

/**
 * Is the sign-up whose code row is `codeId` still there?
 *
 * A confirm reads its sign-up, then takes a guess from the number's (or
 * address's) wrong-code budget in a transaction of its own. The Hub can
 * anonymise the account in between (JOIN-03 round 5, D9): the anonymise deletes
 * the code row, then the budget, then commits, and a guess taken after that
 * writes a budget row keyed on a closed account's number that nothing removes.
 *
 * This is asked right AFTER the guess is taken. `FOR SHARE` waits for an
 * anonymise (or any other transaction) that has deleted the code row and not
 * yet committed, which is the whole time between its first statement and its
 * commit, because it deletes the code row first. So either the code row is
 * gone when this returns and the caller removes the budget row it just made,
 * or the anonymise has not reached the code row yet and it deletes the budget
 * row itself afterwards. A guess is never left behind either way.
 */
export async function signupStillThere(
  prisma: PrismaService,
  codeId: string,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<
    Array<{ id: string }>
  >`SELECT id FROM phone_verifications WHERE id = ${codeId}::uuid FOR SHARE`;
  return rows.length > 0;
}
