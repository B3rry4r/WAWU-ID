import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AFTER_PHONE_STEPS } from '../auth/signup-sequence';

/**
 * The answer bodies of the routes the mobile app calls, for the published
 * contract (contract/openapi.json, AUTH-05, BACKEND_GAPS G-5). Each class
 * describes exactly what the route's code returns; src/contract/contract.spec.ts
 * holds every one of them against the real answers.
 *
 * Every success body is `{ data: ... }`: wawu-id has no response interceptor,
 * the controllers wrap the result themselves.
 */

export class TickStateSchema {
  @ApiProperty()
  verified!: boolean;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  expiresAt!: string | null;
}

export class VerificationStateSchema {
  @ApiProperty({ type: TickStateSchema })
  creator!: TickStateSchema;

  @ApiProperty({ type: TickStateSchema })
  professional!: TickStateSchema;
}

export class SessionUser {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty({ type: String, nullable: true })
  email!: string | null;

  @ApiProperty()
  phone!: string;

  @ApiProperty({ type: String, nullable: true })
  country!: string | null;

  @ApiProperty({ type: String, nullable: true })
  state!: string | null;

  @ApiProperty({ type: String, nullable: true })
  gender!: string | null;

  @ApiProperty({ type: String, nullable: true })
  occupation!: string | null;

  @ApiPropertyOptional({
    enum: ['user', 'creator'],
    description:
      'Present only when the account has one (chosen at mobile sign-up, A2). Absent for every account that never said.',
  })
  accountType?: 'user' | 'creator';

  @ApiProperty({ description: 'LEGACY. Read `verification`.' })
  verificationTier!: string;

  @ApiProperty({ description: 'LEGACY.' })
  trustScore!: number;

  @ApiProperty({ type: VerificationStateSchema })
  verification!: VerificationStateSchema;

  @ApiProperty()
  status!: string;
}

export class Session {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  refreshToken!: string;

  @ApiProperty({ type: SessionUser })
  user!: SessionUser;
}

export class SessionAnswer {
  @ApiProperty({ type: Session })
  data!: Session;
}

export class TokenPairSchema {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  refreshToken!: string;
}

export class TokenPairAnswer {
  @ApiProperty({ type: TokenPairSchema })
  data!: TokenPairSchema;
}

export class ResetRequested {
  @ApiProperty({ example: 'If an account exists, a reset code has been sent.' })
  message!: string;

  @ApiPropertyOptional({
    description:
      "The emailed link's lifetime in seconds. Sent only when `method` is `email`, the same figure whether or not an account exists.",
  })
  expiresInSeconds?: number;
}

export class ResetRequestedAnswer {
  @ApiProperty({ type: ResetRequested })
  data!: ResetRequested;
}

export class SignedOutSchema {
  @ApiProperty({ example: true })
  signedOut!: boolean;
}

export class SignedOutAnswer {
  @ApiProperty({ type: SignedOutSchema })
  data!: SignedOutSchema;
}

export class PhoneCodeSentSchema {
  @ApiProperty({ description: 'The number as stored (+234...).' })
  phone!: string;

  @ApiProperty({ description: 'Seconds the code can be used for.' })
  expiresIn!: number;

  @ApiProperty({ description: 'Seconds until another code can be asked for.' })
  resendIn!: number;
}

export class PhoneCodeSentAnswer {
  @ApiProperty({ type: PhoneCodeSentSchema })
  data!: PhoneCodeSentSchema;
}

export class EmailSignupCodeSentSchema extends PhoneCodeSentSchema {
  @ApiProperty({ enum: ['email'] })
  channel!: 'email';
}

export class EmailSignupCodeSentAnswer {
  @ApiProperty({ type: EmailSignupCodeSentSchema })
  data!: EmailSignupCodeSentSchema;
}

export class SignupStartedSchema extends PhoneCodeSentSchema {
  @ApiProperty({
    description:
      'Shown once. Keep it with the sign-up (it survives the app closing) and send it on every code and resume call.',
  })
  attempt!: string;

  @ApiProperty({
    description:
      'Texted sign-up only: the confirm call must also carry `emailCode`, the code mailed to the email. Always false when the code was mailed.',
  })
  emailCodeRequired!: boolean;

  @ApiPropertyOptional({
    enum: ['email'],
    description:
      '`email`: the code was mailed (`SIGNUP_VERIFY_CHANNEL=email`, DECISIONS R-39): send it to `signup/email-code/*`. Absent: the code was texted (the default): `phone/verify/*`.',
  })
  channel?: 'email';

  @ApiPropertyOptional({
    description:
      'With `channel: email`: where the code went, written a•••@example.com. Show it on A4.',
  })
  maskedEmail?: string;

  @ApiPropertyOptional({
    enum: [true],
    description:
      'With `channel: email`, present (true) only when the phone number typed was NOT saved to the account because another account holds it. The account is made without a phone; say so on A4 in plain words. The person adds and proves a phone later (BACKEND_GAPS G-222).',
  })
  phoneNotSaved?: true;
}

export class SignupStartedAnswer {
  @ApiProperty({ type: SignupStartedSchema })
  data!: SignupStartedSchema;
}

export class SignupChannelSchema {
  @ApiProperty({
    enum: ['phone', 'email'],
    description:
      'Where the sign-up code will go: `phone` (texted, the default) or `email` (mailed). It is the SIGNUP_VERIFY_CHANNEL setting as WAWU ID reads it. A3 words its line by it; A4 then names the channel the sign-up answer carries.',
  })
  channel!: 'phone' | 'email';
}

