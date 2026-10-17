import { BadRequestException } from '@nestjs/common';

/**
 * The nightly money check's report, as the Hub hands it to WAWU ID to be
 * emailed (task MONEY-16, BACKEND_GAPS G-690): counts, the references a person
 * looks up, and amounts. WAWU ID owns the address, the subject and the
 * wording; the Hub only names the person and gives these facts.
 *
 * This route is deliberately not a mail relay and takes nothing it does not
 * name. A leaked service key must not be able to put its own text, a link, a
 * name, a phone number or an account number into a WAWUAfrica email, so
 * `parseMoneyCheckReport` refuses a body that:
 * - has a field not listed here, at any depth;
 * - has a value of the wrong kind, or outside a closed list (a verdict, a
 *   state, a severity);
 * - has a sentence with a character outside letters, digits, spaces and
 *   `. , : ; ' " ( ) _ -`, so no link, address or em-dash fits in it;
 * - has a reference that is only digits (a phone, account or ID number) or
 *   anything but a plain id.
 */

export const REPORT_VERDICTS = [
  'clean',
  'needs_a_look',
  'differences',
  'incomplete',
  'not_checked',
] as const;
export type ReportVerdict = (typeof REPORT_VERDICTS)[number];

const CHECK_STATES = [
  'ok',
  'differences',
  'needs_a_look',
  'incomplete',
  'not_checked',
] as const;
export type ReportCheckState = (typeof CHECK_STATES)[number];

export interface ReportCheck {
  id: string;
  state: ReportCheckState;
  checked: number;
  found: number;
  note: string | null;
}

export interface ReportItem {
  check: string;
  severity: 'mismatch' | 'look';
  kind: string;
  ref: string;
  detail: string;
  amountKobo?: string;
  otherKobo?: string;
}

export interface ReportNotice {
  count: number;
  amountKobo?: string;
}

export interface MoneyCheckReportMail {
  night: string;
  provider: string;
  verdict: ReportVerdict;
  ranAt: string;
  walletsTotal: number;
  walletsChecked: number;
  mismatchCount: number;
  lookCount: number;
  checks: ReportCheck[];
  held: {
    openCount: number;
    openKobo: string;
    requiredKobo: string;
    merchantAvailableKobo: string | null;
  };
  items: ReportItem[];
  itemsOmitted: number;
  notices: Record<string, ReportNotice>;
}

/** The most items one mail carries (the Hub keeps to 100). */
export const MAX_ITEMS = 100;
const MAX_CHECKS = 20;
const MAX_NOTICES = 40;
const MAX_COUNT = 1_000_000_000;

/** A plain sentence: no link, address, symbol or em-dash can be written in it. */
const SENTENCE = /^[A-Za-z0-9 .,:;'"()_-]+$/;
const WORD = /^[a-z][a-z0-9_]{0,59}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const NIGHT = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
/** Kobo as decimal text. Signed: a wallet can be short of what the ledger says it has. */
const KOBO = /^-?\d{1,18}$/;

function refuse(message: string): never {
  throw new BadRequestException(message);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The object has these keys, all required unless listed optional, and no others. */
function shape(
  v: unknown,
  where: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(v)) return refuse(`${where} must be an object.`);
  for (const key of Object.keys(v)) {
    if (!required.includes(key) && !optional.includes(key)) {
      return refuse(
        `${where} has a field this route does not take: ${key.slice(0, 40).replace(/[^A-Za-z0-9_]/g, '')}.`,
      );
    }
  }
  for (const key of required) {
    if (!(key in v)) return refuse(`${where} is missing ${key}.`);
  }
  return v;
}

function count(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_COUNT) {
    return refuse(`${where} must be a whole number from 0 to ${MAX_COUNT}.`);
  }
  return v;
}

function kobo(v: unknown, where: string): string {
  if (typeof v !== 'string' || !KOBO.test(v)) {
    return refuse(`${where} must be an amount in kobo, written as digits.`);
  }
  return v;
}

function word(v: unknown, where: string): string {
  if (typeof v !== 'string' || !WORD.test(v)) {
    return refuse(`${where} must be a short lower-case word.`);
  }
  return v;
}

function sentence(v: unknown, where: string, max: number): string {
  if (
    typeof v !== 'string' ||
    v.length === 0 ||
    v.length > max ||
    !SENTENCE.test(v)
  ) {
    return refuse(
      `${where} must be a plain sentence of up to ${max} letters, digits and ordinary punctuation.`,
    );
  }
  return v;
}

function oneOf<T extends string>(
  v: unknown,
  list: readonly T[],
  where: string,
): T {
  if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) {
    return refuse(`${where} is not one this route knows.`);
  }
  return v as T;
}

/**
 * A reference: the id of a ledger row, a payment, a hold or a wallet, our own
 * reference, or the provider's own id for a movement. Never the length of a
 * phone, account, BVN or ID number written as digits alone (10 or 11 digits,
 * or 234 and ten more): a longer run of digits is a provider's session or
 * transaction id, which a person has to be able to look up.
 */
