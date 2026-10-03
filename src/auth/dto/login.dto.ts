import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    description: 'Email, or phone as typed (0803... or +234...).',
  })
  @IsString()
  @MinLength(1)
  identifier!: string; // accepts email OR phone number

  @ApiProperty()
  @IsString()
  @MinLength(1)
  password!: string;
}
