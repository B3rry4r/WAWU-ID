import { IsString, MaxLength, MinLength } from 'class-validator';

export class PhoneVerifyStartDto {
  @IsString()
  @MinLength(7)
  @MaxLength(25)
  phone!: string;
}
