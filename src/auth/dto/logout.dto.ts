import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class LogoutDto {
  @ApiProperty({ description: 'The refresh token this device holds.' })
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  refreshToken!: string;
}
