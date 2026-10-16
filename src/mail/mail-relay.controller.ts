import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SendMailDto } from './dto/send-mail.dto';
import { MailRelayService } from './mail-relay.service';
import { ServiceKeyGuard } from './service-key.guard';

/**
 * Service-to-service mail send (EMAIL-02). Guarded by the shared X-Service-Key
 * header; there is no user auth here, so the guard is mandatory.
 */
@Controller('internal/mail')
@UseGuards(ServiceKeyGuard)
export class MailRelayController {
  constructor(private readonly relay: MailRelayService) {}

  /**
   * POST /internal/mail/send
   * Body: { to, subject, html, text, headers?, tag?, attachments? }
   * Optional header: Idempotency-Key (the same key answers with the first mail).
   *
   * 200 { id } sent, or { id, attachments } when the body had an attachments
   * list, `attachments` being how many files were handed to the sender (the
   * caller compares it with what it sent) | 400 bad body or address | 401 no
   * key | 429 daily cap |
   * 502 the provider refused | 503 try again (busy, unreachable, or no email
   * key set on this service).
   */
  @Post('send')
  @HttpCode(HttpStatus.OK)
  send(
    @Body() dto: SendMailDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<{ id: string; attachments?: number }> {
    return this.relay.send(dto, idempotencyKey);
  }
}
