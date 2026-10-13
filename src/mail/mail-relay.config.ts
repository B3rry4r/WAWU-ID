import { ConfigService } from '@nestjs/config';

/**
 * The only headers a caller of POST /internal/mail/send may set, in the form
 * they are sent with. Anything else is refused: a header can change who a mail
 * appears to be from, where replies go, or how a client treats it.
 */
export const RELAY_HEADER_ALLOWLIST: Record<string, string> = {
  'list-unsubscribe': 'List-Unsubscribe',
  'list-unsubscribe-post': 'List-Unsubscribe-Post',
};

/** The longest value of an allowed header. */
export const RELAY_HEADER_MAX_LENGTH = 2000;

/**
 * MAIL_RELAY_DAILY_CAP. The most mails the relay sends in one UTC day, for
 * everyone who calls it. It is a guard against a runaway caller and against
 * burning the provider's quota, not a promise about volume. The count is held
 * in this server's memory, so a restart starts the day again from zero.
 */
// PROVISIONAL(EMAIL02-DAILY-CAP, owner=owner, why=no document names a daily limit for mail sent through WAWU ID; 5000 a day is a guess to be set against the Resend plan)
export const DEFAULT_MAIL_RELAY_DAILY_CAP = 5000;

export function mailRelayDailyCap(config: ConfigService): number {
  const raw = Number(config.get<string>('MAIL_RELAY_DAILY_CAP'));
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAIL_RELAY_DAILY_CAP;
}