const NUMBER_LIKE = /^(?:\d{10,11}|234\d{10})$/;

function reference(v: unknown, where: string): string {
  if (
    typeof v !== 'string' ||
    !REF.test(v) ||
    NUMBER_LIKE.test(v.replace(/[._:-]/g, ''))
  ) {
    return refuse(
      `${where} must be a plain id, not a number a person could be known by.`,
    );
  }
  return v;
}

/** Reads the Hub's body, or refuses it with a plain sentence (400). */
export function parseMoneyCheckReport(body: unknown): MoneyCheckReportMail {
  const b = shape(body, 'The report', [
    'night',
    'provider',
    'verdict',
    'ranAt',
    'walletsTotal',
    'walletsChecked',
    'mismatchCount',
    'lookCount',
    'checks',
    'held',
    'items',
    'itemsOmitted',
    'notices',
  ]);
  if (typeof b.night !== 'string' || !NIGHT.test(b.night)) {
    refuse('night must be a date such as 2026-10-12.');
  }
  if (typeof b.ranAt !== 'string' || !INSTANT.test(b.ranAt)) {
    refuse('ranAt must be a UTC time such as 2026-10-12T01:30:00.000Z.');
  }
  if (!Array.isArray(b.checks) || b.checks.length > MAX_CHECKS) {
    refuse(`checks must be a list of at most ${MAX_CHECKS}.`);
  }
  if (!Array.isArray(b.items) || b.items.length > MAX_ITEMS) {
    refuse(`items must be a list of at most ${MAX_ITEMS}.`);
  }
  const held = shape(b.held, 'held', [
    'openCount',
    'openKobo',
    'requiredKobo',
    'merchantAvailableKobo',
  ]);
  const notices = isRecord(b.notices)
    ? b.notices
    : refuse('notices must be an object.');
  if (Object.keys(notices).length > MAX_NOTICES) {
    refuse(`notices holds at most ${MAX_NOTICES} entries.`);
  }
  const checks = (b.checks as unknown[]).map((raw, i): ReportCheck => {
    const c = shape(raw, `checks[${i}]`, [
      'id',
      'state',
      'checked',
      'found',
      'note',
    ]);
    return {
      id: word(c.id, `checks[${i}].id`),
      state: oneOf(c.state, CHECK_STATES, `checks[${i}].state`),
      checked: count(c.checked, `checks[${i}].checked`),
      found: count(c.found, `checks[${i}].found`),
      note:
        c.note === null ? null : sentence(c.note, `checks[${i}].note`, 1000),
    };
  });
  const items = (b.items as unknown[]).map((raw, i): ReportItem => {
    const it = shape(
      raw,
      `items[${i}]`,
      ['check', 'severity', 'kind', 'ref', 'detail'],
      ['amountKobo', 'otherKobo'],
    );
    return {
      check: word(it.check, `items[${i}].check`),
      severity: oneOf(
        it.severity,
        ['mismatch', 'look'],
        `items[${i}].severity`,
      ),
      kind: word(it.kind, `items[${i}].kind`),
      ref: reference(it.ref, `items[${i}].ref`),
      detail: sentence(it.detail, `items[${i}].detail`, 400),
      ...(it.amountKobo === undefined
        ? {}
        : { amountKobo: kobo(it.amountKobo, `items[${i}].amountKobo`) }),
      ...(it.otherKobo === undefined
        ? {}
        : { otherKobo: kobo(it.otherKobo, `items[${i}].otherKobo`) }),
    };
  });
  const parsedNotices: Record<string, ReportNotice> = {};
  for (const [key, raw] of Object.entries(notices)) {
    const n = shape(
      raw,
      `notices.${key.slice(0, 40)}`,
      ['count'],
      ['amountKobo'],
    );
    parsedNotices[word(key, 'A notice name')] = {
      count: count(n.count, `notices.${key}.count`),
      ...(n.amountKobo === undefined
        ? {}
        : { amountKobo: kobo(n.amountKobo, `notices.${key}.amountKobo`) }),
    };
  }
  return {
    night: b.night,
    provider: word(b.provider, 'provider'),
    verdict: oneOf(b.verdict, REPORT_VERDICTS, 'verdict'),
    ranAt: b.ranAt,
    walletsTotal: count(b.walletsTotal, 'walletsTotal'),
    walletsChecked: count(b.walletsChecked, 'walletsChecked'),
    mismatchCount: count(b.mismatchCount, 'mismatchCount'),
    lookCount: count(b.lookCount, 'lookCount'),
    checks,
    held: {
      openCount: count(held.openCount, 'held.openCount'),
      openKobo: kobo(held.openKobo, 'held.openKobo'),
      requiredKobo: kobo(held.requiredKobo, 'held.requiredKobo'),
      merchantAvailableKobo:
        held.merchantAvailableKobo === null
          ? null
          : kobo(held.merchantAvailableKobo, 'held.merchantAvailableKobo'),
    },
    items,
    itemsOmitted: count(b.itemsOmitted, 'itemsOmitted'),
    notices: parsedNotices,
  };
}

