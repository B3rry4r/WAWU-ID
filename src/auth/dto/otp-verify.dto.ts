import { IsString, Length, MinLength } from 'class-validator';

export class OtpVerifyDto {
  @IsString()
  @MinLength(1)
  phone!: string;

  @IsString()
  @Length(6, 6)
  code!: string;
}
