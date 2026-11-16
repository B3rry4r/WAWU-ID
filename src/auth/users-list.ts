import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  callingCodes,
  comparablePhone,
  phoneVariants,
} from '../common/phone.util';
import { phoneIsProven } from './phone-proof';
import { DELETED_PHONE_PREFIX, isStoredPhone } from './released-phone';

/**
 * POST /internal/users/list (R-142, R-143): the people list the Hub's
 * dashboard shows. One internal read; nothing here is public.
 *
 * Every message below is fixed text. A `q`, an email or a phone number is never
 * put into an error message and never logged.
 */

export const LIST_MAX_IDS = 200;
export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 100;
export const Q_MIN = 2;
export const Q_MAX = 120;
/** A name has a handful of words; more spaces than this in `q` are not tried as a "first last" split. */
const MAX_NAME_SPLITS = 8;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The only fields this route reads from a row. No hash, token or code is selected. */
export const LIST_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  countryCode: true,
  createdAt: true,
  emailVerified: true,
  phoneVerifiedAt: true,
  phoneVerifiedFor: true,
} as const;

export interface ListedUser {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string;
  countryCode: string | null;
  createdAt: string;
  emailVerified: boolean;
  phoneVerified: boolean;
}

export interface ListUsersResult {
  items: ListedUser[];
  nextCursor: string | null;
}

type ListRow = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string;
  countryCode: string | null;
  createdAt: Date;
  emailVerified: boolean;
  phoneVerifiedAt: Date | null;
  phoneVerifiedFor: string | null;
};

export type ListRequest =
  | { kind: 'ids'; ids: string[] }
  | { kind: 'page'; q: string | null; limit: number; cursor: Cursor | null };

interface Cursor {
  createdAt: Date;
  id: string;
}

function bad(message: string): never {
  throw new BadRequestException(message);
}