// ---------------------------------------------------------------------------
// Words for the mail
// ---------------------------------------------------------------------------

/** Naira written from kobo with no floating point: 123456 is "NGN 1,234.56". */
export function nairaOf(koboText: string): string {
  const n = BigInt(koboText);
  const abs = n < 0n ? -n : n;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = (abs % 100n).toString().padStart(2, '0');
  return `NGN ${n < 0n ? '-' : ''}${whole}.${cents}`;
}

export const VERDICT_SUBJECT: Record<ReportVerdict, string> = {
  clean: 'all clear',
  needs_a_look: 'something to look at',
  differences: 'differences found',
  incomplete: 'not finished',
  not_checked: 'not checked',
};

export const VERDICT_SENTENCE: Record<ReportVerdict, string> = {
  clean: 'Everything matched. Nothing differs and nothing needs a look.',
  needs_a_look: 'Nothing differs, but something needs a person to look at it.',
  differences:
    'The ledger and the provider differ. A person needs to look at this today.',
  incomplete:
    'The check could not be made in full, so this night is not clear. It is not a clean night.',
  not_checked:
    'The provider could not be asked, so nothing was compared. This is not a clean night.',
};

const CHECK_LABELS: Record<string, string> = {
  movements: 'Wallet debits',
  merchant_movements: "WAWU's own account, debits",
  balances: 'Wallet balances',
  held_money: 'Held money',
  merchant_charges: "WAWU's charge on each send",
  ledger_rows: 'Ledger rows',
  payments: 'Payments',
  holds: 'Holds',
};

export const STATE_LABELS: Record<ReportCheckState, string> = {
  ok: 'Matched',
  differences: 'Differences found',
  needs_a_look: 'Something to look at',
  incomplete: 'Not all of it could be checked',
  not_checked: 'Not checked',
};

/** A name made readable: a known check, or its id with spaces. */
export function labelOf(id: string): string {
  // Own keys only: an id named `constructor` is not a label (SWEEP-MONEY, MONEY-16 RF-3).
  if (Object.hasOwn(CHECK_LABELS, id)) return CHECK_LABELS[id];
  const spaced = id.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const plural = (n: number, one: string, many: string): string =>
  n === 1 ? one : many;

const NOTICE_SENTENCES: Record<string, (n: ReportNotice) => string> = {
  wallets_opened_during_run: (n) =>
    `${n.count} ${plural(n.count, 'wallet was', 'wallets were')} opened while the check ran. ${plural(n.count, 'It is', 'They are')} checked tomorrow.`,
  balance_booked_differs: (n) =>
    `${n.count} ${plural(n.count, 'wallet has', 'wallets have')} a booked balance that is not the available one.`,
  ledger_accounts_without_wallet: (n) =>
    `${n.count} ${plural(n.count, 'account has', 'accounts have')} ledger rows and no wallet.`,
  holds_waiting_for_payee_wallet: (n) =>
    `${n.count} ${plural(n.count, 'hold waits', 'holds wait')} for a creator to open a wallet${n.amountKobo ? `, ${nairaOf(n.amountKobo)} in all` : ''}.`,
  too_new_to_judge: (n) =>
    `${n.count} ${plural(n.count, 'movement was', 'movements were')} too new to judge. ${plural(n.count, 'It is', 'They are')} checked tomorrow.`,
  provider_charges_to_wawu: (n) =>
    `${n.count} ${plural(n.count, 'charge', 'charges')} the provider made to WAWU itself${n.amountKobo ? `, ${nairaOf(n.amountKobo)} in all` : ''}.`,
  provider_pending_not_in_ledger: (n) =>
    `${n.count} pending ${plural(n.count, 'record', 'records')} at the provider that the ledger does not have${n.amountKobo ? `, ${nairaOf(n.amountKobo)} in all` : ''}. No money moved.`,
  provider_failed_not_in_ledger: (n) =>
    `${n.count} failed ${plural(n.count, 'record', 'records')} at the provider that the ledger does not have${n.amountKobo ? `, ${nairaOf(n.amountKobo)} in all` : ''}. No money moved.`,
  payments_differ_from_quote: (n) =>
    `${n.count} completed ${plural(n.count, 'payment', 'payments')} came to a different total than the quote.`,
};

/** One line for a notice: a known one in plain words, any other by name and count. */
export function noticeSentence(key: string, n: ReportNotice): string {
  if (Object.hasOwn(NOTICE_SENTENCES, key)) return NOTICE_SENTENCES[key](n);
  return `${labelOf(key)}: ${n.count}${n.amountKobo ? `, ${nairaOf(n.amountKobo)}` : ''}.`;
}

/** The mail's subject. */
export function subjectOf(r: MoneyCheckReportMail): string {
  return `WAWU money check ${r.night}: ${VERDICT_SUBJECT[r.verdict]}`;
}
