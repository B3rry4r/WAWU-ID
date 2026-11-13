import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import {
  MailAudienceService,
  type MailAudiencePage,
} from './mail-audience.service';
import { ServiceKeyGuard } from './service-key.guard';

export class MailAudienceQuery {
  /** The last id of the previous page. */
  @IsOptional()
  @IsUUID()
  cursor?: string;

  /** 1 to 1000, default 500. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}

/**
 * GET /internal/mail/audience (EMAIL-ID-AUD): the accounts a bulk email to
 * everyone with a Who Made This? account may go to, read by the Hub's email
 * campaigns. Same X-Service-Key guard as the relay (an unset key refuses
 * everyone); it runs before the query is read.
 */
@Controller('internal/mail')
@UseGuards(ServiceKeyGuard)
export class MailAudienceController {
  constructor(private readonly audience: MailAudienceService) {}

  @Get('audience')
  list(@Query() q: MailAudienceQuery): Promise<MailAudiencePage> {
    return this.audience.page(q.cursor, q.limit ?? 500);
  }
}