export function encodeCursor(c: { createdAt: Date; id: string }): string {
  return Buffer.from(`${c.createdAt.getTime()}|${c.id}`, 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(raw: string): Cursor {
  if (raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    bad('Invalid cursor.');
  }
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const m = /^(\d{1,15})\|([0-9a-f-]{36})$/i.exec(text);
  if (!m || !UUID.test(m[2])) bad('Invalid cursor.');
  const createdAt = new Date(Number(m[1]));
  if (Number.isNaN(createdAt.getTime())) bad('Invalid cursor.');
  return { createdAt, id: m[2].toLowerCase() };
}

/** Reads and checks the body by hand, so `ids` really does make the rest ignored. */
export function parseListBody(body: unknown): ListRequest {
  const b =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  if (b.ids !== undefined && b.ids !== null) {
    if (!Array.isArray(b.ids)) bad('ids must be a list of user ids.');
    if (b.ids.length < 1 || b.ids.length > LIST_MAX_IDS) {
      bad(`ids must hold 1 to ${LIST_MAX_IDS} user ids.`);
    }
    if (!b.ids.every((x) => typeof x === 'string')) {
      bad('Every id must be a string.');
    }
    return { kind: 'ids', ids: [...new Set<string>(b.ids)] };
  }

  let q: string | null = null;
  if (b.q !== undefined && b.q !== null) {
    if (typeof b.q !== 'string') bad('q must be text.');
    if (b.q.includes('\u0000')) bad('q must be text.');
    const t = b.q.trim();
    if (t.length < Q_MIN) bad(`q must be at least ${Q_MIN} characters.`);
    if (t.length > Q_MAX) bad(`q must be at most ${Q_MAX} characters.`);
    q = t;
  }

  let limit = LIST_DEFAULT_LIMIT;
  if (b.limit !== undefined && b.limit !== null) {
    if (
      typeof b.limit !== 'number' ||
      !Number.isInteger(b.limit) ||
      b.limit < 1 ||
      b.limit > LIST_MAX_LIMIT
    ) {
      bad(`limit must be a whole number from 1 to ${LIST_MAX_LIMIT}.`);
    }
    limit = b.limit;
  }

  let cursor: Cursor | null = null;
  if (b.cursor !== undefined && b.cursor !== null) {
    if (typeof b.cursor !== 'string') bad('Invalid cursor.');
    cursor = decodeCursor(b.cursor);
  }

  return { kind: 'page', q, limit, cursor };
}

/**
 * Only DELETED accounts are left out: a `deletedAt` stamp, or the
 * `deleted:<id>` phone marker the anonymise step writes. Banned and
 * pending_deletion accounts are returned (an admin has to be able to find them,
 * and a pending deletion can still be cancelled). Written as a where clause so
 * the database does the leaving out.
 */
export const NOT_DELETED_WHERE: Prisma.WawuUserWhereInput = {
  deletedAt: null,
  NOT: { phone: { startsWith: DELETED_PHONE_PREFIX } },
};

/**
 * Prisma passes `%` and `_` of a `contains`/`startsWith`/`endsWith`/insensitive
 * `equals` value on to LIKE, where they are wildcards: `%%` would match every
 * user. Each is escaped so `q` is always plain text.
 */
export function plain(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The `q` match: name part, "first last" part, whole email, or whole phone. */
/** Every stored spelling a whole phone number typed as `q` could have. */
export function phoneCandidates(q: string): string[] {
  const out = new Set<string>();
  const phone = comparablePhone(q);
  if (phone) for (const v of phoneVariants(phone)) out.add(v);
  const digits = q.replace(/[\s\-().]/g, '');
  if (/^\d{7,15}$/.test(digits)) {
    // `447911123456`: the international form written without its `+`.
    out.add(`+${digits}`);
    // `07911 123456`, `0241234567`: the local form, any supported country.
    if (digits.startsWith('0')) {
      for (const dial of callingCodes()) out.add(`+${dial}${digits.slice(1)}`);
    }
  }
  return [...out];
}

/**
 * A `q` made only of digits and the marks people put in a phone number, with 7
 * to 15 digits, is a phone number: it is searched as one exact `phone in (...)`
 * (the unique index) and not also as a name, which would force a table scan. A
 * name made only of digits is not a thing.
 */
function looksLikePhone(q: string): boolean {
  if (!/^\+?[\d\s\-().]+$/.test(q)) return false;
  const n = q.replace(/\D/g, '').length;
  return n >= 7 && n <= 15;
}

export function searchWhere(q: string): Prisma.WawuUserWhereInput {
  if (looksLikePhone(q)) {
    return { phone: { in: phoneCandidates(q) } };
  }
  const ci = 'insensitive' as const;
  const or: Prisma.WawuUserWhereInput[] = [
    { firstName: { contains: plain(q), mode: ci } },
    { lastName: { contains: plain(q), mode: ci } },
    { email: { equals: plain(q), mode: ci } },
  ];

  // Part of "first last": the text before a space of `q` ends the first name,
  // the text after it starts the last name.
  let at = q.indexOf(' ');
  let tried = 0;
  while (at > 0 && at < q.length - 1 && tried < MAX_NAME_SPLITS) {
    or.push({
      AND: [
        { firstName: { endsWith: plain(q.slice(0, at)), mode: ci } },
        { lastName: { startsWith: plain(q.slice(at + 1)), mode: ci } },
      ],
    });
    tried += 1;
    at = q.indexOf(' ', at + 1);
  }

  // A short run of digits, or a mixed text that still reads as a phone.
  const phones = phoneCandidates(q);
  if (phones.length > 0) or.push({ phone: { in: phones } });

  return { OR: or };
}

export function pageWhere(
  req: Extract<ListRequest, { kind: 'page' }>,
): Prisma.WawuUserWhereInput {
  const and: Prisma.WawuUserWhereInput[] = [{ ...NOT_DELETED_WHERE }];
  if (req.q) and.push(searchWhere(req.q));
  if (req.cursor) {
    and.push({
      OR: [
        { createdAt: { lt: req.cursor.createdAt } },
        { createdAt: req.cursor.createdAt, id: { lt: req.cursor.id } },
      ],
    });
  }
  return { AND: and };
}

export function idsWhere(ids: string[]): Prisma.WawuUserWhereInput {
  // A string that is not a uuid cannot be an id here, so it is simply not found
  // (and never reaches the uuid column).
  const valid = ids.filter((id) => UUID.test(id)).map((id) => id.toLowerCase());
  return { AND: [{ ...NOT_DELETED_WHERE }, { id: { in: valid } }] };
}

export function toListed(r: ListRow): ListedUser {
  return {
    id: r.id,
    firstName: r.firstName,
    lastName: r.lastName,
    email: r.email,
    // `released:<id>` is a marker, not a phone: carried as empty, like the token does.
    phone: isStoredPhone(r.phone) ? r.phone : '',
    countryCode: r.countryCode ?? null,
    createdAt: r.createdAt.toISOString(),
    emailVerified: r.emailVerified,
    phoneVerified: phoneIsProven(r),
  };
}
