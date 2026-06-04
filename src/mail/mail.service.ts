import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    this.from = this.config.get<string>('MAIL_FROM') ?? 'noreply@wawu.africa';

    const host = this.config.get<string>('SMTP_HOST');
    if (!host) {
      this.logger.warn('SMTP not configured — emails will be skipped (logged only)');
      this.transporter = null;
      return;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port: Number(this.config.get<string>('SMTP_PORT') ?? 587),
      secure: Number(this.config.get<string>('SMTP_PORT') ?? 587) === 465,
      auth: {
        user: this.config.get<string>('SMTP_USER'),
        pass: this.config.get<string>('SMTP_PASS'),
      },
    });
  }

  /** Sends an email, or logs and no-ops if SMTP isn't configured. */
  private async send(
    to: string,
    subject: string,
    text: string,
    html: string,
  ): Promise<void> {
    if (!this.transporter) {
      this.logger.warn(`[mail skipped] to=${to} subject="${subject}"`);
      return;
    }
    try {
      await this.transporter.sendMail({ from: this.from, to, subject, text, html });
      this.logger.log(`Email sent to ${to}: ${subject}`);
    } catch (err) {
      // Fail gracefully: never let email delivery break the auth flow.
      this.logger.error(`Failed to send email to ${to}: ${String(err)}`);
    }
  }

  async sendPasswordReset(email: string, resetUrl: string): Promise<void> {
    const text = `Click here to reset your WAWUAfrica password: ${resetUrl}`;
    const html = `<p>Click here to reset your WAWUAfrica password:</p><p><a href="${resetUrl}">${resetUrl}</a></p>`;
    await this.send(email, 'Reset your WAWUAfrica password', text, html);
  }

  async sendActivation(email: string, activationUrl: string): Promise<void> {
    const text = `Activate your WAWU ID account: ${activationUrl}`;
    const html = `<p>Activate your WAWU ID account:</p><p><a href="${activationUrl}">${activationUrl}</a></p>`;
    await this.send(email, 'Activate your WAWU ID account', text, html);
  }
}
