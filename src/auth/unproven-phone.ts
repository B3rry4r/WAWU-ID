import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { releasedPhoneFor } from './released-phone';

/**
 * A phone is held only once it is proven, and taken from a holder only by a
 * newer sign-up that proves it (AUTH-07 rounds 2 and 3, DECISIONS R-39).
 *
 * With sign-up verifying the EMAIL, a stranger could type anyone's number, prove
 * their own mailbox, and hold that number for good: the owner's own sign-up was
 * then refused as "an account exists". Round 2 let a newer sign-up take such a
 * number the moment the sign-up was made, which let an UNCONFIRMED sign-up
 * strip the number from an account (the verifier's F-A). Round 3 (lead
 * ruling): a number an account only typed changes hands at one moment only,
 * when a newer sign-up PROVES it, by entering a code that was sent to it (the
 * texted sign-up's code).
 *
 *  - A mailed sign-up, an unconfirmed one, a refused one and one that expires
 *    never take or release anybody's number. A mailed sign-up whose number is
 *    held by such an account goes ahead WITHOUT the number: the account is
 *    made with no phone (the G-16 marker, which every client reads as none)
 *    and the answer says so (`phoneNotSaved`), so the person adds and proves a
 *    phone later (BACKEND_GAPS G-222).
 *  - A texted sign-up whose number is held by such an account is made the same
 *    way, holding no number yet, and sends the code to the number it typed.
 *    The right code proves the number (`takeProvenNumber`): the older account
 *    keeps everything but the number, which becomes `released:<its id>`.
 *
 * Which accounts give way is deliberately narrow:
 *
 *  - An account that finished a MAILED sign-up (it is in the sign-up sequence,
 *    which a mailed confirm creates) and whose `phone_verified_at` is empty.
 *    Its number is only what its owner typed.
 *  - NOT an account with a proven number (`phone_verified_at` set).
 *  - NOT a long-standing web or legacy account. Those have an unproven number
 *    too (nothing ever texted them) but they are not in the sign-up sequence,
 *    and wiping their number because a stranger typed it would lose real user
 *    data. They are held exactly as before.
 */
export function holdsUnprovenPhone(user: {
  phoneVerifiedAt: Date | null;
  signupProgress?: object | null;
}): boolean {
  return !user.phoneVerifiedAt && !!user.signupProgress;
}

/** An account that already holds the email or the phone a new sign-up asks for. */
export interface Clash {
  id: string;
  email: string | null;
  phone: string;
  emailVerified: boolean;
  phoneVerifiedAt: Date | null;
  phoneVerification: object | null;
  signupProgress?: object | null;
}

/** What the new sign-up does about the accounts in its way. */
export interface ClashPlan {
  /** Pending sign-ups nobody confirmed: gone, with their secrets. */
  remove: string[];
  /**
   * Accounts that only typed the number and hold it. Nothing is taken from
   * them here: the new account is made without the number (see `numberHeld`).
   */
  typedHolders: string[];
  /** A phone-proven mobile account holds the email without having proven it: the new person must prove the mailbox. */
  claimEmail: boolean;
}

export const SAME_ACCOUNT =
  'An account with this email or phone already exists';

/** True when the new account cannot hold its number now: an account that only typed it holds it. */
export function numberHeld(plan: ClashPlan): boolean {
  return plan.typedHolders.length > 0;
}

/**
 * Decides, before anything is changed, what a sign-up for `email` and the
 * phone forms in `variants` does about the accounts that hold either. Throws
 * the usual 409 when one of them really holds it.
 */
export function planClashes(
  clashes: readonly Clash[],
  email: string,
  variants: readonly string[],
): ClashPlan {
  const plan: ClashPlan = { remove: [], typedHolders: [], claimEmail: false };
  for (const other of clashes) {
    if (other.phoneVerification && !other.phoneVerifiedAt) {
      // An unproven sign-up holds nothing: a newer sign-up takes its email
      // and phone, and it is gone, together with its secret.
      plan.remove.push(other.id);
    } else if (
      other.email === email &&
      !variants.includes(other.phone) &&
      other.phoneVerifiedAt &&
      !other.emailVerified
    ) {
      // A mobile account that proved its phone (not its email) holds this
      // email. It keeps the email: nothing is taken from it here. This sign-up
      // gets the email only when its person enters the code mailed to it,
      // which is the proof the other account never gave (see confirm).
      plan.claimEmail = true;
    } else if (
      other.email !== email &&
      variants.includes(other.phone) &&
      holdsUnprovenPhone(other)
    ) {
      plan.typedHolders.push(other.id);
    } else {
      throw new ConflictException(SAME_ACCOUNT);
    }
  }
  return plan;
}

