import { BadRequestException } from '@nestjs/common';

/**
 * The notice kinds the Hub may ask for (EMAIL-01, POST /internal/mail/notice),
 * and the checks on each kind's `data`. This is the contract in
 * scratchpad `emails-contract.md`: amounts are minor units with a currency
 * code, times are ISO, and a field marked "|null" there may be null here.
 *
 * Every refusal is a 400 with one plain sentence naming the field as
 * `data.<field>`. A field this service does not know is ignored, so the Hub
 * can add one without breaking a send.
 */
export const NOTICE_KINDS = [
  'pin_changed',
  'account_deletion_started',
  'account_deleted',
  'money_in',
  'bank_send_completed',
  'bank_send_failed',
  'sale_made',
  'tip_received',
  'paid_message_received',
  'refund_processed',
  'purchase_receipt',
  'ticket_confirmed',
  'event_cancelled',
  'bill_paid',
] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

export const PAID_WHEN = [
  'now',
  'in_3_working_days',
  'when_wallet_opens',
] as const;
export type PaidWhen = (typeof PAID_WHEN)[number];

export const RETURNED_TO = [
  'wallet',
  'card',
  'source_account',
  'question_credit',
] as const;
export type ReturnedTo = (typeof RETURNED_TO)[number];

export interface NoticeData {
  pin_changed: { at: string };
  account_deletion_started: { deleteOn: string };
  account_deleted: Record<string, never>;
  money_in: {
    amountMinor: number;
    currency: string;
    senderName: string | null;
  };
  bank_send_completed: {
    amountMinor: number;
    feeMinor: number;
    currency: string;
    recipientName: string;
    bankName: string;
    accountLast4: string;
    reference: string;
  };
  bank_send_failed: {
    amountMinor: number;
    returnedMinor: number;
    currency: string;
    reference: string;
  };
  sale_made: {
    itemTitle: string;
    buyerName: string | null;
    earnedMinor: number;
    currency: string;
    paidWhen: PaidWhen;
  };
  tip_received: {
    earnedMinor: number;
    currency: string;
    fromName: string | null;
    paidWhen: PaidWhen;
  };
  paid_message_received: {
    fromName: string | null;
    earnedMinor: number;
    currency: string;
    replyBy: string;
  };
  refund_processed: {
    what: string;
    amountMinor: number | null;
    currency: string | null;
    returnedTo: ReturnedTo;
  };
  purchase_receipt: {
    itemTitle: string;
    paidMinor: number;
    currency: string;
    reference: string;
  };
  ticket_confirmed: {
    eventTitle: string;
    startsAt: string;
    place: string | null;
    paidMinor: number;
    currency: string;
    ticketRef: string;
  };
  event_cancelled: {
    eventTitle: string;
    refundMinor: number | null;
    currency: string | null;
  };
  bill_paid: {
    billerName: string;
    customerRef: string;
    amountMinor: number;
    currency: string;
    token: string | null;
    units: string | null;
    reference: string;
  };
}

export type ParsedNotice = {
  [K in NoticeKind]: { kind: K; data: NoticeData[K] };
}[NoticeKind];

function refuse(field: string, rule: string): never {
  throw new BadRequestException(`data.${field} ${rule}.`);
}

type Raw = Record<string, unknown>;

// A line of text a person reads: no control characters, so no line break can
// reach a subject or a header.
function hasControl(value: string): boolean {
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

function text(raw: Raw, field: string, max = 300): string {
  const value = raw[field];
  if (typeof value !== 'string') refuse(field, 'must be text');
  const trimmed = value.trim();
  if (trimmed.length === 0) refuse(field, 'must not be empty');
  if (trimmed.length > max) refuse(field, `must be at most ${max} characters`);
  if (hasControl(trimmed)) refuse(field, 'must be one line of text');
  return trimmed;
}

function textOrNull(raw: Raw, field: string, max = 300): string | null {
  return raw[field] === null || raw[field] === undefined
    ? null
    : text(raw, field, max);
}

/** Whole minor units, 0 or more, that a number can hold exactly. */
function amount(raw: Raw, field: string, positive = false): number {
  const value = raw[field];
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < (positive ? 1 : 0) ||
    // A hundred trillion naira in kobo: no real figure, and well under 2^53.
    value > 1e16
  ) {
    refuse(
      field,
      positive
        ? 'must be a whole number of minor units above zero'
        : 'must be a whole number of minor units, zero or more',
    );
  }
  return value;
}

function currency(raw: Raw, field = 'currency'): string {
  const value = raw[field];
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    refuse(field, 'must be a three-letter capital currency code such as NGN');
  }
  return value;
}

function iso(raw: Raw, field: string): string {
  const value = raw[field];
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    refuse(field, 'must be an ISO 8601 time such as 2026-11-14T18:00:00Z');
  }
  // A valid shape can still be a day that does not exist (month 13 parses to
  // NaN above; 31 February rolls over), so the day is compared once more.
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    refuse(field, 'must be a real day');
  }
  return value;
}

function oneOf<T extends string>(
  raw: Raw,
  field: string,
  list: readonly T[],
): T {
  const value = raw[field];
  if (
    typeof value !== 'string' ||
    !(list as readonly string[]).includes(value)
  ) {
    refuse(field, `must be one of ${list.join(', ')}`);
  }
  return value as T;
}

