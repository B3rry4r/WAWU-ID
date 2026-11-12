import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { MAIL_APPS, type MailApp } from '../../mail/voices/mail-app';

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

  // VOICES-MAIL (V-44): "voices" makes the account mails this request causes
  // VOICES mails (look, words, links). Anything else, or nothing, leaves them
  // as they were.
  @IsOptional()
  @IsIn(MAIL_APPS)
  app?: MailApp;
}
