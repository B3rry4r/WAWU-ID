import { HttpException } from '@nestjs/common';
import { DELETED_PHONE_PREFIX } from './released-phone';

/**
 * Deleting an account waits 30 days and a sign-in during them cancels it
 * (R-17, tasks SETTINGS-06 for the Hub and SETTINGS-08 for WAWU ID).
 *
 * Who does what:
 *  - The Hub schedules the deletion (wallet empty first, wallet frozen, content
 *    hidden) and tells WAWU ID: `POST /internal/users/:id/mark-deletion`.
 *  - WAWU ID closes the account for those 30 days (`pending_deletion`, every
 *    session revoked) and keeps a `deletion_windows` row with the end date.
 *  - A sign-in with the right password during the 30 days asks the Hub to
 *    cancel (`POST /api/hub/account/cancel-deletion`, with a fresh token of the
 *    person) and, only when the Hub has, brings the account back.
 *  - At day 30 the HUB's purge sweep deletes its data and then asks WAWU ID to
 *    anonymise (`DELETE /internal/users/:id?mode=anonymize`). WAWU ID does not
 *    delete the identity on its own clock: only the Hub can see money that is
 *    still owed, and an identity gone before the Hub's data is deleted would
 *    leave that money with nobody to claim it. WAWU ID's clock only decides
 *    that, from the end date on, a sign-in no longer cancels anything.
 */
export const DELETION_GRACE_DAYS = 30;
export const DELETION_GRACE_MS = DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000;

/** A `purgeAfter` the Hub sends may differ from 30 days by this much, no more. */
export const PURGE_AFTER_SLACK_MS = 24 * 60 * 60 * 1000;

/** How long a sign-in's claim on the cancel holds; a crashed one lets go after this. */
export const CANCEL_CLAIM_TTL_MS = 2 * 60 * 1000;

/** How long a sign-in that finds another one cancelling waits for it, and how often it looks. */
export const CANCEL_WAIT_MS = 6000;
export const CANCEL_POLL_MS = 150;

/** How long the Hub gets to answer the cancel. */
export const HUB_CANCEL_TIMEOUT_MS = 8000;

/** The end of the 30 days: the Hub's own `purgeAfter` when it is believable, else 30 days after `markedAt`. */
export function deletionDueAt(markedAt: Date, purgeAfter?: Date | null): Date {
  const standard = markedAt.getTime() + DELETION_GRACE_MS;
  if (
    purgeAfter &&
    !Number.isNaN(purgeAfter.getTime()) &&
    Math.abs(purgeAfter.getTime() - standard) <= PURGE_AFTER_SLACK_MS
  ) {
    return purgeAfter;
  }
  return new Date(standard);
}

/**
 * An access token carries whole seconds (`iat`). Revoking "everything issued
 * up to now" has to include a token issued in this same second, so the
 * instant is the START of the next second: every token issued before `at` has
 * an `iat` below it, and a token issued from that instant on has an `iat` at
 * or above it.
 */
export function ceilToSecond(at: Date): Date {
  return new Date((Math.floor(at.getTime() / 1000) + 1) * 1000);
}

/** An account the Hub finished deleting: its details are gone and it is barred for good. */
export function isAnonymised(user: {
  phone: string;
  status: string;
  deletedAt: Date | null;
}): boolean {
  return (
    typeof user.phone === 'string' &&
    user.phone.startsWith(DELETED_PHONE_PREFIX)
  );
}

/** In its 30 days of deletion, or deleted: nothing a service sends on its own goes to it. */
export function isDeletedOrDeleting(user: {
  status: string;
  deletedAt: Date | null;
}): boolean {
  return user.status === 'pending_deletion' || user.deletedAt != null;
}

export type DeletionRefusalCode =
  | 'ACCOUNT_DELETION_PERIOD_ENDED'
  | 'ACCOUNT_DELETION_IN_PROGRESS'
  | 'DELETION_CANCEL_UNAVAILABLE'
  | 'DELETION_CANCEL_BUSY'
  | 'ACCOUNT_DELETION_PENDING';

/** One error shape for every refusal: statusCode, code, message. No em-dashes in any message. */
export function deletionRefusal(
  status: number,
  code: DeletionRefusalCode,
  message: string,
): HttpException {
  return new HttpException({ statusCode: status, code, message }, status);
}

export const PERIOD_ENDED_MESSAGE =
  'This account was scheduled for deletion more than 30 days ago, so it can no longer be restored.';

export const IN_PROGRESS_FALLBACK_MESSAGE =
  'Your account is already being deleted, so it can no longer be restored.';

export const UNAVAILABLE_MESSAGE =
  'We could not restore your account right now. Nothing was changed. Try again in a moment.';

export const BUSY_MESSAGE =
  'Your sign-in is already being processed. Try again in a moment.';

export const PENDING_MESSAGE =
  'This account is scheduled for deletion. Sign in with your password to keep it.';
