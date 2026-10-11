import {
  Body,
  Controller,
  Get,
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
  EmailCodeSentAnswer,
  EmailSignupCodeSentAnswer,
  ErrorBody,
  SessionAnswer,
  SignupChannelAnswer,
  SignupProgressAnswer,
  SignupResumeAnswer,
} from '../contract/identity-schemas';
import { clientAddress } from './client-address';
import { SignupEmailCodeConfirmDto } from './dto/signup-email-code-confirm.dto';
import { SignupEmailCodeStartDto } from './dto/signup-email-code-start.dto';
import { SignupEmailConfirmDto } from './dto/signup-email-confirm.dto';
import { SignupProgressDto } from './dto/signup-progress.dto';
import { SignupResumeDto } from './dto/signup-resume.dto';
import { SessionReader } from './session-reader';
import { SignupChannelService } from './signup-channel.service';
import { SignupSequenceService } from './signup-sequence.service';

/**
 * The sign-up sequence as one server-enforced order (AUTH-05). Before the
 * phone code, `resume` (with the sign-up's secret) says whether A4 can carry
 * on. After it, the session's progress says which step is next, and a step
 * can only be completed when it is the next one.
 */
@ApiTags('app')
@Controller('auth/signup')
export class SignupSequenceController {
  constructor(
    private readonly signupChannel: SignupChannelService,
    private readonly sequence: SignupSequenceService,
    private readonly session: SessionReader,
  ) {}

  /** A3 asks before the person types anything: which way the sign-up code will travel. */
  @Get('channel')
  @ApiOperation({
    operationId: 'signupChannel',
    summary:
      'A3: which way the sign-up code will travel, so its line can name it: `phone` (texted, the default) or `email` (mailed, SIGNUP_VERIFY_CHANNEL=email). Needs no sign-in, reads no account and sends nothing.',
  })
  @ApiResponse({ status: 200, type: SignupChannelAnswer })
  channel() {
    return { data: { channel: this.signupChannel.channel } };
  }

