import { IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @MinLength(1)
  identifier!: string; // accepts email OR phone number

  @IsString()
  @MinLength(1)
  password!: string;
}
