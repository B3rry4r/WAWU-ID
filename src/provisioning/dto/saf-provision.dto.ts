import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

export class SafProvisionDto {
  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsString()
  @IsOptional()
  firstName?: string;

  @IsString()
  @IsOptional()
  lastName?: string;

  /** Which programme drove this provisioning — recorded on the consent ledger. */
  @IsString()
  @IsOptional()
  source?: string;

  /**
   * Re-send the activation email to an ALREADY-provisioned user (re-issues a
   * fresh activation token). Used to re-deliver the corrected onboarding email
   * to users who were emailed before the template was fixed.
   */
  @IsBoolean()
  @IsOptional()
  resend?: boolean;
}
