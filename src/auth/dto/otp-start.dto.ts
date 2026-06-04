import { IsString, MinLength } from 'class-validator';

export class OtpStartDto {
  @IsString()
  @MinLength(1)
  phone!: string;
}
