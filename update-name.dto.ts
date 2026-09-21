import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * The three parts of a name, as collected at sign-up.
 *
 * Middle name is optional and clearable: somebody who entered one by mistake
 * must be able to remove it, so an empty string is a legal value and means
 * "no middle name", not "leave it alone".
 */
export class UpdateNameDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  middleName?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName!: string;
}