/** An amount and its currency, both given or both null. */
function optionalMoney(
  raw: Raw,
  amountField: string,
): { amount: number | null; currency: string | null } {
  const hasAmount = raw[amountField] !== null && raw[amountField] !== undefined;
  const hasCurrency = raw.currency !== null && raw.currency !== undefined;
  if (!hasAmount && !hasCurrency) return { amount: null, currency: null };
  if (!hasAmount) refuse(amountField, 'is needed when currency is given');
  if (!hasCurrency) refuse('currency', 'is needed when an amount is given');
  return { amount: amount(raw, amountField), currency: currency(raw) };
}

/** Text or a number (a meter's units may arrive as either), kept as text. */
function textOrNumberOrNull(raw: Raw, field: string, max = 60): string | null {
  const value = raw[field];
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      refuse(field, 'must be text or a number of zero or more');
    }
    return String(value);
  }
  if (typeof value !== 'string') refuse(field, 'must be text or a number');
  return text(raw, field, max);
}

/**
 * Check `data` for `kind` and keep only the fields the contract names.
 * Throws a 400 for an unknown kind, data that is not an object, or any field
 * that does not fit.
 */
export function parseNotice(kind: string, data: unknown): ParsedNotice {
  if (!(NOTICE_KINDS as readonly string[]).includes(kind)) {
    throw new BadRequestException(
      `kind must be one of ${NOTICE_KINDS.join(', ')}.`,
    );
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new BadRequestException('data must be an object.');
  }
  const raw = data as Raw;
  switch (kind as NoticeKind) {
    case 'pin_changed':
      return { kind: 'pin_changed', data: { at: iso(raw, 'at') } };
    case 'account_deletion_started':
      return {
        kind: 'account_deletion_started',
        data: { deleteOn: iso(raw, 'deleteOn') },
      };
    case 'account_deleted':
      return { kind: 'account_deleted', data: {} };
    case 'money_in':
      return {
        kind: 'money_in',
        data: {
          amountMinor: amount(raw, 'amountMinor', true),
          currency: currency(raw),
          senderName: textOrNull(raw, 'senderName', 120),
        },
      };
    case 'bank_send_completed': {
      const accountLast4 = raw.accountLast4;
      if (typeof accountLast4 !== 'string' || !/^\d{4}$/.test(accountLast4)) {
        refuse('accountLast4', 'must be exactly four digits');
      }
      return {
        kind: 'bank_send_completed',
        data: {
          amountMinor: amount(raw, 'amountMinor', true),
          feeMinor: amount(raw, 'feeMinor'),
          currency: currency(raw),
          recipientName: text(raw, 'recipientName', 120),
          bankName: text(raw, 'bankName', 120),
          accountLast4,
          reference: text(raw, 'reference', 100),
        },
      };
    }
    case 'bank_send_failed':
      return {
        kind: 'bank_send_failed',
        data: {
          amountMinor: amount(raw, 'amountMinor', true),
          returnedMinor: amount(raw, 'returnedMinor'),
          currency: currency(raw),
          reference: text(raw, 'reference', 100),
        },
      };
    case 'sale_made':
      return {
        kind: 'sale_made',
        data: {
          itemTitle: text(raw, 'itemTitle'),
          buyerName: textOrNull(raw, 'buyerName', 120),
          earnedMinor: amount(raw, 'earnedMinor'),
          currency: currency(raw),
          paidWhen: oneOf(raw, 'paidWhen', PAID_WHEN),
        },
      };
    case 'tip_received':
      return {
        kind: 'tip_received',
        data: {
          earnedMinor: amount(raw, 'earnedMinor'),
          currency: currency(raw),
          fromName: textOrNull(raw, 'fromName', 120),
          paidWhen: oneOf(raw, 'paidWhen', PAID_WHEN),
        },
      };
    case 'paid_message_received':
      return {
        kind: 'paid_message_received',
        data: {
          fromName: textOrNull(raw, 'fromName', 120),
          earnedMinor: amount(raw, 'earnedMinor'),
          currency: currency(raw),
          replyBy: iso(raw, 'replyBy'),
        },
      };
    case 'refund_processed': {
      const money = optionalMoney(raw, 'amountMinor');
      return {
        kind: 'refund_processed',
        data: {
          what: text(raw, 'what'),
          amountMinor: money.amount,
          currency: money.currency,
          returnedTo: oneOf(raw, 'returnedTo', RETURNED_TO),
        },
      };
    }
    case 'purchase_receipt':
      return {
        kind: 'purchase_receipt',
        data: {
          itemTitle: text(raw, 'itemTitle'),
          paidMinor: amount(raw, 'paidMinor', true),
          currency: currency(raw),
          reference: text(raw, 'reference', 100),
        },
      };
    case 'ticket_confirmed':
      return {
        kind: 'ticket_confirmed',
        data: {
          eventTitle: text(raw, 'eventTitle'),
          startsAt: iso(raw, 'startsAt'),
          place: textOrNull(raw, 'place'),
          // A free ticket (R-8) is 0.
          paidMinor: amount(raw, 'paidMinor'),
          currency: currency(raw),
          ticketRef: text(raw, 'ticketRef', 100),
        },
      };
    case 'event_cancelled': {
      const money = optionalMoney(raw, 'refundMinor');
      return {
        kind: 'event_cancelled',
        data: {
          eventTitle: text(raw, 'eventTitle'),
          refundMinor: money.amount,
          currency: money.currency,
        },
      };
    }
    case 'bill_paid':
      return {
        kind: 'bill_paid',
        data: {
          billerName: text(raw, 'billerName', 120),
          customerRef: text(raw, 'customerRef', 60),
          amountMinor: amount(raw, 'amountMinor', true),
          currency: currency(raw),
          token: textOrNull(raw, 'token', 120),
          units: textOrNumberOrNull(raw, 'units'),
          reference: text(raw, 'reference', 100),
        },
      };
  }
}
