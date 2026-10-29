import { isDeletedOrDeleting } from '../auth/deletion-window';

/**
 * Which address mail may go to. One rule for the whole service (it was two
 * private methods of AuthService): a mobile sign-up never proves its email, so
 * mail is held back from it until it is proven; every other account (web,
 * legacy, phone-only) is exactly as before.
 */
interface Addressable {
  email: string | null;
  emailVerified: boolean;
  phoneVerifiedAt: Date | null;
}

/** The same rule without the deletion check: the one mail a person asks for themselves, or the mails about the deletion. */
export function ownProvenEmail(user: Addressable): string | null {
  if (!user.email) return null;
  return user.emailVerified || !user.phoneVerifiedAt ? user.email : null;
}

/**
 * Nothing a service sends on its own goes to an account in its 30 days of
 * deletion or already deleted (SETTINGS-08). The type asks for both fields on
 * purpose: a caller that does not select them does not compile.
 */
export function provenEmail(
  user: Addressable & { status: string; deletedAt: Date | null },
): string | null {
  if (isDeletedOrDeleting(user)) return null;
  return ownProvenEmail(user);
}
