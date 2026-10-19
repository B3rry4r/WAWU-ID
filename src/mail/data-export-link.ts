import { BadRequestException } from '@nestjs/common';

/**
 * The data-export email, as the Hub hands it to WAWU ID (task FIX-53, the
 * Hub's SETTINGS-04, BACKEND_GAPS G-131): the link a person opens to download
 * a copy of their data, and when it stops working. WAWU ID owns the address,
 * the subject and the wording; the Hub names the person and the link.
 *
 * Not a mail relay. A leaked service key must not be able to put its own link
 * or text into a WAWUAfrica email, so `parseDataExportLink` refuses a body
 * that:
 * - has a key other than `downloadUrl` and `expiresAt`;
 * - has a link that is not the Hub's export download link exactly: https (or
 *   http to this machine, outside production), the path
 *   `/api/hub/settings/privacy/export/download`, one `token` and nothing else
 *   (no other query value, no sign-in name, no fragment);
 * - has a token with a character a signed link does not use;
 * - expires in the past, or more than a week from now.
 *
 * The link in the mail is rebuilt from the checked parts, never echoed.
 */

export const DATA_EXPORT_PATH = '/api/hub/settings/privacy/export/download';

/** The Hub's links live 72 hours; a week leaves room and still catches a mistake. */
export const DATA_EXPORT_MAX_LINK_HOURS = 168;

const TOKEN = /^[A-Za-z0-9._-]{16,1500}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface DataExportLink {
  downloadUrl: string;
  expiresAt: Date;
}

export function parseDataExportLink(
  body: unknown,
  now: Date = new Date(),
  production: boolean = process.env.NODE_ENV === 'production',
): DataExportLink {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Send downloadUrl and expiresAt.');
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'downloadUrl' && key !== 'expiresAt') {
      throw new BadRequestException(`${key} is not a field of this request.`);
    }
  }

  const raw = record.downloadUrl;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
    throw new BadRequestException('downloadUrl must be the export link.');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException('downloadUrl must be the export link.');
  }
  const secure = url.protocol === 'https:';
  const local =
    !production && url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
  if (
    (!secure && !local) ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.pathname !== DATA_EXPORT_PATH
  ) {
    throw new BadRequestException('downloadUrl must be the export link.');
  }
  const keys = [...url.searchParams.keys()];
  const token = url.searchParams.get('token');
  if (keys.length !== 1 || keys[0] !== 'token' || token === null) {
    throw new BadRequestException('downloadUrl must be the export link.');
  }
  if (!TOKEN.test(token)) {
    throw new BadRequestException('downloadUrl must be the export link.');
  }

  const stamp = record.expiresAt;
  const expiresAt =
    typeof stamp === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(stamp)
      ? new Date(stamp)
      : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
    throw new BadRequestException('expiresAt must be an ISO date and time.');
  }
  const hoursLeft = (expiresAt.getTime() - now.getTime()) / 3_600_000;
  if (hoursLeft <= 0 || hoursLeft > DATA_EXPORT_MAX_LINK_HOURS) {
    throw new BadRequestException('expiresAt must be within the next 7 days.');
  }

  return {
    downloadUrl: `${url.origin}${DATA_EXPORT_PATH}?token=${encodeURIComponent(token)}`,
    expiresAt,
  };
}

/** "Mon 19 Oct 2026 at 14:05" in Lagos time, which is what the person's clock says. */
export function exportDeadlineText(expiresAt: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(expiresAt);
  const at = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${at('weekday')} ${at('day')} ${at('month')} ${at('year')} at ${at('hour')}:${at('minute')}`;
}
