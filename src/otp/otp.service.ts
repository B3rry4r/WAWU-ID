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
const TERMII_SEND_URL = 'https://api.ng.termii.com/api/sms/send';

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Generate a 6-digit code, persist its hash, and send it via Termii SMS. */
  async generateAndSend(phone: string): Promise<void> {
    // Testing bypass: when OTP_BYPASS_CODE is set, skip Termii and store that
    // fixed code as the OTP for any phone. Remove the env var to re-enable SMS.
    const bypassCode = this.config.get<string>('OTP_BYPASS_CODE');
    if (bypassCode) {
      this.logger.warn('OTP bypass active — not for production');
      await this.storeSession(phone, bypassCode);
      return;
    }

    // Fail before any DB write if the SMS provider isn't configured.
    if (!this.config.get<string>('TERMII_API_KEY')) {
      throw new InternalServerErrorException('SMS provider is not configured');
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.storeSession(phone, code);
    await this.sendSms(phone, code);
  }

  /** Persist the hashed code, replacing any existing OTP for the phone. */
  private async storeSession(phone: string, code: string): Promise<void> {
    const codeHash = await argon2.hash(code);
    await this.prisma.otpSession.deleteMany({ where: { phone } });
    await this.prisma.otpSession.create({
      data: { phone, codeHash, expiresAt: new Date(Date.now() + OTP_TTL_MS) },
    });
  }

  private async sendSms(phone: string, code: string): Promise<void> {
    const apiKey = this.config.get<string>('TERMII_API_KEY');
    if (!apiKey) {
      throw new InternalServerErrorException('SMS provider is not configured');
    }

    let response: Response;
    try {
      response = await fetch(TERMII_SEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: phone,
          from: this.config.get<string>('TERMII_SENDER_ID') ?? 'WAWUAfrica',
          sms: `Your WAWUAfrica code is ${code}. Expires in 5 minutes.`,
          type: 'plain',
          channel: 'generic',
          api_key: apiKey,
        }),
      });
    } catch (err) {
      this.logger.error(`Termii request failed: ${String(err)}`);
      throw new InternalServerErrorException('Failed to send OTP');
    }

    const bodyText = await response.text();
    this.logger.log(`Termii response [${response.status}]: ${bodyText}`);

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
