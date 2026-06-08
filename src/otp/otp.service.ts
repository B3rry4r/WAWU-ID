import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    // The OTP testing bypass must never be reachable in production. If the env
    // var is present at startup in a prod deployment, log a loud security error
    // rather than throwing — throwing here would crash the service on boot and
    // cause an auth outage. The bypass is still NEVER honored in production: the
    // runtime guard in generateAndSend() refuses to use it. This only flags the
    // misconfiguration so it can be remediated.
    if (this.isProduction() && this.config.get<string>('OTP_BYPASS_CODE')) {
      this.logger.error(
        'SECURITY: OTP_BYPASS_CODE is set while NODE_ENV=production. The ' +
          'bypass is being IGNORED and will NOT be honored, but it MUST be ' +
          'unset in the production environment immediately.',
      );
    }
  }

  private isProduction(): boolean {
    return this.config.get<string>('NODE_ENV') === 'production';
  }

  /** Generate a 6-digit code, persist its hash, and send it via WhatsApp. */
  async generateAndSend(phone: string): Promise<void> {
    // Testing bypass: when OTP_BYPASS_CODE is set, skip WhatsApp and store that
    // fixed code as the OTP for any phone. Remove the env var to re-enable
    // WhatsApp delivery. Hard-guarded: the bypass is ALWAYS ignored in
    // production, even if the env var is somehow present (constructor also
    // refuses to boot in that case). Dev/test behaviour is unchanged.
    const bypassCode = this.config.get<string>('OTP_BYPASS_CODE');
    if (bypassCode && !this.isProduction()) {
      this.logger.warn('OTP bypass active — not for production');
      await this.storeSession(phone, bypassCode);
      return;
    }

    // Fail before any DB write if the OTP provider isn't configured.
    if (
      !this.config.get<string>('WHATSAPP_TOKEN') ||
      !this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID')
    ) {
      throw new InternalServerErrorException('OTP provider is not configured');
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.storeSession(phone, code);
    await this.sendWhatsapp(phone, code);
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
    const template = this.config.get<string>('WHATSAPP_OTP_TEMPLATE') ?? 'wawu_otp';
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
