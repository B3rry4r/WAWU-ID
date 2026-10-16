import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SendMailDto } from './dto/send-mail.dto';
import {
  RELAY_HEADER_ALLOWLIST,
  RELAY_HEADER_MAX_LENGTH,
  mailRelayDailyCap,
} from './mail-relay.config';
import { MailRelayError, MailService } from './mail.service';

/**
 * POST /internal/mail/send (EMAIL-02). Sends one mail through WAWU ID's own
 * Resend mailer for a sibling service, so the Hub needs no email key of its
 * own. Checks the header allowlist and the daily cap, then maps the mailer's
 * failure kinds to the answers the caller acts on: 503 retry, 400 bad
 * address, 429 cap reached, 502 the provider refused.
 */
@Injectable()
export class MailRelayService {
  private day = '';
  private count = 0;

  constructor(
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  async send(
    dto: SendMailDto,
    idempotencyKey?: string,
  ): Promise<{ id: string }> {
    const headers = this.allowedHeaders(dto.headers);
    if (!this.reserve()) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message:
            'The daily email limit has been reached. Try again tomorrow.',
          code: 'MAIL_DAILY_CAP',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    try {
      return await this.mail.sendRelayed({
        to: dto.to,
        subject: dto.subject,
        html: dto.html,
        text: dto.text,
        headers,
        tag: dto.tag,
        idempotencyKey: idempotencyKey?.slice(0, 256) || undefined,
      });
    } catch (e) {
      this.release();
      if (!(e instanceof MailRelayError)) throw e;
      switch (e.kind) {
        case 'invalid_address':
          throw new BadRequestException(e.message);
        case 'refused':
          throw new BadGatewayException(e.message);
        default:
          // not_configured and unavailable: nothing was sent, try again later.
          throw new ServiceUnavailableException(e.message);
      }
    }
  }

  /** Only List-Unsubscribe and List-Unsubscribe-Post, one line each. */
  private allowedHeaders(
    given: Record<string, unknown> | undefined,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(given ?? {})) {
      const canonical = RELAY_HEADER_ALLOWLIST[name.toLowerCase()];
      if (!canonical) {
        throw new BadRequestException(
          'Only the List-Unsubscribe and List-Unsubscribe-Post headers can be set.',
        );
      }
      if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > RELAY_HEADER_MAX_LENGTH ||
        /[\r\n]/.test(value)
      ) {
        throw new BadRequestException(
          `The ${canonical} header must be one line of text.`,
        );
      }
      out[canonical] = value;
    }
    return out;
  }

  /** Take one place in today's count, or say the day is full. */
  private reserve(): boolean {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.count = 0;
    }
    if (this.count >= mailRelayDailyCap(this.config)) return false;
    this.count += 1;
    return true;
  }

  /** A mail that was not sent gives its place back. */
  private release(): void {
    if (this.count > 0) this.count -= 1;
  }
}
