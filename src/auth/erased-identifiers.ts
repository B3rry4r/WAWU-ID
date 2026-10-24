import type { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { comparablePhone, phoneVariants } from '../common/phone.util';
import { isStoredPhone } from './released-phone';

/**
 * Where else the identity service keeps a person's number or address, apart
 * from their own row (JOIN-03 round 4, N16 and D7). Three tables are KEYED on
 * it, so a row cannot stay without the number or address staying:
 *
 *  - `rate_counters.key`: the texts-per-phone counters (`sms-phone-gap`,
 *    `sms-phone-day`, key = the number as sign-up normalises it) and the
 *    mails-per-address ones (`signup-mail-*`, key = the address).
 *  - `phone_guess_budgets.phone`: the wrong-code budget of a number
 *    (key = the number) or of a mailed sign-up (key = `signup-email:<address>`).
 *  - `otp_sessions.phone`: the legacy phone OTP, keyed on the number as the
 *    caller wrote it (the route stores any text it is given).
 *
 * `anonymise` deletes those rows. They are counters and one-time codes, not
 * history: the account is closed and nothing can confirm a code against it, and
 * whoever holds the number or address next starts clean.
 *
 * JOIN-03 round 5 (D11): only rows that are the deleted account's OWN go. A
 * row keyed on a number or address is shared with every account that holds it,
 * so a number or address is cleared only when the deleted account HOLDS it (its
 * phone, its email) or PROVED it (`phone_verified_for`), and no other account
 * holds it. A number the account merely typed (a sign-up made without it
 * because another account holds it, the new number of a pending phone change)
 * or an address it merely claimed is not its own: the holder's counters, wrong-
 * code budget and code in flight stay.
 *
 * JOIN-03 round 6 (D12): "its own" is decided from two reads, and each is taken
 * under a lock. The account's own row is read after its sign-up code row is
 * deleted and under the account's row lock, so a confirm that gave it a number
 * a moment earlier is seen. Who else holds the number is asked under an
 * advisory lock (`lockErasure`) that every account holding the same number or
 * address closes under, so two such accounts closed together cannot each read
 * "the other one holds it" and both leave the rows.
 */
export interface Identifiers {
  /** Numbers the deleted account holds or proved (stored text, as typed) and the address it holds. */
  phones: Array<string | null | undefined>;
  emails: Array<string | null | undefined>;
}

export interface ErasedKeys {
  /** `rate_counters.key` and `otp_sessions.phone`: every spelling of each number, and each address. */
  keys: string[];
  /** `phone_guess_budgets.phone`: the numbers, and `signup-email:<address>` for each address. */
  budgets: string[];
  /**
   * `otp_sessions.phone` once everything but the digits is taken out of it
   * (JOIN-03 round 5, N24): the OTP route stores the number as it was written,
   * so `0803 123 4567` and `+234-803-123-4567` are rows too. A row whose digits
   * equal one of these is the number's.
   */
  otpDigits: string[];
}

/** The prefix the mailed sign-up keys its wrong-code budget with (email-signup.service.ts). */
export const SIGNUP_EMAIL_BUDGET = 'signup-email:';

/** A number as a comparable key: the normalised form when it has one, else the trimmed text. */
const numberKey = (stored: string): string =>
  comparablePhone(stored) ?? stored.trim();

/** An address as a comparable key: case and surrounding space do not make a different mailbox. */
const addressKey = (email: string): string => email.trim().toLowerCase();

/** The digits an OTP row would hold for this number, however it was spaced or punctuated. */
function digitForms(normal: string): string[] {
  const digits = normal.replace(/\D/g, '');
  if (normal.startsWith('+234')) {
    const national = normal.slice(4);
    return [
      national,
      `0${national}`,
      `234${national}`,
      `00234${national}`,
      // the stray 0 after the country code (+2340803...) people type
      `2340${national}`,
      `002340${national}`,
    ];
  }
  return normal.startsWith('+') ? [digits, `00${digits}`] : [];
}

export function erasedKeys(
  { phones, emails }: Identifiers,
  /** What the deleted account's numbers and addresses would ALSO be kept by: the other accounts' `phone` and `email` columns. */
  others: Identifiers = { phones: [], emails: [] },
): ErasedKeys {
  const heldNumbers = new Set<string>();
  for (const phone of others.phones) {
    if (typeof phone === 'string' && isStoredPhone(phone)) {
      heldNumbers.add(numberKey(phone));
    }
  }
  const heldAddresses = new Set<string>();
  for (const email of others.emails) {
    if (typeof email === 'string' && email.trim() !== '') {
      heldAddresses.add(addressKey(email));
    }
  }

  const numbers = new Set<string>();
  const digits = new Set<string>();
  for (const stored of phones) {
    // A marker (`deleted:<id>`, `released:<id>`) or nothing is not a number.
    if (typeof stored !== 'string' || !isStoredPhone(stored)) continue;
    // Another account holds it too (the same number in another spelling, the
    // G-16 duplicates): the rows keyed on it are theirs as well.
    if (heldNumbers.has(numberKey(stored))) continue;
    numbers.add(stored);
    numbers.add(stored.trim());
    const normal = comparablePhone(stored);
    if (normal) {
      for (const spelling of phoneVariants(normal)) numbers.add(spelling);
      for (const form of digitForms(normal)) digits.add(form);
    }
  }
  const addresses = new Set<string>();
  for (const email of emails) {
    if (typeof email !== 'string' || email.trim() === '') continue;
    if (heldAddresses.has(addressKey(email))) continue;
    addresses.add(email);
    addresses.add(email.trim());
    addresses.add(addressKey(email));
  }
  return {
    keys: [...numbers, ...addresses],
    budgets: [
      ...numbers,
      ...[...addresses].map((a) => `${SIGNUP_EMAIL_BUDGET}${a}`),
    ],
    otpDigits: [...digits],
  };
}

/**
 * The `phone` and `email` of the OTHER accounts that hold one of these numbers
 * or addresses (JOIN-03 round 5, D11). A number is looked up in the spellings
 * every duplicate check in this service uses (`phoneVariants`), an address
 * without regard to case. Read inside the anonymise's transaction.
 */
export async function otherHolders(
  tx: Prisma.TransactionClient,
  userId: string,
  { phones, emails }: Identifiers,
): Promise<Identifiers> {
  const forms = new Set<string>();
  for (const stored of phones) {
    if (typeof stored !== 'string' || !isStoredPhone(stored)) continue;
    forms.add(stored);
    forms.add(stored.trim());
    const normal = comparablePhone(stored);
    if (normal)
      for (const spelling of phoneVariants(normal)) forms.add(spelling);
  }
  const addresses = new Set<string>();
  for (const email of emails) {
    if (typeof email === 'string' && email.trim() !== '') {
      addresses.add(addressKey(email));
    }
  }
  const any = [
    ...(forms.size > 0 ? [{ phone: { in: [...forms] } }] : []),
    ...[...addresses].map((email) => ({
      email: { equals: email, mode: 'insensitive' as const },
    })),
  ];
  if (any.length === 0) return { phones: [], emails: [] };
  const rows = await tx.wawuUser.findMany({
    where: { id: { not: userId }, OR: any },
    select: { phone: true, email: true },
  });
  return {
    phones: rows.map((r) => r.phone),
    emails: rows.map((r) => r.email),
  };
}

/**
 * The keys two anonymises queue on when the accounts they close hold the same
 * number or address (JOIN-03 round 6, D12). A number is one key in whatever
 * spelling it is stored (the G-16 duplicates hold one number in two), an
 * address one key in any case: the same comparison `erasedKeys` makes to decide
 * who else holds it.
 */
export function erasureLockKeys({ phones, emails }: Identifiers): string[] {
  const keys = new Set<string>();
  for (const stored of phones) {
    if (typeof stored === 'string' && isStoredPhone(stored)) {
      keys.add(`phone:${numberKey(stored)}`);
    }
  }
  for (const email of emails) {
    if (typeof email === 'string' && email.trim() !== '') {
      keys.add(`email:${addressKey(email)}`);
    }
  }
  return [...keys];
}

/**
 * The Postgres advisory-lock ids for these keys, smallest first. Every
 * anonymise takes the ids it needs in this one order, so two of them that share
 * only some of their numbers or addresses can wait on each other but never in a
 * circle.
 */
export function erasureLockIds(keys: readonly string[]): string[] {
  const ids = new Set<bigint>();
  for (const key of keys) {
    ids.add(
      createHash('sha256')
        .update(`wawu-id:erase:${key}`)
        .digest()
        .readBigInt64BE(0),
    );
  }
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(String);
}

/**
 * Takes, for the rest of the transaction, the lock every account that holds
 * one of these numbers or addresses closes under (JOIN-03 round 6, D12). The
 * anonymise decides which counters, wrong-code budgets and codes in flight are
 * the account's own by asking who else holds its number, and that answer is
 * only as good as the moment it is read: two accounts that hold one number and
 * are closed within milliseconds of each other each read "the other one holds
 * it" before the other commits, and each leaves the rows, so nobody holds the
 * number and the rows stay. Under this lock the second one reads after the
 * first has committed, sees it gone, and clears them. The lock is released by
 * the commit; no other path takes it.
 */
export async function lockErasure(
  tx: Prisma.TransactionClient,
  own: Identifiers,
): Promise<void> {
  for (const id of erasureLockIds(erasureLockKeys(own))) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${id}::bigint)`;
  }
}
