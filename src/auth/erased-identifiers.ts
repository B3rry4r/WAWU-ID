import { normalisePhone, phoneVariants } from '../common/phone.util';
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
 *    caller wrote it.
 *
 * `anonymise` deletes those rows. They are counters and one-time codes, not
 * history: the account is closed and nothing can confirm a code against it, and
 * whoever holds the number or address next starts clean.
 */
export interface Identifiers {
  /** The deleted person's numbers (stored text, as typed) and addresses. */
  phones: Array<string | null | undefined>;
  emails: Array<string | null | undefined>;
}

export interface ErasedKeys {
  /** `rate_counters.key` and `otp_sessions.phone`: every spelling of each number, and each address. */
  keys: string[];
  /** `phone_guess_budgets.phone`: the numbers, and `signup-email:<address>` for each address. */
  budgets: string[];
}

/** The prefix the mailed sign-up keys its wrong-code budget with (email-signup.service.ts). */
export const SIGNUP_EMAIL_BUDGET = 'signup-email:';

export function erasedKeys({ phones, emails }: Identifiers): ErasedKeys {
  const numbers = new Set<string>();
  for (const stored of phones) {
    // A marker (`deleted:<id>`, `released:<id>`) or nothing is not a number.
    if (typeof stored !== 'string' || !isStoredPhone(stored)) continue;
    numbers.add(stored);
    numbers.add(stored.trim());
    const normal = normalisePhone(stored);
    if (normal)
      for (const spelling of phoneVariants(normal)) numbers.add(spelling);
  }
  const addresses = new Set<string>();
  for (const email of emails) {
    if (typeof email === 'string' && email.trim() !== '') {
      addresses.add(email);
      addresses.add(email.trim());
    }
  }
  return {
    keys: [...numbers, ...addresses],
    budgets: [
      ...numbers,
      ...[...addresses].map((a) => `${SIGNUP_EMAIL_BUDGET}${a}`),
    ],
  };
}
