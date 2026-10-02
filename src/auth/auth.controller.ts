import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { clientAddress } from './client-address';
import { ActivateDto } from './dto/activate.dto';
import { EmailVerifyConfirmDto } from './dto/email-verify-confirm.dto';
import { EmailVerifyStartDto } from './dto/email-verify-start.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { OtpStartDto } from './dto/otp-start.dto';
import { OtpVerifyDto } from './dto/otp-verify.dto';
import { PhoneVerifyConfirmDto } from './dto/phone-verify-confirm.dto';
import { PhoneVerifyStartDto } from './dto/phone-verify-start.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SignupDto } from './dto/signup.dto';
import { PhoneSignupService } from './phone-signup.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly phoneSignup: PhoneSignupService,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() dto: RegisterDto) {
    return { data: await this.auth.register(dto) };
  }

  /** Mobile sign-up: creates the account and texts a code. No session yet. */
  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  async signup(@Body() dto: SignupDto, @Req() req: Request) {
    return { data: await this.phoneSignup.signup(dto, clientAddress(req)) };
  }

  @Post('phone/verify/start')
  @HttpCode(HttpStatus.OK)
  async phoneVerifyStart(
    @Body() dto: PhoneVerifyStartDto,
    @Req() req: Request,
  ) {
    return {
      data: await this.phoneSignup.start(
        dto.phone,
        dto.attempt,
        clientAddress(req),
      ),
    };
  }

  @Post('phone/verify/confirm')
  @HttpCode(HttpStatus.OK)
  async phoneVerifyConfirm(
    @Body() dto: PhoneVerifyConfirmDto,
    @Req() req: Request,
  ) {
    return {
      data: await this.phoneSignup.confirm(
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
  async login(@Body() dto: LoginDto) {
    return { data: await this.auth.login(dto) };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshDto) {
    return { data: await this.auth.refresh(dto.refreshToken) };
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
