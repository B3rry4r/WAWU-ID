/**
 * How a text message leaves this service.
 *
 * Sign-up codes go through this interface so the route that sends them does
 * not know which company carries the message. The real implementation is
 * FintavaSmsProvider. A test supplies its own implementation through the
 * SMS_PROVIDER token; nothing in a production code path pretends to send.
 */
export interface SmsProvider {
  /** True when the provider has everything it needs to send. */
  isConfigured(): boolean;

  /**
   * Send `message` to `to`, an international number such as +2348031234412.
   * Resolves when the provider accepted the message, rejects with
   * SmsSendError when it did not.
   */
  send(to: string, message: string): Promise<void>;
}

export const SMS_PROVIDER = Symbol('SMS_PROVIDER');

/** The provider refused the message or could not be reached. */
export class SmsSendError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SmsSendError';
  }
}
