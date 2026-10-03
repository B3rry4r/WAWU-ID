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
  ErrorBody,
  SignupProgressAnswer,
  SignupResumeAnswer,
} from '../contract/identity-schemas';
import { clientAddress } from './client-address';
import { SignupEmailConfirmDto } from './dto/signup-email-confirm.dto';
import { SignupProgressDto } from './dto/signup-progress.dto';
import { SignupResumeDto } from './dto/signup-resume.dto';
import { PhoneSignupService } from './phone-signup.service';
import { SessionReader } from './session-reader';
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
    private readonly phoneSignup: PhoneSignupService,
    private readonly sequence: SignupSequenceService,
    private readonly session: SessionReader,
  ) {}

  @Post('resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'signupResume',
    summary:
      'Where a sign-up stands before its phone code, for an app that was closed between A3 and A4. Sends nothing.',
  })
  @ApiBody({ type: SignupResumeDto })
  @ApiResponse({ status: 200, type: SignupResumeAnswer })
  @ApiResponse({ status: 400, type: ErrorBody, description: 'Validation.' })
  @ApiResponse({ status: 429, type: ErrorBody, description: 'RATE_LIMITED.' })
  async resume(@Body() dto: SignupResumeDto, @Req() req: Request) {
    return {
      data: await this.phoneSignup.resume(
        dto.phone,
        dto.attempt,
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
