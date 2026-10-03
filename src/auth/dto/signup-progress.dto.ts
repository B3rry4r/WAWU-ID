import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { AFTER_PHONE_STEPS, type AfterPhoneStep } from '../signup-sequence';

/** The step to complete. `email` here means "Later": the email is proven with its own code. */
export class SignupProgressDto {
  @ApiProperty({
    enum: AFTER_PHONE_STEPS,
    description:
      'Must be the next step. `email` puts the email off; proving it is POST /auth/signup/email/confirm.',
  })
  @IsIn(AFTER_PHONE_STEPS)
  step!: AfterPhoneStep;
}
