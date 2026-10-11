import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ErrorBody,
  PhoneCodeSentAnswer,
  SignedOutAnswer,
  ResetRequestedAnswer,
  SessionAnswer,
  SignupStartedAnswer,
  TokenPairAnswer,
} from '../contract/identity-schemas';
import { AuthService } from './auth.service';
import { clientAddress } from './client-address';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ActivateDto } from './dto/activate.dto';
import { EmailVerifyConfirmDto } from './dto/email-verify-confirm.dto';
import { EmailVerifyStartDto } from './dto/email-verify-start.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { LogoutDto } from './dto/logout.dto';
import { OtpStartDto } from './dto/otp-start.dto';
import { OtpVerifyDto } from './dto/otp-verify.dto';
import { PhoneVerifyConfirmDto } from './dto/phone-verify-confirm.dto';
import { PhoneVerifyStartDto } from './dto/phone-verify-start.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SignupDto } from './dto/signup.dto';
import { SignupChannelService } from './signup-channel.service';
import { SessionReader } from './session-reader';
import { SessionSecurityService } from './session-security.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly signupChannel: SignupChannelService,
    private readonly session: SessionReader,
    private readonly security: SessionSecurityService,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() dto: RegisterDto) {
    return { data: await this.auth.register(dto) };
  }

  /** Mobile sign-up: creates the account and sends a code (texted by default, mailed with SIGNUP_VERIFY_CHANNEL=email). No session yet. */
  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  @ApiTags('app')
  @ApiOperation({
    operationId: 'signup',
    summary:
      'A3: create the account and send a 6-digit code: texted to the phone by default, mailed to the email when SIGNUP_VERIFY_CHANNEL is email (R-39; the answer then carries `channel: email`). No session yet (R-36). A number another account only typed is not taken from it by a sign-up that proves nothing: a mailed sign-up goes ahead without the number (`phoneNotSaved: true`), and a texted one takes it when its code proves it.',
  })
  @ApiBody({ type: SignupDto })
  @ApiResponse({ status: 201, type: SignupStartedAnswer })
  @ApiResponse({
    status: 400,
    type: ErrorBody,
    description: 'Validation, PHONE_INVALID, PHONE_NOT_SUPPORTED.',
  })
  @ApiResponse({
    status: 409,
    type: ErrorBody,
    description: 'The email or phone is already taken by another account.',
  })
  @ApiResponse({
    status: 429,
    type: ErrorBody,
    description:
      'PHONE_CODE_RESEND_TOO_SOON (texted), EMAIL_CODE_RESEND_TOO_SOON (mailed), RATE_LIMITED.',
  })
  @ApiResponse({
    status: 503,
    type: ErrorBody,
    description:
      'SMS_NOT_CONFIGURED, SMS_SEND_FAILED (texted); EMAIL_NOT_CONFIGURED, EMAIL_SEND_FAILED (mailed).',
  })
  async signup(@Body() dto: SignupDto, @Req() req: Request) {
    return { data: await this.signupChannel.signup(dto, clientAddress(req)) };
  }

  @Post('phone/verify/start')
  @HttpCode(HttpStatus.OK)
  @ApiTags('app')
  @ApiOperation({
    operationId: 'phoneVerifyStart',
    summary:
      'A4 (texted sign-up): send another code. The same answer for any number and secret; only a live sign-up is texted. Answers 409 SIGNUP_CHANNEL_DISABLED while codes are mailed.',
  })
  @ApiBody({ type: PhoneVerifyStartDto })
  @ApiResponse({ status: 200, type: PhoneCodeSentAnswer })
  @ApiResponse({
    status: 400,
    type: ErrorBody,
    description: 'Validation, PHONE_INVALID, PHONE_NOT_SUPPORTED.',
  })
  @ApiResponse({
    status: 409,
    type: ErrorBody,
    description: 'SIGNUP_CHANNEL_DISABLED.',
  })
  @ApiResponse({
    status: 429,
    type: ErrorBody,
    description: 'PHONE_CODE_RESEND_TOO_SOON, RATE_LIMITED.',
  })
  @ApiResponse({
    status: 503,
    type: ErrorBody,
    description: 'SMS_NOT_CONFIGURED.',
  })
  async phoneVerifyStart(
    @Body() dto: PhoneVerifyStartDto,
    @Req() req: Request,
  ) {
    return {
      data: await this.signupChannel.phoneStart(
        dto.phone,
        dto.attempt,
        clientAddress(req),
      ),
    };
  }

  @Post('phone/verify/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiTags('app')
  @ApiOperation({
    operationId: 'phoneVerifyConfirm',
    summary:
      'A4 (texted sign-up): check the texted code (and the mailed one when sign-up asked for it). Right: the first session. Answers 409 SIGNUP_CHANNEL_DISABLED while codes are mailed.',
  })
  @ApiBody({ type: PhoneVerifyConfirmDto })
  @ApiResponse({ status: 200, type: SessionAnswer })
  @ApiResponse({
    status: 400,
    type: ErrorBody,
    description:
      'Validation, PHONE_CODE_INVALID (also for a secret that is not live: restart sign-up after the fourth 400 in a row).',
  })
  @ApiResponse({
    status: 409,
    type: ErrorBody,
    description:
      'PHONE_ALREADY_CONFIRMED, SIGNUP_CHANNEL_DISABLED, or the email or phone was taken meanwhile.',
  })
  @ApiResponse({
    status: 429,
    type: ErrorBody,
    description: 'PHONE_CODE_LOCKED, RATE_LIMITED.',
  })
  async phoneVerifyConfirm(
    @Body() dto: PhoneVerifyConfirmDto,
    @Req() req: Request,
  ) {
    return {
      data: await this.signupChannel.phoneConfirm(
        dto.phone,
        dto.attempt,
        dto.code,
        dto.emailCode,
        clientAddress(req),
      ),
    };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiTags('app')
  @ApiOperation({
    operationId: 'login',
    summary: 'A22: sign in by email or phone, and password.',
  })
  @ApiBody({ type: LoginDto })
  @ApiResponse({ status: 200, type: SessionAnswer })
  @ApiResponse({
    status: 400,
    type: ErrorBody,
    description: 'Validation: a field missing or of the wrong type.',
  })
  @ApiResponse({ status: 401, type: ErrorBody, description: 'Wrong password.' })
  @ApiResponse({
    status: 403,
    type: ErrorBody,
    description:
      'EMAIL_NOT_VERIFIED, PHONE_NOT_CONFIRMED (a sign-up whose phone code was never entered: resume it).',
  })
  @ApiResponse({
    status: 404,
    type: ErrorBody,
    description: 'USER_NOT_IN_WAWUID.',
  })
  async login(@Body() dto: LoginDto) {
    return { data: await this.auth.login(dto) };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiTags('app')
  @ApiOperation({
    operationId: 'refresh',
    summary: 'Trade a refresh token for a new pair; the old one stops working.',
  })
  @ApiBody({ type: RefreshDto })
  @ApiResponse({ status: 200, type: TokenPairAnswer })
  @ApiResponse({
    status: 400,
    type: ErrorBody,
    description: 'Validation: a field missing or of the wrong type.',
  })
  @ApiResponse({ status: 401, type: ErrorBody })
  async refresh(@Body() dto: RefreshDto) {
    return { data: await this.auth.refresh(dto.refreshToken) };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiTags('app')
  @ApiOperation({
    operationId: 'logout',
    summary:
      'Z2: sign out. The refresh token sent stops working. The same answer for a live, a dead or an unknown token.',
  })
  @ApiBody({ type: LogoutDto })
  @ApiResponse({ status: 200, type: SignedOutAnswer })
  @ApiResponse({
    status: 400,
    type: ErrorBody,
    description: 'Validation: a field missing or of the wrong type.',
  })
  @ApiResponse({ status: 429, type: ErrorBody, description: 'RATE_LIMITED.' })
  async logout(@Body() dto: LogoutDto, @Req() req: Request) {
    await this.security.logout(dto.refreshToken, clientAddress(req));
    return { data: { signedOut: true } };
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiTags('app')
  @ApiBearerAuth('wawu-id')
  @ApiOperation({
    operationId: 'changePassword',
    summary:
      'Z2: change the password of the signed-in account. Every other device is signed out; this one gets a new pair to keep using.',
  })
  @ApiBody({ type: ChangePasswordDto })
  @ApiResponse({ status: 200, type: TokenPairAnswer })
  @ApiResponse({
    status: 400,
    type: ErrorBody,
    description:
      'Validation (new password under 8 or over 128 characters), CURRENT_PASSWORD_WRONG, PASSWORD_UNCHANGED.',
  })
  @ApiResponse({
    status: 401,
    type: ErrorBody,
    description: 'SESSION_INVALID.',
  })
  @ApiResponse({
    status: 409,
    type: ErrorBody,
    description: 'PASSWORD_NOT_SET (an account that never had a password).',
  })
  @ApiResponse({
    status: 429,
    type: ErrorBody,
    description: 'RATE_LIMITED (five wrong current passwords in 15 minutes).',
  })
  async changePassword(@Body() dto: ChangePasswordDto, @Req() req: Request) {
    const user = await this.session.accountFor(req);
    return {
      data: await this.security.changePassword(
        user,
        dto.currentPassword,
        dto.newPassword,
      ),
    };
  }

  @Post('otp/start')
  @HttpCode(HttpStatus.OK)
  async otpStart(@Body() dto: OtpStartDto) {
    return { data: await this.auth.otpStart(dto.phone) };
  }

  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  async otpVerify(@Body() dto: OtpVerifyDto) {
    return { data: await this.auth.otpVerify(dto.phone, dto.code) };
  }

  @Post('email/verify/start')
  @HttpCode(HttpStatus.OK)
  async emailVerifyStart(@Body() dto: EmailVerifyStartDto) {
    return { data: await this.auth.emailVerifyStart(dto.email) };
  }

  @Post('email/verify/confirm')
  @HttpCode(HttpStatus.OK)
  async emailVerifyConfirm(@Body() dto: EmailVerifyConfirmDto) {
    return {
      data: await this.auth.emailVerifyConfirm(dto.email, dto.code),
    };
  }

  @Post('activate')
  @HttpCode(HttpStatus.OK)
  async activate(@Body() dto: ActivateDto) {
    return { data: await this.auth.activate(dto) };
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiTags('app')
  @ApiOperation({
    operationId: 'forgotPassword',
    summary:
      'A23: ask for a reset. The same answer whether or not an account exists; a link is mailed only to a proven email.',
  })
  @ApiBody({ type: ForgotPasswordDto })
  @ApiResponse({ status: 200, type: ResetRequestedAnswer })
  @ApiResponse({
    status: 400,
    type: ErrorBody,
    description:
      'Validation: a field missing or of the wrong type, or a `method` other than `sms` or `email`.',
  })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return {
      data: await this.auth.forgotPassword(dto.identifier, dto.method),
    };
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return { data: await this.auth.resetPassword(dto) };
  }
}
