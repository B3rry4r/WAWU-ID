import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class ActivateDto {
  @IsString()
  @MinLength(1)
  activationToken!: string;

  /** Identifies the account the activation token was issued for. */
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
