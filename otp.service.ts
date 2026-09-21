import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { randomInt } from 'crypto';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  /** Generate a 6-digit code, persist its hash, and send it via WhatsApp. */
  async generateAndSend(phone: string): Promise<void> {
    // NOTE: There is deliberately NO OTP bypass — not in prod, not in dev, not
    // in test. Every OTP is a freshly generated 6-digit code delivered over the
    // real channel (WhatsApp when configured, otherwise email). A fixed bypass
    // code is a standing account-takeover hole, so the mechanism does not exist.
    const whatsappConfigured =
      !!this.config.get<string>('WHATSAPP_TOKEN') &&
      !!this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID');

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');

    if (whatsappConfigured) {
      // Primary path: deliver the code over WhatsApp (Meta Cloud API).
      await this.storeSession(phone, code);
      await this.sendWhatsapp(phone, code);
      return;
    }

    // Fallback path: WhatsApp is not configured yet, so deliver the code by
    // EMAIL instead of failing. We look up the user that owns this phone and
    // send to their registered email. This auto-switches back to WhatsApp the
    // moment WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID are set in the env.
    const user = await this.prisma.wawuUser.findFirst({ where: { phone } });
    if (!user?.email) {
      // Neither WhatsApp nor an email-on-file is available — keep the existing
      // "not configured" failure so callers behave exactly as before.
      throw new InternalServerErrorException('OTP provider is not configured');
    }

    await this.storeSession(phone, code);
    await this.mail.sendOtpCode(user.email, code, 'verify your phone number');
  }

  /** Persist the hashed code, replacing any existing OTP for the phone. */
  private async storeSession(phone: string, code: string): Promise<void> {
    const codeHash = await argon2.hash(code);
    await this.prisma.otpSession.deleteMany({ where: { phone } });
    await this.prisma.otpSession.create({
      data: { phone, codeHash, expiresAt: new Date(Date.now() + OTP_TTL_MS) },
    });
  }

  private async sendWhatsapp(phone: string, code: string): Promise<void> {
    const token = this.config.get<string>('WHATSAPP_TOKEN');
    const phoneNumberId = this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    if (!token || !phoneNumberId) {
      throw new InternalServerErrorException('OTP provider is not configured');
    }

    const apiVersion =
      this.config.get<string>('WHATSAPP_API_VERSION') ?? 'v21.0';
    const template =
      this.config.get<string>('WHATSAPP_OTP_TEMPLATE') ?? 'wawu_otp';
    const lang = this.config.get<string>('WHATSAPP_OTP_LANG') ?? 'en';

    // Meta expects the recipient as E.164 digits with no leading '+'.
    const to = phone.replace(/\D/g, '');
    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: template,
            language: { code: lang },
            components: [
              { type: 'body', parameters: [{ type: 'text', text: code }] },
              {
                type: 'button',
                sub_type: 'url',
                index: '0',
                parameters: [{ type: 'text', text: code }],
              },
            ],
          },
        }),
      });
    } catch (err) {
      this.logger.error(`WhatsApp request failed: ${String(err)}`);
      throw new InternalServerErrorException('Failed to send OTP');
    }

    const bodyText = await response.text();
    this.logger.log(`WhatsApp response [${response.status}]: ${bodyText}`);

    if (!response.ok) {
      throw new InternalServerErrorException('Failed to send OTP');
    }
  }

  /** Validate a submitted code; consume the session on success. */
  async verify(phone: string, code: string): Promise<boolean> {
    const session = await this.prisma.otpSession.findFirst({
      where: { phone, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!session) {
      return false;
    }

    const valid = await argon2.verify(session.codeHash, code);
    if (!valid) {
      return false;
    }

    await this.prisma.otpSession.delete({ where: { id: session.id } });
    return true;
  }
}
