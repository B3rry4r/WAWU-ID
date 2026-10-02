import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmsProvider, SmsSendError } from './sms.provider';

/**
 * Sends a text through Fintava's `POST /sms/send`.
 *
 * The call is written to Fintava's published API (docs/fintava/reference/
 * send-sms.md in the mobile repo): `Authorization: Bearer <key>`, a JSON body
 * of `{ to, sms }`, the number with its country code, and a 200 on success.
 * Fintava lists its sandbox at https://dev.fintavapay.com/api/dev.
 *
 * Configuration comes from the same two settings the Hub uses for Fintava, so
 * one set of keys covers both: FINTAVA_BASE_URL and FINTAVA_API_KEY. With
 * either missing the provider reports itself unconfigured and sign-up answers
 * 503; it never reports a send that did not happen.
 *
 * Fintava charges for each message (docs/fintava/fees.md). The provider does
 * not retry: one request is one message.
 */
@Injectable()
export class FintavaSmsProvider implements SmsProvider {
  private readonly logger = new Logger(FintavaSmsProvider.name);

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return !!this.baseUrl() && !!this.config.get<string>('FINTAVA_API_KEY');
  }

  async send(to: string, message: string): Promise<void> {
    const base = this.baseUrl();
    const key = this.config.get<string>('FINTAVA_API_KEY');
    if (!base || !key) {
      throw new SmsSendError('The SMS provider is not configured');
    }

    let response: Response;
    try {
      response = await fetch(`${base}/sms/send`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ to, sms: message }),
      });
    } catch (err) {
      this.logger.error(`Fintava SMS request failed: ${String(err)}`);
      throw new SmsSendError('The SMS provider could not be reached');
    }

    if (!response.ok) {
      // The body is logged, the message text and the number are not: both
      // carry the code or the person.
      const body = await response.text().catch(() => '');
      this.logger.error(
        `Fintava SMS refused with HTTP ${response.status}: ${body.slice(0, 300)}`,
      );
      throw new SmsSendError(
        `The SMS provider answered HTTP ${response.status}`,
        response.status,
      );
    }
  }

  private baseUrl(): string | undefined {
    return this.config.get<string>('FINTAVA_BASE_URL')?.replace(/\/+$/, '');
  }
}
