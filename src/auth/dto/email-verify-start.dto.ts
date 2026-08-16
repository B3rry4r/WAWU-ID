import { IsEmail } from 'class-validator';

export class EmailVerifyStartDto {
  @IsEmail()
  email!: string;
}
