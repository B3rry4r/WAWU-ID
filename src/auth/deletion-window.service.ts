import { NotFoundException } from '@nestjs/common';
import type { WawuUser } from '@prisma/client';
import { randomUUID } from 'crypto';
import { setTimeout as sleep } from 'timers/promises';
import { PrismaService } from '../prisma/prisma.service';
import {
  BUSY_MESSAGE,
  CANCEL_CLAIM_TTL_MS,
  CANCEL_POLL_MS,
  CANCEL_WAIT_MS,
  DELETION_GRACE_MS,
  IN_PROGRESS_FALLBACK_MESSAGE,
  PERIOD_ENDED_MESSAGE,
  UNAVAILABLE_MESSAGE,
  ceilToSecond,
  deletionDueAt,
  deletionRefusal,
  isAnonymised,
} from './deletion-window';
import {
  HubAccountClient,
  HubUnavailableError,
  type HubCancelResult,
} from './hub-account.client';
import { TokensService } from './tokens.service';

/** What a sign-in is given back: the account to open a session for. */
export interface SignInOutcome {
  user: WawuUser;
  /** True only when THIS sign-in cancelled the deletion and told the Hub. */
  cancelled: boolean;
}

/** Waits until a token issued now is newer than the account's revocation stamp (a stamp is rounded up to the next whole second). */
async function waitForRevocationStamp(user: WawuUser): Promise<void> {
  if (!user.sessionsRevokedAt) return;
  const wait = user.sessionsRevokedAt.getTime() - Date.now();
  if (wait > 0) await sleep(wait + 5);
}

type Claim =
  | { kind: 'not_pending'; user: WawuUser | null }
  | { kind: 'ended' }
  | { kind: 'busy' }
  | { kind: 'claimed'; claimId: string; user: WawuUser };

/**
 * The WAWU ID side of deleting an account (SETTINGS-08, R-17). See
 * `deletion-window.ts` for who does what.
 *
 * No transaction, lock or pooled connection is held while the Hub answers:
 * the claim is taken under a short lock, the Hub is called holding nothing,
 * and the result is recorded under a second short lock that checks the claim
 * is still the caller's.
 */
