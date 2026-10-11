import { MailSendError } from '../mail/mail.service';

/**
 * The mail service's sign-up code call for tests: it keeps what it was asked to
 * send and sends nothing. It lives under src/testing and is only ever handed to
 * a test module; no production module imports it.
 */
export class RecordingMail {
  readonly sent: Array<{
    to: string;
    code: string;
    purpose: string | undefined;
    strict: boolean;
  }> = [];
  configured = true;
  failNext = false;

  isConfigured(): boolean {
    return this.configured;
  }

  sendOtpCode = (
    to: string,
    code: string,
    purpose?: string,
    strict = false,
  ): Promise<void> => {
    if (this.failNext) {
      this.failNext = false;
      return strict
        ? Promise.reject(new MailSendError('refused'))
        : Promise.resolve();
    }
    this.sent.push({ to, code, purpose, strict });
    return Promise.resolve();
  };

  /** The 6-digit code in the most recent mail. */
  lastCode(): string {
    const last = this.sent[this.sent.length - 1];
    if (!last) throw new Error('no code was mailed');
    return last.code;
  }
}
