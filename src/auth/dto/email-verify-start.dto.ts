import { IsEmail, IsIn, IsOptional } from 'class-validator';
import { MAIL_APPS, type MailApp } from '../../mail/voices/mail-app';

export class EmailVerifyStartDto {
  @IsEmail()
  email!: string;

  // VOICES-MAIL (V-44): "voices" makes the account mails this request causes
  // VOICES mails (look, words, links). Anything else, or nothing, leaves them
  // as they were.
  @IsOptional()
  @IsIn(MAIL_APPS)
  app?: MailApp;
}