  @Post('resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'signupResume',
    summary:
      'Where a sign-up stands before its code (texted by default, mailed with SIGNUP_VERIFY_CHANNEL=email), for an app that was closed between A3 and A4. Sends nothing. A sign-up whose code went by the other channel answers `details`.',
  })
  @ApiBody({ type: SignupResumeDto })
  @ApiResponse({ status: 200, type: SignupResumeAnswer })
  @ApiResponse({ status: 400, type: ErrorBody, description: 'Validation.' })
  @ApiResponse({ status: 429, type: ErrorBody, description: 'RATE_LIMITED.' })
  async resume(@Body() dto: SignupResumeDto, @Req() req: Request) {
    return {
      data: await this.signupChannel.resume(
        dto.phone,
        dto.attempt,
        clientAddress(req),
      ),
    };
  }

  @Post('email-code/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'signupEmailCodeStart',
    summary:
      'A4 (mailed sign-up, SIGNUP_VERIFY_CHANNEL=email): mail another code. The same answer for any number and secret; only a live sign-up is mailed, and when Resend refuses it the answer is 503 EMAIL_SEND_FAILED (the code that was live keeps working). Answers 409 SIGNUP_CHANNEL_DISABLED while codes are texted.',
  })
  @ApiBody({ type: SignupEmailCodeStartDto })
  @ApiResponse({ status: 200, type: EmailSignupCodeSentAnswer })
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
    description: 'EMAIL_CODE_RESEND_TOO_SOON, RATE_LIMITED.',
  })
  @ApiResponse({
    status: 503,
    type: ErrorBody,
    description:
      'EMAIL_NOT_CONFIGURED, EMAIL_SEND_FAILED (the mail was not handed over: no wait was started and the code that was live still works).',
  })
  async emailCodeStart(
    @Body() dto: SignupEmailCodeStartDto,
    @Req() req: Request,
  ) {
    return {
      data: await this.signupChannel.emailCodeStart(
        dto.phone,
        dto.attempt,
        clientAddress(req),
      ),
    };
  }

  @Post('email-code/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'signupEmailCodeConfirm',
    summary:
      'A4 (mailed sign-up, SIGNUP_VERIFY_CHANNEL=email): check the mailed code. Right: the email is proven and the first session is issued. Answers 409 SIGNUP_CHANNEL_DISABLED while codes are texted.',
  })
  @ApiBody({ type: SignupEmailCodeConfirmDto })
  @ApiResponse({ status: 200, type: SessionAnswer })
  @ApiResponse({
    status: 400,
    type: ErrorBody,
    description:
      'Validation, EMAIL_CODE_INVALID (also for a secret that is not live: restart sign-up after the fourth 400 in a row).',
  })
  @ApiResponse({
    status: 409,
    type: ErrorBody,
    description:
      'EMAIL_ALREADY_CONFIRMED, SIGNUP_CHANNEL_DISABLED, or the email or phone was taken meanwhile.',
  })
  @ApiResponse({
    status: 429,
    type: ErrorBody,
    description: 'EMAIL_CODE_LOCKED, RATE_LIMITED.',
  })
  async emailCodeConfirm(
    @Body() dto: SignupEmailCodeConfirmDto,
    @Req() req: Request,
  ) {
    return {
      data: await this.signupChannel.emailCodeConfirm(
        dto.phone,
        dto.attempt,
        dto.code,
        clientAddress(req),
      ),
    };
  }

  @Get('progress')
  @ApiBearerAuth('wawu-id')
  @ApiOperation({
    operationId: 'signupProgress',
    summary:
      'The next sign-up step for the signed-in account, after the phone code. `done` for every account not in the sequence.',
  })
  @ApiResponse({ status: 200, type: SignupProgressAnswer })
  @ApiResponse({
    status: 401,
    type: ErrorBody,
    description: 'SESSION_INVALID.',
  })
  async progress(@Req() req: Request) {
    const user = await this.session.accountFor(req);
    return { data: await this.sequence.progress(user) };
  }

  @Post('progress')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('wawu-id')
  @ApiOperation({
    operationId: 'signupCompleteStep',
    summary:
      'Complete the next step (A11, A12, A13), or put the email off. A step already done answers the progress unchanged.',
  })
  @ApiBody({ type: SignupProgressDto })
  @ApiResponse({ status: 200, type: SignupProgressAnswer })
  @ApiResponse({ status: 400, type: ErrorBody, description: 'Validation.' })
  @ApiResponse({
    status: 401,
    type: ErrorBody,
    description: 'SESSION_INVALID.',
  })
  @ApiResponse({
    status: 409,
    type: ErrorBody,
    description: 'SIGNUP_STEP_OUT_OF_ORDER, SIGNUP_ALREADY_FINISHED.',
  })
  async complete(@Body() dto: SignupProgressDto, @Req() req: Request) {
    const user = await this.session.accountFor(req);
    return { data: await this.sequence.complete(user, dto.step) };
  }

  @Post('email/start')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('wawu-id')
  @ApiOperation({
    operationId: 'signupEmailStart',
    summary:
      "Mail a code to the signed-in account's own email, to prove it (then a reset link can reach it).",
  })
  @ApiResponse({ status: 200, type: EmailCodeSentAnswer })
  @ApiResponse({
    status: 401,
    type: ErrorBody,
    description: 'SESSION_INVALID.',
  })
  @ApiResponse({
    status: 409,
    type: ErrorBody,
    description: 'EMAIL_NOT_SET, EMAIL_ALREADY_PROVEN.',
  })
  @ApiResponse({
    status: 429,
    type: ErrorBody,
    description: 'EMAIL_CODE_RESEND_TOO_SOON, RATE_LIMITED.',
  })
  async emailStart(@Req() req: Request) {
    const user = await this.session.accountFor(req);
    return { data: await this.sequence.emailStart(user) };
  }

  @Post('email/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('wawu-id')
  @ApiOperation({
    operationId: 'signupEmailConfirm',
    summary:
      'Check the mailed code. Right: the email is proven and the progress moves on.',
  })
  @ApiBody({ type: SignupEmailConfirmDto })
  @ApiResponse({ status: 200, type: SignupProgressAnswer })
  @ApiResponse({
    status: 400,
    type: ErrorBody,
    description: 'Validation, EMAIL_CODE_INVALID.',
  })
  @ApiResponse({
    status: 401,
    type: ErrorBody,
    description: 'SESSION_INVALID.',
  })
  @ApiResponse({
    status: 409,
    type: ErrorBody,
    description: 'EMAIL_NOT_SET, EMAIL_ALREADY_PROVEN.',
  })
  @ApiResponse({
    status: 429,
    type: ErrorBody,
    description: 'EMAIL_CODE_LOCKED.',
  })
  async emailConfirm(@Body() dto: SignupEmailConfirmDto, @Req() req: Request) {
    const user = await this.session.accountFor(req);
    return { data: await this.sequence.emailConfirm(user, dto.code) };
  }
}
