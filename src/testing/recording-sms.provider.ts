import type { SmsProvider } from '../sms/sms.provider';
import { SmsSendError } from '../sms/sms.provider';

/**
 * An SMS provider for tests: it keeps what it was asked to send and sends
 * nothing. It lives under src/testing and is only ever handed to a test
 * module; no production module imports it.
 */
export class RecordingSmsProvider implements SmsProvider {
  readonly sent: Array<{ to: string; message: string }> = [];
  configured = true;
  failNext = false;

  isConfigured(): boolean {
    return this.configured;
  }

  send(to: string, message: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new SmsSendError('refused', 400));
    }
    this.sent.push({ to, message });
    return Promise.resolve();
  }

  /** The 6-digit code in the most recent message. */
  lastCode(): string {
    const last = this.sent[this.sent.length - 1];
    const match = last?.message.match(/\b(\d{6})\b/);
    if (!match) throw new Error('no code was sent');
    return match[1];
  }
}
