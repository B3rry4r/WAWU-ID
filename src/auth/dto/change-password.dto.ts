import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MAIL_APPS, type MailApp } from '../../mail/voices/mail-app';

export class ChangePasswordDto {
  @ApiProperty({ description: 'The password the account has now.' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword!: string;

  @ApiProperty({
    minLength: 8,
    maxLength: 128,
    description: 'The same length rule as a reset (8 to 128 characters).',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword!: string;

  // VOICES-MAIL (V-44): "voices" makes the account mails this request causes
  // VOICES mails (look, words, links). Anything else, or nothing, leaves them
  // as they were.
  @IsOptional()
  @IsIn(MAIL_APPS)
  app?: MailApp;
}
