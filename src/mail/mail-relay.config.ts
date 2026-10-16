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

/**
 * The files a relayed mail may carry (WALLET-35: the Hub mails a wallet
 * statement as a CSV). At most this many, with these names of type, and no
 * more than RELAY_ATTACHMENT_MAX_BYTES between them once decoded.
 */
export const RELAY_ATTACHMENT_MAX_COUNT = 2;
export const RELAY_ATTACHMENT_TYPES = [
  'text/csv; charset=utf-8',
  'text/csv',
  'application/pdf',
] as const;

/**
 * The most bytes of attachments in one mail, decoded. The Hub's largest
 * statement (50,000 movements) is about 9 MB; Resend takes 40 MB a message.
 * Held below both so one request cannot fill this server's memory.
 */
// PROVISIONAL(MAIL-RELAY-ATTACHMENT-MAX, owner=owner, why=no document names a size for a mailed file; 12 MiB covers the Hub's largest statement with room and sits well under Resend's 40 MB message limit)
export const RELAY_ATTACHMENT_MAX_BYTES = 12 * 1024 * 1024;

/**
 * The JSON body limit of POST /internal/mail/send only: the attachments in
 * base64 (4 bytes for every 3) plus the mail's own text. Every other route
 * keeps Express's 100 kb.
 */
export const MAIL_RELAY_BODY_LIMIT = '17mb';
