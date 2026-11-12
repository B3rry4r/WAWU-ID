/**
 * Which product an account mail is for (VOICES-MAIL, V-44). A mail is a
 * VOICES mail when the request that causes it says `app: "voices"`, or, where
 * the request names no app (a reset by link on the person's own phone, a
 * notice the Hub sends), when the person signed up through VOICES. Everything
 * else is a Who Made This? mail, exactly as before.
 */
export const MAIL_APPS = ['voices'] as const;
export type MailApp = (typeof MAIL_APPS)[number];

export function isMailApp(value: unknown): value is MailApp {
  return (MAIL_APPS as readonly unknown[]).includes(value);
}

export function mailAppFor(
  requested: unknown,
  signedUpWith: string | null | undefined,
): MailApp | undefined {
  if (isMailApp(requested)) return requested;
  if (requested === undefined || requested === null || requested === '') {
    return isMailApp(signedUpWith) ? signedUpWith : undefined;
  }
  return undefined;
}
