import { ConfigService } from '@nestjs/config';

/**
 * How a mobile sign-up proves itself (AUTH-07, DECISIONS R-39).
 *
 *  - `phone` (the default): the sign-up exactly as AUTH-03 built it. A 6-digit
 *    code is texted to the phone through the SmsProvider (Fintava), and proves
 *    the phone. Deploying this service changes nothing by itself: this is what
 *    runs today, and what an app build from before AUTH-07 expects.
 *  - `email`: a 6-digit code is mailed to the email typed at sign-up, through
 *    the same mailer as every other WAWU ID mail. Nothing is texted. Confirming
 *    the code proves the email; the phone is stored but not proven.
 *
 * Set `SIGNUP_VERIFY_CHANNEL` and restart to switch. Switch to `email` only
 * after the app build with email codes is in testers' hands, Resend (the key
 * and a verified sending domain) is confirmed in production, and a way to add
 * and prove a phone later exists (BACKEND_GAPS G-222: a mailed sign-up for a
 * number another account has typed is made without a number), because an older
 * app build and a sign-up already waiting on a text are refused (409
 * SIGNUP_CHANNEL_DISABLED) the moment the value is `email`. Changing it back to
 * `phone` restores the old behaviour: nothing is removed.
 *
 * Only a value that is exactly `email` (after trimming and lower casing)
 * selects email. Anything else, including nothing, a typo, and `sms` (the
 * name this value had in an earlier build, still read as `phone`), is `phone`:
 * a typo must never switch off the sign-up that is live.
 */
export type SignupVerifyChannel = 'email' | 'phone';

export function signupVerifyChannel(
  config: ConfigService,
): SignupVerifyChannel {
  const raw = config.get<string>('SIGNUP_VERIFY_CHANNEL');
  return raw?.trim().toLowerCase() === 'email' ? 'email' : 'phone';
}

/** True when the variable holds something other than `email`, `phone`, `sms` or nothing, so the service can say so once at start. */
export function signupVerifyChannelIsUnrecognised(
  config: ConfigService,
): boolean {
  const raw = config.get<string>('SIGNUP_VERIFY_CHANNEL')?.trim().toLowerCase();
  return !!raw && raw !== 'email' && raw !== 'phone' && raw !== 'sms';
}
