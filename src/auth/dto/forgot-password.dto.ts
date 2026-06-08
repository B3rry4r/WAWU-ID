import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class ForgotPasswordDto {
  @IsString()
  @MinLength(1)
  identifier!: string; // accepts email OR phone number

  // Delivery channel for the reset secret.
  //   'sms'   → 6-digit code delivered via WhatsApp (mobile apps; default).
  //   'email' → Resend reset link (web hub; requires an email on the account).
  @IsOptional()
  @IsIn(['sms', 'email'])
  method?: 'sms' | 'email';
}
