import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HUB_CANCEL_TIMEOUT_MS } from './deletion-window';

/** What the Hub said to a cancel. */
export type HubCancelResult =
  /** The Hub cancelled a deletion that was waiting: wallet unfrozen, content back. */
  | { kind: 'cancelled' }
  /** The Hub had no deletion waiting (already cancelled, or never recorded). Nothing to undo there. */
  | { kind: 'nothing_scheduled' }
  /** The Hub's purge has started: data may be gone, the account cannot come back. */
  | { kind: 'in_progress'; message: string | null };

/** The Hub did not give an answer that settles the matter: nothing may be assumed. */
export class HubUnavailableError extends Error {}

/**
 * WAWU ID's one call to the Hub (SETTINGS-08): cancel the deletion of the
 * person who has just signed in. The call carries a short-lived token of that
 * person, so the Hub cancels the deletion of whoever the token names and of
 * nobody else; WAWU ID never sends an id.
 *
 * The Hub is `WAWUAFRICA_API_URL` (the Hub API over loopback, deploy/ENV.md).
 * There is no default: a sign-in must never reach a host nobody configured.
 */
@Injectable()
export class HubAccountClient {
  private readonly logger = new Logger(HubAccountClient.name);

  constructor(private readonly config: ConfigService) {}

  async cancelDeletion(accessToken: string): Promise<HubCancelResult> {
    const base = (this.config.get<string>('WAWUAFRICA_API_URL') ?? '')
      .trim()
      .replace(/\/+$/, '');
    if (!base) {
      this.logger.error(
        'WAWUAFRICA_API_URL is not set, so a sign-in cannot cancel a deletion',
      );
      throw new HubUnavailableError('The Hub address is not configured.');
    }

    let res: Response;
    try {
      res = await fetch(`${base}/api/hub/account/cancel-deletion`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(HUB_CANCEL_TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.warn(`The Hub did not answer a cancel: ${String(err)}`);
      throw new HubUnavailableError('The Hub did not answer.');
    }

    if (res.status !== 200) {
      // 503 (its wallet provider did not answer, nothing changed), 401 (our
      // token was refused), anything else: the cancel is not settled.
      this.logger.warn(`The Hub answered a cancel with ${res.status}`);
      throw new HubUnavailableError(`The Hub answered ${res.status}.`);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new HubUnavailableError('The Hub answered with no readable body.');
    }
    const answer = pick(body);
    if (answer.deletionInProgress === true) {
      return {
        kind: 'in_progress',
        message:
          typeof answer.message === 'string' && answer.message.length > 0
            ? answer.message
            : null,
      };
    }
    if (answer.cancelled === true) return { kind: 'cancelled' };
    if (answer.cancelled === false) return { kind: 'nothing_scheduled' };
    throw new HubUnavailableError('The Hub answered with an unknown shape.');
  }
}

/** The Hub answers the object itself; a wrapper `{ data }` is read the same way. */
function pick(body: unknown): {
  cancelled?: unknown;
  deletionInProgress?: unknown;
  message?: unknown;
} {
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    if ('cancelled' in o) return o;
    if (o.data && typeof o.data === 'object') return o.data;
  }
  return {};
}