export class SignupChannelAnswer {
  @ApiProperty({ type: SignupChannelSchema })
  data!: SignupChannelSchema;
}

export class SignupResumeSchema {
  @ApiProperty({
    enum: ['phone', 'details'],
    description:
      '`phone`: the sign-up waits for its texted code (A4). `details`: there is no sign-up to resume (never made, replaced, expired or already confirmed): start again at A3, or sign in.',
  })
  step!: 'phone' | 'details';

  @ApiPropertyOptional({ description: 'With `phone`: the number as stored.' })
  phone?: string;

  @ApiPropertyOptional({
    description:
      'With `phone`: seconds the last code can still be used for (0: ask for a new one).',
  })
  expiresIn?: number;

  @ApiPropertyOptional({
    description: 'With `phone`: seconds until another code can be asked for.',
  })
  resendIn?: number;

  @ApiPropertyOptional({
    description: 'With `phone`: the confirm call must also carry `emailCode`.',
  })
  emailCodeRequired?: boolean;

  @ApiPropertyOptional({
    enum: ['user', 'creator'],
    nullable: true,
    description: 'With `phone`: the account type sent with the sign-up.',
  })
  accountType?: 'user' | 'creator' | null;

  @ApiPropertyOptional({
    enum: ['email'],
    description:
      'With `phone`: `email` when the code was mailed (use `signup/email-code/*`); absent when it was texted. The step is named `phone` whichever way the code travels.',
  })
  channel?: 'email';

  @ApiPropertyOptional({
    description:
      'With `channel: email`: where the code went, written a•••@example.com.',
  })
  maskedEmail?: string;

  @ApiPropertyOptional({
    enum: [true],
    description:
      'With `channel: email`, present (true) only when the account was made without the phone number typed, because another account holds it. Say so on A4, as the sign-up answer did.',
  })
  phoneNotSaved?: true;
}

export class SignupResumeAnswer {
  @ApiProperty({ type: SignupResumeSchema })
  data!: SignupResumeSchema;
}

export class SignupProgressSchema {
  @ApiProperty({
    enum: [...AFTER_PHONE_STEPS, 'done'],
    description:
      'The next step: `email` (prove the email, or put it off), `creator_setup` (A11), `interests` (A12), `follows` (A13), or `done`.',
  })
  step!: (typeof AFTER_PHONE_STEPS)[number] | 'done';

  @ApiProperty({
    description:
      'False for an account that did not come through the mobile sign-up: there is nothing to finish.',
  })
  inSequence!: boolean;

  @ApiProperty({ enum: ['user', 'creator'], nullable: true })
  accountType!: 'user' | 'creator' | null;

  @ApiProperty({
    enum: AFTER_PHONE_STEPS,
    isArray: true,
    description: "This account's steps after the phone code, in order.",
  })
  steps!: Array<(typeof AFTER_PHONE_STEPS)[number]>;

  @ApiProperty({ description: 'The email has been proven by a mailed code.' })
  emailProven!: boolean;
}

export class SignupProgressAnswer {
  @ApiProperty({ type: SignupProgressSchema })
  data!: SignupProgressSchema;
}

export class EmailCodeSentSchema {
  @ApiProperty({ description: "The account's own email, where the code went." })
  email!: string;

  @ApiProperty({ description: 'Seconds the code can be used for.' })
  expiresIn!: number;

  @ApiProperty({ description: 'Seconds until another code can be asked for.' })
  resendIn!: number;
}

export class EmailCodeSentAnswer {
  @ApiProperty({ type: EmailCodeSentSchema })
  data!: EmailCodeSentSchema;
}

/** Every `code` the app's routes can answer with. */
export const ERROR_CODES = [
  'USER_NOT_IN_WAWUID',
  'EMAIL_NOT_VERIFIED',
  'PHONE_NOT_CONFIRMED',
  'PHONE_INVALID',
  'PHONE_NOT_SUPPORTED',
  'PHONE_CODE_INVALID',
  'PHONE_CODE_LOCKED',
  'PHONE_CODE_RESEND_TOO_SOON',
  'PHONE_ALREADY_CONFIRMED',
  'RATE_LIMITED',
  'SMS_NOT_CONFIGURED',
  'SMS_SEND_FAILED',
  'SESSION_INVALID',
  'SIGNUP_STEP_OUT_OF_ORDER',
  'SIGNUP_ALREADY_FINISHED',
  'EMAIL_NOT_SET',
  'EMAIL_ALREADY_PROVEN',
  'EMAIL_CODE_INVALID',
  'EMAIL_CODE_LOCKED',
  'EMAIL_CODE_RESEND_TOO_SOON',
  'EMAIL_ALREADY_CONFIRMED',
  'EMAIL_NOT_CONFIGURED',
  'EMAIL_SEND_FAILED',
  'SIGNUP_CHANNEL_DISABLED',
  'CURRENT_PASSWORD_WRONG',
  'PASSWORD_UNCHANGED',
  'PASSWORD_NOT_SET',
] as const;

export class ErrorBody {
  @ApiProperty()
  statusCode!: number;

  @ApiPropertyOptional({
    enum: ERROR_CODES,
    description:
      'Machine-readable cause, when there is one. A body without it is a plain refusal (a 400 from validation, a 401 wrong password, a 409 taken email or phone).',
  })
  code?: (typeof ERROR_CODES)[number];

  @ApiProperty({
    description:
      'A sentence for people. Validation errors join theirs with ", ".',
  })
  message!: string;

  @ApiPropertyOptional({
    description:
      'Seconds to wait, with every 429 (also sent as a Retry-After header).',
  })
  retryAfterSeconds?: number;
}
