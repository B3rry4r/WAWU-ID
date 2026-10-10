import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { releasedPhoneFor } from './released-phone';

/**
 * A phone is held only once it is proven (AUTH-07 round 2, lead ruling on the
 * verifier's F1; DECISIONS R-39).
 *
 * With sign-up verifying the EMAIL, a stranger could type anyone's number, prove
 * their own mailbox, and hold that number for good: the owner's own sign-up was
 * then refused as "an account exists". So an account that never proved its
 * number does not keep it against a newer sign-up that asks for it.
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
 *
 * What giving way means: the account keeps everything but the number. Its
 * phone column becomes `released:<its id>` (the G-16 marker; `phoneForClients`
 * turns it into an empty phone, which the Hub reads as none), so it is asked for
 * a phone again when it next needs one.
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
  /** Accounts that only typed the number: they give it up. */
  release: string[];
  /** A phone-proven mobile account holds the email without having proven it: the new person must prove the mailbox. */
  claimEmail: boolean;
}

export const SAME_ACCOUNT =
  'An account with this email or phone already exists';

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
  const plan: ClashPlan = { remove: [], release: [], claimEmail: false };
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
      plan.release.push(other.id);
    } else {
      throw new ConflictException(SAME_ACCOUNT);
    }
  }
  return plan;
}

/**
 * Carries out a plan inside the sign-up's transaction, before the new account
 * is created. An account whose number was proven (or changed) since it was
 * read keeps it, and the sign-up is refused as taken.
 */
export async function applyClashPlan(
  tx: Prisma.TransactionClient,
  plan: ClashPlan,
  variants: readonly string[],
): Promise<void> {
  for (const id of plan.remove) {
    await tx.wawuUser.deleteMany({ where: { id } });
  }
  for (const id of plan.release) {
    const done = await tx.wawuUser.updateMany({
      where: { id, phoneVerifiedAt: null, phone: { in: [...variants] } },
      data: { phone: releasedPhoneFor(id) },
    });
    if (done.count === 0) throw new ConflictException(SAME_ACCOUNT);
  }
}
