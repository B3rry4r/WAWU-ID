import { ConfigService } from '@nestjs/config';

/**
 * How a mobile sign-up proves itself (AUTH-07, DECISIONS R-39).
 *
 *  - `email` (the default): a 6-digit code is mailed to the email typed at
 *    sign-up, through the same mailer as every other WAWU ID mail. Nothing is
 *    texted. Confirming the code proves the email; the phone is stored but not
 *    proven.
 *  - `sms`: the sign-up exactly as AUTH-03 built it. A 6-digit code is texted
 *    to the phone through the SmsProvider (Fintava), and proves the phone.
 *
 * Set `SIGNUP_VERIFY_CHANNEL` and restart to switch. It is the owner's
 * rollback: nothing is removed, so changing the value back restores the old
 * behaviour. Anything that is not exactly `sms` (after trimming and lower
 * casing) is `email`: a typo must never start spending on texts.
 */
export type SignupVerifyChannel = 'email' | 'sms';

export function signupVerifyChannel(
  config: ConfigService,
): SignupVerifyChannel {
  const raw = config.get<string>('SIGNUP_VERIFY_CHANNEL');
  return raw?.trim().toLowerCase() === 'sms' ? 'sms' : 'email';
}

/** True when the variable holds something other than `email`, `sms` or nothing, so the service can say so once at start. */
export function signupVerifyChannelIsUnrecognised(
  config: ConfigService,
): boolean {
  const raw = config.get<string>('SIGNUP_VERIFY_CHANNEL')?.trim().toLowerCase();
  return !!raw && raw !== 'email' && raw !== 'sms';
}