/**
 * Removes a pending sign-up that nobody confirmed, the way every path that
 * touches both of its rows locks them: the sign-up CODE row first, the account
 * after (JOIN-03 round 5, D8). The Hub's anonymise and both confirm routes take
 * the same order, so none of them can wait on the other for the row it holds:
 * a deletion that deleted the code row first and is waiting for the account can
 * no longer meet a request that deleted the account first and is waiting for
 * the code row it cascades to.
 *
 * The code row is what makes the account a pending sign-up. If it is already
 * gone, the account is no longer one: the Hub anonymised it, or its person
 * confirmed it, in the moment since it was read. It is left as it is. (A
 * confirmed account is never deleted by a newer sign-up; that sign-up is then
 * refused as taken by the unique keys, the usual 409.)
 */
export async function removePendingSignup(
  tx: Prisma.TransactionClient,
  id: string,
  /** Only a sign-up whose 24 hours ended before this moment (the expired sign-up sweep). */
  expiredBefore?: Date,
): Promise<void> {
  const taken = await tx.phoneVerification.deleteMany({
    where: {
      userId: id,
      ...(expiredBefore ? { signupExpiresAt: { lt: expiredBefore } } : {}),
    },
  });
  if (taken.count === 0) return;
  await tx.wawuUser.deleteMany({ where: { id } });
}

/**
 * Carries out a plan inside the sign-up's transaction, before the new account
 * is created. It only removes the unconfirmed sign-ups in the way: it never
 * writes to an account that finished a sign-up.
 */
export async function applyClashPlan(
  tx: Prisma.TransactionClient,
  plan: ClashPlan,
): Promise<void> {
  for (const id of plan.remove) {
    await removePendingSignup(tx, id);
  }
}

/**
 * A newer sign-up PROVED `variants` (the right code, sent to that number, was
 * entered): it takes the number, inside the confirming transaction and before
 * the new account is given it.
 *
 *  - An unconfirmed sign-up that holds it is removed, as a newer sign-up
 *    always replaced one.
 *  - An account that only typed it gives it up: its phone column becomes
 *    `released:<its id>` (the G-16 marker, read by every client as none), so
 *    it keeps its email, password and sessions. The write is guarded: if the
 *    number was proven or changed since it was read, the sign-up is refused as
 *    taken.
 *  - Any other holder (a number proven by a code, a long-standing web or
 *    legacy account) keeps it: the usual 409.
 *
 * This is the one place a number changes hands, so whatever proves a phone
 * later (BACKEND_GAPS G-222) calls it too.
 */
export async function takeProvenNumber(
  tx: Prisma.TransactionClient,
  newUserId: string,
  variants: readonly string[],
): Promise<void> {
  const holders = await tx.wawuUser.findMany({
    where: { phone: { in: [...variants] }, id: { not: newUserId } },
    include: { phoneVerification: true, signupProgress: true },
  });
  const remove: string[] = [];
  const release: string[] = [];
  for (const other of holders) {
    if (other.phoneVerification && !other.phoneVerifiedAt) {
      remove.push(other.id);
    } else if (holdsUnprovenPhone(other)) {
      release.push(other.id);
    } else {
      throw new ConflictException(SAME_ACCOUNT);
    }
  }
  for (const id of remove) {
    await removePendingSignup(tx, id);
  }
  for (const id of release) {
    const done = await tx.wawuUser.updateMany({
      where: { id, phoneVerifiedAt: null, phone: { in: [...variants] } },
      // The number it proved (if the row ever held one) goes with the phone:
      // JOIN-03 round 3, D3.
      data: { phone: releasedPhoneFor(id), phoneVerifiedFor: null },
    });
    if (done.count === 0) throw new ConflictException(SAME_ACCOUNT);
  }
}
