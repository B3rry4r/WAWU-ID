import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MAIL_APPS, type MailApp } from '../../mail/voices/mail-app';

/**
 * Two reset paths share this endpoint:
 *   • SMS-code (mobile)  → { identifier, code, newPassword }
 *   • Email-link (web)   → { token, email, password }
 * The service validates that one complete set is present.
 */
export class ResetPasswordDto {
  // ── SMS-code path ──────────────────────────────────────────────
  @IsOptional()
  @IsString()
  @MinLength(1)
  identifier?: string; // email OR phone

  @IsOptional()
  @IsString()
  @Length(4, 8)
  code?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword?: string;

  // ── Email-link path ────────────────────────────────────────────
  @IsOptional()
  @IsString()
  @MinLength(1)
  token?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password?: string;

  // VOICES-MAIL (V-44): "voices" makes the account mails this request causes
  // VOICES mails (look, words, links). Anything else, or nothing, leaves them
  // as they were.
  @IsOptional()
  @IsIn(MAIL_APPS)
  app?: MailApp;
}
