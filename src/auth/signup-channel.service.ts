import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { UserResponse } from './auth.service';
import {
  EmailSignupService,
  type EmailSignupCodeSent,
  type EmailSignupStarted,
} from './email-signup.service';
import {
  problem,
  PhoneSignupService,
  type PhoneCodeSent,
  type SignupResume,
  type SignupStarted,
} from './phone-signup.service';
import {
  signupVerifyChannel,
  signupVerifyChannelIsUnrecognised,
  type SignupVerifyChannel,
} from './signup-channel.config';
import type { TokenPair } from './tokens.service';

/** 409 SIGNUP_CHANNEL_DISABLED: this route is for the channel that is not active. */
const DISABLED = (active: SignupVerifyChannel) =>
  problem(
    409,
    'SIGNUP_CHANNEL_DISABLED',
    active === 'email'
      ? 'Sign-up codes are sent by email now. Start again to get one.'
      : 'Sign-up codes are sent by text message right now. Start again to get one.',
  );

/**
 * The one place that knows which way a mobile sign-up proves itself
 * (SIGNUP_VERIFY_CHANNEL, AUTH-07, DECISIONS R-39). The routes call this and
 * nothing else; it hands each call to the service for the active channel:
 *
 *   phone (default)  PhoneSignupService, exactly as AUTH-03 built it: the code
 *                    is texted; the email-code routes answer 409
 *                    SIGNUP_CHANNEL_DISABLED. Its answers carry no new field.
 *                    Deploying this service changes nothing by itself.
 *   email            EmailSignupService: the code is mailed; the phone-code
 *                    routes answer 409 SIGNUP_CHANNEL_DISABLED. Switched on
 *                    after the app build with email codes is out and Resend is
 *                    confirmed in production (see signup-channel.config.ts).
 *
 * Neither service is removed or changed in behaviour, so setting the variable
 * back restores the other channel. A sign-up started under one channel is
 * answered `details` by `resume` once the other is active (its code went the
 * other way), and the person starts again at A3.
 */
@Injectable()
export class SignupChannelService {
  private readonly logger = new Logger(SignupChannelService.name);
  readonly channel: SignupVerifyChannel;

  constructor(
    config: ConfigService,
    private readonly phone: PhoneSignupService,
    private readonly email: EmailSignupService,
  ) {
    this.channel = signupVerifyChannel(config);
    if (signupVerifyChannelIsUnrecognised(config)) {
      this.logger.warn(
        'SIGNUP_VERIFY_CHANNEL is not "email" or "phone": using "phone".',
      );
    }
    this.logger.log(`Sign-up codes go by ${this.channel}.`);
  }

  // ── A3 ─────────────────────────────────────────────────────────────────────

  async signup(
    dto: Parameters<PhoneSignupService['signup']>[0],
    address: string,
  ): Promise<SignupStarted | EmailSignupStarted> {
    return this.channel === 'email'
      ? this.email.signup(dto, address)
      : this.phone.signup(dto, address);
  }

  // ── A4, texted (POST /auth/phone/verify/*) ─────────────────────────────────

  async phoneStart(
    phone: string,
    attempt: string,
    address: string,
  ): Promise<PhoneCodeSent> {
    if (this.channel !== 'phone') throw DISABLED(this.channel);
    return this.phone.start(phone, attempt, address);
  }

  async phoneConfirm(
    phone: string,
    attempt: string,
    code: string,
    emailCode: string | undefined,
    address: string,
  ): Promise<TokenPair & { user: UserResponse }> {
    if (this.channel !== 'phone') throw DISABLED(this.channel);
    return this.phone.confirm(phone, attempt, code, emailCode, address);
  }

  // ── A4, mailed (POST /auth/signup/email-code/*) ────────────────────────────

  async emailCodeStart(
    phone: string,
    attempt: string,
    address: string,
  ): Promise<EmailSignupCodeSent> {
    if (this.channel !== 'email') throw DISABLED(this.channel);
    return this.email.start(phone, attempt, address);
  }

  async emailCodeConfirm(
    phone: string,
    attempt: string,
    code: string,
    address: string,
  ): Promise<TokenPair & { user: UserResponse }> {
    if (this.channel !== 'email') throw DISABLED(this.channel);
    return this.email.confirm(phone, attempt, code, address);
  }

  // ── resume ─────────────────────────────────────────────────────────────────

  async resume(
    phone: string,
    attempt: string,
    address: string,
  ): Promise<SignupResume> {
    return this.channel === 'email'
      ? this.email.resume(phone, attempt, address)
      : this.phone.resume(phone, attempt, address);
  }
}
