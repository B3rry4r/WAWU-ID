import { HttpException } from '@nestjs/common';
import { resolveCountryCode } from '../common/phone.util';

/**
 * The country of residence a new account is made with (GEO-01, R-85): the code
 * the client sent, else the phone's own country, else NG. A code that is not a
 * country answers 400 COUNTRY_INVALID, before anything is written or sent.
 */
export function countryForSignup(
  sent: string | null | undefined,
  phone: string,
): string {
  const code = resolveCountryCode(sent, phone);
  if (!code) {
    throw new HttpException(
      {
        statusCode: 400,
        code: 'COUNTRY_INVALID',
        message: 'Choose a country from the list.',
      },
      400,
    );
  }
  return code;
}
