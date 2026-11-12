import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { MAIL_APPS, type MailApp } from '../../mail/voices/mail-app';

export class LoginDto {
  @ApiProperty({
    description: 'Email, or phone as typed (0803... or +234...).',
  })
  @IsString()
  @MinLength(1)
  identifier!: string; // accepts email OR phone number

  @ApiProperty()
  @IsString()
  @MinLength(1)
  password!: string;

  // VOICES-MAIL (V-44): "voices" makes the account mails this request causes
  // VOICES mails (look, words, links). Anything else, or nothing, leaves them
  // as they were.
  @IsOptional()
  @IsIn(MAIL_APPS)
  app?: MailApp;
}
