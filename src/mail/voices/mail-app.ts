/**
 * Which product an account mail is for (VOICES-MAIL, V-44). A mail is a
 * VOICES mail only when the request or notice that causes it says
 * `app: "voices"` (lead ruling, 12 Nov 2026). The stored `signup_app` is a
 * record and never chooses a mail's look or links. Everything else is a Who
 * Made This? mail, exactly as before.
 */
export const MAIL_APPS = ['voices'] as const;
export type MailApp = (typeof MAIL_APPS)[number];

export function isMailApp(value: unknown): value is MailApp {
  return (MAIL_APPS as readonly unknown[]).includes(value);
}

export function mailAppFor(requested: unknown): MailApp | undefined {
  return isMailApp(requested) ? requested : undefined;
}
