import { DELETED_PHONE_PREFIX } from './released-phone';

/**
 * An account the Hub has closed: banned, or on its way out or gone
 * (`pending_deletion`, or anonymised by `DELETE /internal/users/:id?mode=anonymize`,
 * which sets `banned`, stamps `deletedAt` and writes the `deleted:<id>` marker).
 *
 * Nothing a sign-up route does may bring such an account back to life (JOIN-03
 * round 4, D7): a code texted or mailed to it proves nothing, gives it no
 * session and writes nothing to its row. The four tests are independent on
 * purpose, so a row that carries only one of the marks (an operator's own
 * `UPDATE`, a deletion started and not finished) is still closed.
 */
export function isClosedAccount(user: {
  status: string;
  deletedAt: Date | null;
  phone: string;
}): boolean {
  return (
    user.status === 'banned' ||
    user.status === 'pending_deletion' ||
    user.deletedAt != null ||
    (typeof user.phone === 'string' &&
      user.phone.startsWith(DELETED_PHONE_PREFIX))
  );
}
