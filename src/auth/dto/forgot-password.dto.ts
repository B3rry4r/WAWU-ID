import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class ForgotPasswordDto {
  @ApiProperty({ description: 'Email or phone number.' })
  @IsString()
  @MinLength(1)
  identifier!: string; // accepts email OR phone number

  // Delivery channel for the reset secret.
  //   'sms'   → 6-digit code delivered via WhatsApp (mobile apps; default).
  //   'email' → Resend reset link (web hub; requires an email on the account).
  @ApiPropertyOptional({
    enum: ['sms', 'email'],
    description: 'Without it, `sms`. The app sends `email`.',
  })
  @IsOptional()
  @IsIn(['sms', 'email'])
  method?: 'sms' | 'email';
}
