import type { Prisma } from '@prisma/client';

/**
 * Deletes the accounts that match `where`, locking them the way every path that
 * touches a pending sign-up does: the sign-up CODE row first, the account after
 * (JOIN-03 round 6, N31; the order round 5, D8 set for the Hub's anonymise, the
 * confirm routes and a newer sign-up).
 *
 * A plain `DELETE FROM wawu_users` locks the account row first and then, in the
 * cascade, the rows that hang off it, the code row among them. A confirm that
 * has deleted the code row and is about to update the account is waiting for
 * the account, while the delete is waiting for the code row: Postgres ends one
 * of them with a deadlock (40P01) and the caller gets a 500. Deleting the code
 * row in a statement of its own, ahead of the account, makes the delete queue
 * behind the confirm instead (and the confirm, if the delete came first, find
 * its code row gone and answer 409, as it does for any second request).
 *
 * The accounts are taken one at a time in id order, so two deletes that share
 * accounts wait on each other in the same order. `where` is applied again to
 * each account when it is deleted: an account that stopped matching in the
 * meantime is left alone. Returns how many accounts went.
 */
export async function deleteAccountsMatching(
  tx: Prisma.TransactionClient,
  where: Prisma.WawuUserWhereInput,
): Promise<number> {
  const found = await tx.wawuUser.findMany({
    where,
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  let deleted = 0;
  for (const { id } of found) {
    await tx.phoneVerification.deleteMany({ where: { userId: id } });
    const done = await tx.wawuUser.deleteMany({
      where: { AND: [{ id }, where] },
    });
    deleted += done.count;
  }
  return deleted;
}
