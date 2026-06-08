import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly resend: Resend | null;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    this.from =
      this.config.get<string>('MAIL_FROM') ??
      'WAWUAfrica <noreply@wawuafrica.com>';
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    if (!apiKey) {
      this.logger.warn('RESEND_API_KEY not set — emails will be skipped');
      this.resend = null;
      return;
    }
    this.resend = new Resend(apiKey);
  }

  async send(to: string, subject: string, html: string): Promise<void> {
    if (!this.resend) {
      this.logger.warn(`[mail skipped] to=${to} subject="${subject}"`);
      return;
    }
    try {
      await this.resend.emails.send({ from: this.from, to, subject, html });
      this.logger.log(`Email sent: ${to}`);
    } catch (err) {
      this.logger.error(`Email failed to ${to}: ${String(err)}`);
    }
  }

  async sendPasswordReset(email: string, resetUrl: string): Promise<void> {
    await this.send(
      email,
      'Reset your WAWUAfrica password',
      `<p>Reset your password: <a href="${resetUrl}">${resetUrl}</a></p>`,
    );
  }

  async sendActivation(email: string, activationUrl: string): Promise<void> {
    await this.send(
      email,
      'Activate your WAWU ID',
      `<p>Activate your account: <a href="${activationUrl}">${activationUrl}</a></p>`,
    );
  }
}
