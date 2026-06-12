import { IsDateString, IsOptional, IsString, MinLength } from 'class-validator';

export class PublishPolicyDto {
  @IsString()
  @MinLength(1)
  slug!: string;

  @IsString()
  @MinLength(1)
  version!: string;

  @IsString()
  @MinLength(1)
  title!: string;

  @IsString()
  @MinLength(1)
  url!: string;

  @IsDateString()
  effectiveDate!: string;

  @IsOptional()
  @IsString()
  summary?: string;
}
