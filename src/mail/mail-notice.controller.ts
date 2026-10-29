import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { MailNoticeDto } from './dto/mail-notice.dto';
import { MailNoticeService, type NoticeAnswer } from './mail-notice.service';
import { ServiceKeyGuard } from './service-key.guard';

/**
 * Service-to-service notice mail (EMAIL-01). Guarded by the shared
 * X-Service-Key header, the same as POST /internal/mail/send; there is no user
 * auth here, so the guard is mandatory.
 */
@Controller('internal/mail')
@UseGuards(ServiceKeyGuard)
export class MailNoticeController {
  constructor(private readonly notice: MailNoticeService) {}

  /**
   * POST /internal/mail/notice
   * Body: { wawuId, kind, data, idempotencyKey }
   *
   * 200 { sent: true } | { sent: false, replayed: true } |
   *     { sent: false, reason: "no_email" } | 400 an unknown kind or bad data |
   * 401 no key | 409 the key was used for something else |
   * 502 the provider refused | 503 try again.
   */
  @Post('notice')
  @HttpCode(HttpStatus.OK)
  send(@Body() dto: MailNoticeDto): Promise<NoticeAnswer> {
    return this.notice.send(dto);
  }
}
