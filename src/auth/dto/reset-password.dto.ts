import {
  IsEmail,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

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
}
