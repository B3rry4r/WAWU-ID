import { IsString, MaxLength, MinLength } from 'class-validator';

export class ActivateDto {
  @IsString()
  @MinLength(1)
  activationToken!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
