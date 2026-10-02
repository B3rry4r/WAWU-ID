import { ConfigService } from '@nestjs/config';

/**
 * The numbers behind the sign-up phone code. Each can be set in the
 * environment (the name in the comment); the default is used when it is not.
 *
 * What the design and the docs state, and what they do not:
 *
 *  - The code is 6 digits (A4 "Enter the 6-digit code").
 *  - A wrong code answers "That code isn't right" (A15), and the fourth wrong
 *    code makes the person wait before trying again (AUTH-03).
 *  - A code lives 5 minutes: the same 300 seconds `POST /auth/otp/start`
 *    already answers with.
 *  - A4 draws a resend countdown ("Resend in 0:42") but not where it starts.
 *  - Nothing names the wait after the fourth wrong code, how long an
 *    unfinished sign-up lasts, or any limit on texts. Every figure below with
 *    a PROVISIONAL marker is a figure nobody has given; the owner confirms it.
 *
 * Worst case, at the 7 naira a text on Fintava's dashboard list
 * (docs/fintava/fees.md in the mobile repo): the daily cap on texts costs at
 * most `globalPerDay` x 7 naira a day, one client address at most
 * `ipPerHour` x 24 x 7 naira, one phone number at most `phonePerDay` x 7.
 *
 * Guessing: a 6-digit code has 1,000,000 values and every code is drawn fresh,
 * so `dailyWrongCap` wrong codes a day against one number succeed with
 * probability at most dailyWrongCap / 1,000,000 (12 gives 0.0012 percent; the
 * fixed window can let a burst of up to twice that through across its edge).
 */
export interface PhoneVerificationConfig {
  /** PHONE_CODE_TTL_SECONDS. How long a code can be used. */
  codeTtlSeconds: number;
  /** PHONE_CODE_MAX_WRONG. The wrong code that starts the wait (the fourth). */
  maxWrongCodes: number;
  /** PHONE_CODE_LOCKOUT_SECONDS. The wait after the last allowed wrong code. */
  // PROVISIONAL(AUTH03-LOCKOUT, owner=owner, why=no document names the wait after the fourth wrong code)
  lockoutSeconds: number;
  /** PHONE_CODE_RESEND_SECONDS. The gap before another code goes to one number. */
  // PROVISIONAL(AUTH03-RESEND, owner=owner, why=A4 draws a resend countdown but not its length)
  resendSeconds: number;
  /**
   * PHONE_CODE_DAILY_WRONG_CAP. Wrong codes one number can take in a day,
   * across every code and every sign-up for it. Once spent, the number
   * answers "wait" for the rest of the window, so a third party who burns the
   * cap holds a pending sign-up back for at most one window, never longer.
   */
  // PROVISIONAL(AUTH03-DAILY-WRONG, owner=owner, why=no document names a daily guess cap)
  dailyWrongCap: number;
  /** PENDING_SIGNUP_TTL_SECONDS. How long an unproven sign-up can still be confirmed. */
  // PROVISIONAL(AUTH03-PENDING-TTL, owner=owner, why=no document names how long an unfinished sign-up lasts)
  pendingSignupSeconds: number;
  /** SIGNUP_ALLOWED_PHONE_PREFIX. Only numbers starting with this are texted. */
  // PROVISIONAL(AUTH03-COUNTRY, owner=owner, why=assumes sign-up is for Nigerian numbers only; international texts are unpriced)
  allowedPhonePrefix: string;
  /** SMS_LIMIT_IP_PER_HOUR. Sign-up and resend requests from one client address. */
  // PROVISIONAL(AUTH03-LIMIT-IP, owner=owner, why=no document names a request limit per client address)
  ipPerHour: number;
  /** SMS_LIMIT_IP_PER_DAY. The same requests from one client address, per day: each address's share of the daily budget. */
  // PROVISIONAL(AUTH03-LIMIT-IP-DAY, owner=owner, why=no document names a daily share of the text budget per client address)
  ipPerDay: number;
  /** SMS_LIMIT_PHONE_PER_DAY. Texts sent to one number. */
  // PROVISIONAL(AUTH03-LIMIT-PHONE, owner=owner, why=no document names a request limit per number)
  phonePerDay: number;
  /** SMS_LIMIT_GLOBAL_PER_DAY. Texts sent for sign-up in total, all callers. */
  // PROVISIONAL(AUTH03-LIMIT-GLOBAL, owner=owner, why=no document names a daily text budget)
  globalPerDay: number;
  /** CONFIRM_LIMIT_IP_PER_HOUR. Code checks from one client address. */
  // PROVISIONAL(AUTH03-LIMIT-CONFIRM, owner=owner, why=no document names a limit on code checks per client address)
  confirmIpPerHour: number;
}

function whole(config: ConfigService, name: string, fallback: number): number {
  const raw = Number(config.get<string>(name));
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

export function phoneVerificationConfig(
  config: ConfigService,
): PhoneVerificationConfig {
  const prefix = config.get<string>('SIGNUP_ALLOWED_PHONE_PREFIX')?.trim();
  return {
    codeTtlSeconds: whole(config, 'PHONE_CODE_TTL_SECONDS', 300),
    maxWrongCodes: whole(config, 'PHONE_CODE_MAX_WRONG', 4),
    lockoutSeconds: whole(config, 'PHONE_CODE_LOCKOUT_SECONDS', 15 * 60),
    resendSeconds: whole(config, 'PHONE_CODE_RESEND_SECONDS', 60),
    dailyWrongCap: whole(config, 'PHONE_CODE_DAILY_WRONG_CAP', 12),
    pendingSignupSeconds: whole(
      config,
      'PENDING_SIGNUP_TTL_SECONDS',
      24 * 3600,
    ),
    allowedPhonePrefix: prefix?.startsWith('+') ? prefix : '+234',
    ipPerHour: whole(config, 'SMS_LIMIT_IP_PER_HOUR', 30),
    ipPerDay: whole(config, 'SMS_LIMIT_IP_PER_DAY', 100),
    phonePerDay: whole(config, 'SMS_LIMIT_PHONE_PER_DAY', 5),
    globalPerDay: whole(config, 'SMS_LIMIT_GLOBAL_PER_DAY', 2000),
    confirmIpPerHour: whole(config, 'CONFIRM_LIMIT_IP_PER_HOUR', 120),
  };
}
