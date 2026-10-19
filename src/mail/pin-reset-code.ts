import { BadRequestException } from '@nestjs/common';

/**
 * The wallet PIN reset code, as the Hub hands it to WAWU ID (task AUTH-09,
 * the Hub's BACKEND_GAPS G-400, ruling R-72: the PIN reset code goes by email
 * at launch). The Hub makes the code and names the person; WAWU ID owns the
 * address, the subject and the wording.
 *
 * Not a mail relay: the body is exactly a 6-digit code and how many minutes it
 * lives. Nothing else from the body ever reaches the mail. The Hub's code
 * lives at most 60 minutes (its PIN_RESET_CODE_SECONDS range is 60 to 3600),
 * so a longer claim is a mistake or a leaked key and is refused.
 */

export const PIN_RESET_CODE_MAX_MINUTES = 60;

export interface PinResetCode {
  code: string;
  expiresInMinutes: number;
}

export function parsePinResetCode(body: unknown): PinResetCode {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Send code and expiresInMinutes.');
  }
  const { code, expiresInMinutes } = body as Record<string, unknown>;
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    throw new BadRequestException('code must be 6 digits.');
  }
  if (
    typeof expiresInMinutes !== 'number' ||
    !Number.isInteger(expiresInMinutes) ||
    expiresInMinutes < 1 ||
    expiresInMinutes > PIN_RESET_CODE_MAX_MINUTES
  ) {
    throw new BadRequestException(
      `expiresInMinutes must be a whole number from 1 to ${PIN_RESET_CODE_MAX_MINUTES}.`,
    );
  }
  return { code, expiresInMinutes };
}
