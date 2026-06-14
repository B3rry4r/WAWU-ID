import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

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
}
