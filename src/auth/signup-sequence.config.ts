import { ConfigService } from '@nestjs/config';

/**
 * The numbers behind the sign-up sequence's own routes (AUTH-05). Each can be
 * set in the environment (the name in the comment); the default is used when
 * it is not. Wrong email codes share the phone code's rules (four in a row
 * start the wait, a daily cap), from phone-verification.config.ts, so there is
 * one set of guess figures for the owner to confirm.
 */
export interface SignupSequenceConfig {
  /**
   * SIGNUP_EMAIL_CODE_TTL_SECONDS. How long a mailed email code works. 600 s
   * because the mail that carries it says "This code expires in 10 minutes"
   * (MailService.sendOtpCode); the figure follows the mail, not the reverse.
   */
  emailCodeTtlSeconds: number;
  /** SIGNUP_EMAIL_RESEND_SECONDS. The gap before another email code goes to one account. */
  // PROVISIONAL(AUTH05-EMAIL-RESEND, owner=owner, why=no document names a resend gap for the email code; the phone code's 60 s is reused)
  emailResendSeconds: number;
  /** SIGNUP_EMAIL_PER_DAY. Email codes mailed to one account in a day. */
  // PROVISIONAL(AUTH05-EMAIL-PER-DAY, owner=owner, why=no document names how many email codes one account may be sent a day; the phone's 5 a day is reused)
  emailPerDay: number;
  /** SIGNUP_RESUME_LIMIT_IP_PER_HOUR. Resume checks from one client address. */
  // PROVISIONAL(AUTH05-RESUME-IP, owner=owner, why=no document names a limit on resume checks; the code-check limit of 120 an hour is reused)
  resumeIpPerHour: number;
}

function whole(config: ConfigService, name: string, fallback: number): number {
  const raw = Number(config.get<string>(name));
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

export function signupSequenceConfig(
  config: ConfigService,
): SignupSequenceConfig {
  return {
    emailCodeTtlSeconds: whole(config, 'SIGNUP_EMAIL_CODE_TTL_SECONDS', 600),
    emailResendSeconds: whole(config, 'SIGNUP_EMAIL_RESEND_SECONDS', 60),
    emailPerDay: whole(config, 'SIGNUP_EMAIL_PER_DAY', 5),
    resumeIpPerHour: whole(config, 'SIGNUP_RESUME_LIMIT_IP_PER_HOUR', 120),
  };
}
