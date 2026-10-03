import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class SignupEmailConfirmDto {
  @ApiProperty({
    pattern: '^\\d{6}$',
    description: 'The code mailed to the email.',
  })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;
}