export class DeletionWindowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    private readonly hub: HubAccountClient,
  ) {}

  // ── the Hub starts the 30 days ────────────────────────────────────────────

  /**
   * `POST /internal/users/:id/mark-deletion`. Idempotent: asked again, the date
   * does not move (the Hub's own repeat request leaves its date alone, so
   * neither does this). Every session is revoked on every call, as before.
   *
   *  - an active account becomes `pending_deletion`, with its end date;
   *  - one that is already pending keeps its date and any sign-in that is
   *    cancelling right now is told to try again (the Hub may have scheduled a
   *    new deletion after cancelling the old one, and that sign-in must not
   *    clear it);
   *  - a banned or suspended account keeps its status: a deletion never lifts a
   *    ban (a cancel could not know to put it back);
   *  - an account the Hub already anonymised is left exactly as it is.
   */
  async mark(
    userId: string,
    purgeAfter?: Date | null,
  ): Promise<{ id: string; status: string }> {
    return this.prisma.$transaction(async (tx) => {
      await this.tokens.lockAccount(tx, userId);
      const user = await tx.wawuUser.findUnique({ where: { id: userId } });
      if (!user) throw new NotFoundException('User not found');
      if (isAnonymised(user)) return { id: user.id, status: user.status };

      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.passwordResetToken.deleteMany({ where: { userId } });

      if (user.status === 'active') {
        const now = new Date();
        const stamp = ceilToSecond(now);
        await tx.wawuUser.update({
          where: { id: userId },
          data: {
            status: 'pending_deletion',
            deletedAt: now,
            sessionsRevokedAt:
              user.sessionsRevokedAt && user.sessionsRevokedAt > stamp
                ? user.sessionsRevokedAt
                : stamp,
          },
        });
        await tx.deletionWindow.upsert({
          where: { userId },
          create: {
            userId,
            markedAt: now,
            dueAt: deletionDueAt(now, purgeAfter),
          },
          update: {
            markedAt: now,
            dueAt: deletionDueAt(now, purgeAfter),
            cancelClaimId: null,
            cancelClaimedAt: null,
          },
        });
        return { id: user.id, status: 'pending_deletion' };
      }

      if (user.status === 'pending_deletion') {
        const markedAt = user.deletedAt ?? new Date();
        // A row marked before this window existed has none: its end is 30 days
        // after the moment it was marked.
        await tx.deletionWindow.upsert({
          where: { userId },
          create: {
            userId,
            markedAt,
            dueAt: new Date(markedAt.getTime() + DELETION_GRACE_MS),
          },
          update: { cancelClaimId: null, cancelClaimedAt: null },
        });
        // A row marked before sessions were stamped gets its stamp now, from
        // the moment it was marked.
        if (!user.sessionsRevokedAt) {
          await tx.wawuUser.update({
            where: { id: userId },
            data: { sessionsRevokedAt: ceilToSecond(markedAt) },
          });
        }
      }
      return { id: user.id, status: user.status };
    });
  }

  // ── a sign-in during the 30 days ──────────────────────────────────────────

  /**
   * Called when the right password (or a good phone code) was given for an
   * account that is `pending_deletion`. Returns the account to open the session
   * for, or refuses:
   *  - 403 `ACCOUNT_DELETION_PERIOD_ENDED`: the 30 days are over; nothing is
   *    cancelled and the Hub is not asked;
   *  - 403 `ACCOUNT_DELETION_IN_PROGRESS`: the Hub's purge has started; the
   *    Hub's own message is the answer;
   *  - 503 `DELETION_CANCEL_UNAVAILABLE`: the Hub did not settle it; nothing
   *    changed, here or there, and the same sign-in can be made again;
   *  - 503 `DELETION_CANCEL_BUSY`: another sign-in is cancelling right now and
   *    did not finish within the wait.
   *
   * Two sign-ins together: one takes the claim and tells the Hub; the other
   * waits for it and then signs in as an ordinary account. The Hub is told once.
   */
  async cancelOnSignIn(userId: string): Promise<SignInOutcome> {
    const giveUpAt = Date.now() + CANCEL_WAIT_MS;
    let claim: Claim;
    for (;;) {
      claim = await this.claim(userId);
      if (claim.kind !== 'busy') break;
      if (Date.now() >= giveUpAt) {
        throw deletionRefusal(503, 'DELETION_CANCEL_BUSY', BUSY_MESSAGE);
      }
      await sleep(CANCEL_POLL_MS);
    }
    if (claim.kind === 'not_pending') {
      if (!claim.user) throw new NotFoundException('User not found');
      // A sign-in that waited behind the one that cancelled gets the restored
      // account at once; its tokens must also be newer than the revocation
      // stamp, as the claimer's are (SWEEP-AUTH SETTINGS-08 L1).
      await waitForRevocationStamp(claim.user);
      return { user: claim.user, cancelled: false };
    }
    if (claim.kind === 'ended') {
      throw deletionRefusal(
        403,
        'ACCOUNT_DELETION_PERIOD_ENDED',
        PERIOD_ENDED_MESSAGE,
      );
    }

    const { claimId } = claim;
    let answer: HubCancelResult;
    try {
      // The person's own token, as the account will be once it is back; it
      // lives two minutes and is never given to the caller.
      const token = await this.tokens.signAccessToken(
        { ...claim.user, status: 'active' },
        '2m',
      );
      answer = await this.hub.cancelDeletion(token);
    } catch (err) {
      await this.release(userId, claimId);
      if (err instanceof HubUnavailableError) {
        throw deletionRefusal(
          503,
          'DELETION_CANCEL_UNAVAILABLE',
          UNAVAILABLE_MESSAGE,
        );
      }
      throw err;
    }
    if (answer.kind === 'in_progress') {
      await this.release(userId, claimId);
      throw deletionRefusal(
        403,
        'ACCOUNT_DELETION_IN_PROGRESS',
        answer.message ?? IN_PROGRESS_FALLBACK_MESSAGE,
      );
    }

    const restored = await this.record(userId, claimId);
    if (!restored) {
      // The Hub has cancelled, but the Hub scheduled again (or another change
      // landed) before this could be recorded. Nothing was cleared here; the
      // next sign-in cancels again, which the Hub answers truthfully.
      throw deletionRefusal(503, 'DELETION_CANCEL_BUSY', BUSY_MESSAGE);
    }
    // Tokens issued from here on are newer than the revocation stamp.
    await waitForRevocationStamp(restored);
    return { user: restored, cancelled: true };
  }

  /** Decides under the account's lock: not pending, ended, busy, or claimed by this call. */
  private claim(userId: string): Promise<Claim> {
    return this.prisma.$transaction(async (tx) => {
      await this.tokens.lockAccount(tx, userId);
      const user = await tx.wawuUser.findUnique({ where: { id: userId } });
      if (!user || user.status !== 'pending_deletion') {
        return { kind: 'not_pending', user } as const;
      }
      const window = await tx.deletionWindow.findUnique({ where: { userId } });
      const now = new Date();
      const markedAt = window?.markedAt ?? user.deletedAt ?? now;
      const dueAt =
        window?.dueAt ?? new Date(markedAt.getTime() + DELETION_GRACE_MS);
      if (now >= dueAt) return { kind: 'ended' } as const;
      if (
        window?.cancelClaimId &&
        window.cancelClaimedAt &&
        now.getTime() - window.cancelClaimedAt.getTime() < CANCEL_CLAIM_TTL_MS
      ) {
        return { kind: 'busy' } as const;
      }
      const claimId = randomUUID();
      await tx.deletionWindow.upsert({
        where: { userId },
        create: {
          userId,
          markedAt,
          dueAt,
          cancelClaimId: claimId,
          cancelClaimedAt: now,
        },
        update: { cancelClaimId: claimId, cancelClaimedAt: now },
      });
      return { kind: 'claimed', claimId, user } as const;
    });
  }

  /** The Hub did not cancel: let go of the claim, only if it is still this call's. */
  private async release(userId: string, claimId: string): Promise<void> {
    await this.prisma.deletionWindow
      .updateMany({
        where: { userId, cancelClaimId: claimId },
        data: { cancelClaimId: null, cancelClaimedAt: null },
      })
      .catch(() => undefined);
  }

  /**
   * The Hub has cancelled: bring the account back, only if this call still holds
   * the claim. Every session the account holds is deleted first, so nothing
   * stored while it was closed comes back with it.
   */
  private record(userId: string, claimId: string): Promise<WawuUser | null> {
    return this.prisma.$transaction(async (tx) => {
      await this.tokens.lockAccount(tx, userId);
      const user = await tx.wawuUser.findUnique({ where: { id: userId } });
      if (!user || user.status !== 'pending_deletion') return null;
      const window = await tx.deletionWindow.findUnique({ where: { userId } });
      if (window?.cancelClaimId !== claimId) return null;
      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.passwordResetToken.deleteMany({ where: { userId } });
      const restored = await tx.wawuUser.update({
        where: { id: userId },
        data: { status: 'active', deletedAt: null },
      });
      await tx.deletionWindow.delete({ where: { userId } });
      return restored;
    });
  }
}
