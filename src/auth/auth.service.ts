import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WawuUser } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';
import { MailService } from '../mail/mail.service';
import { OtpService } from '../otp/otp.service';
import { PrismaService } from '../prisma/prisma.service';
import { ActivateDto } from './dto/activate.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { TokenPair, TokensService } from './tokens.service';

export interface UserResponse {
  id: string;
  fullName: string;
  email: string | null;
  phone: string;
  country: string | null;
  state: string | null;
  occupation: string | null;
  verificationTier: string;
  trustScore: number;
  status: string;
}

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    private readonly otp: OtpService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  // ── helpers ────────────────────────────────────────────────────────────────

  private splitName(fullName: string): { firstName: string; lastName: string } {
    const parts = fullName.trim().split(/\s+/);
    const firstName = parts.shift() ?? '';
    return { firstName, lastName: parts.join(' ') };
  }

  private toUserResponse(
    user: WawuUser,
    occupation: string | null = null,
  ): UserResponse {
    return {
      id: user.id,
      fullName: [user.firstName, user.lastName].filter(Boolean).join(' '),
      email: user.email,
      phone: user.phone,
      country: user.country,
      state: user.state ?? null,
      occupation,
      verificationTier: user.verificationTier,
      trustScore: user.trustScore,
      status: user.status,
    };
  }

  // ── email + password ────────────────────────────────────────────────────────

  async register(
    dto: RegisterDto,
  ): Promise<TokenPair & { user: UserResponse }> {
    const email = dto.email.toLowerCase().trim();

    const existing = await this.prisma.wawuUser.findFirst({
      where: { OR: [{ email }, { phone: dto.phone }] },
    });
    if (existing) {
      throw new ConflictException(
        'An account with this email or phone already exists',
      );
    }

    const { firstName, lastName } = this.splitName(dto.fullName);
    const user = await this.prisma.wawuUser.create({
      data: {
        email,
        phone: dto.phone,
        firstName,
        lastName,
        country: dto.country,
        state: dto.state ?? null,
        passwordHash: await argon2.hash(dto.password),
        verificationTier: 'basic',
        trustScore: 0,
        status: 'active',
      },
    });

    const pair = await this.tokens.issueTokens(user);
    return { ...pair, user: this.toUserResponse(user, dto.occupation ?? null) };
  }

  async login(dto: LoginDto): Promise<TokenPair & { user: UserResponse }> {
    const user = await this.prisma.wawuUser.findFirst({
      where: {
        OR: [
          { email: dto.identifier.toLowerCase().trim() },
          { phone: dto.identifier.trim() },
        ],
      },
    });

    if (!user) {
      throw new UnauthorizedException({
        statusCode: 404,
        code: 'USER_NOT_IN_WAWUID',
        message: 'No account found with this email or phone number.',
      });
    }
    if (!user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const pair = await this.tokens.issueTokens(user);
    return { ...pair, user: this.toUserResponse(user) };
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    return this.tokens.rotateRefreshToken(refreshToken);
  }

  // ── OTP (phone) ───────────────────────────────────────────────────────────────

  async otpStart(phone: string): Promise<{ message: string; expiresIn: number }> {
    await this.otp.generateAndSend(phone);
    return { message: 'OTP sent', expiresIn: 300 };
  }

  async otpVerify(
    phone: string,
    code: string,
  ): Promise<TokenPair & { user: UserResponse }> {
    const ok = await this.otp.verify(phone, code);
    if (!ok) {
      throw new UnauthorizedException('Invalid or expired OTP');
    }

    // Find or create a phone-only user (e.g. WAWUBasket-style signup).
    let user = await this.prisma.wawuUser.findUnique({ where: { phone } });
    if (!user) {
      user = await this.prisma.wawuUser.create({
        data: {
          phone,
          verificationTier: 'basic',
          trustScore: 0,
          status: 'active',
        },
      });
    }

    const pair = await this.tokens.issueTokens(user);
    return { ...pair, user: this.toUserResponse(user) };
  }

  // ── password reset + activation ────────────────────────────────────────────

  /** Always responds the same way to avoid leaking which emails exist. */
  async forgotPassword(identifier: string): Promise<{ message: string }> {
    const user = await this.prisma.wawuUser.findFirst({
      where: {
        OR: [
          { email: identifier.toLowerCase().trim() },
          { phone: identifier.trim() },
        ],
      },
    });

    // Reset links are emailed, so a deliverable email address is required.
    if (user?.email) {
      const rawToken = randomBytes(32).toString('hex');
      await this.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: await argon2.hash(rawToken),
          expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        },
      });

      const appUrl = this.config.get<string>('APP_URL') ?? '';
      const resetUrl = `${appUrl}/auth/reset-password?token=${rawToken}&email=${encodeURIComponent(user.email)}`;
      await this.mail.sendPasswordReset(user.email, resetUrl);
    }

    return { message: 'Reset link sent if account exists' };
  }

  async resetPassword(dto: ResetPasswordDto): Promise<{ message: string }> {
    const email = dto.email.toLowerCase().trim();
    const user = await this.prisma.wawuUser.findUnique({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('Invalid or expired reset token');
    }

    const records = await this.prisma.passwordResetToken.findMany({
      where: { userId: user.id },
    });
    let matched: (typeof records)[number] | undefined;
    for (const record of records) {
      if (await argon2.verify(record.tokenHash, dto.token)) {
        matched = record;
        break;
      }
    }
    if (!matched || matched.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Invalid or expired reset token');
    }

    await this.prisma.$transaction([
      this.prisma.wawuUser.update({
        where: { id: user.id },
        data: { passwordHash: await argon2.hash(dto.password) },
      }),
      // Invalidate all reset tokens and active sessions for this user.
      this.prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }),
      this.prisma.refreshToken.deleteMany({ where: { userId: user.id } }),
    ]);

    return { message: 'Password reset successfully' };
  }

  /** One-time activation for Category B users: set a password via emailed token. */
  async activate(dto: ActivateDto): Promise<TokenPair & { user: UserResponse }> {
    const userId = await this.tokens.verifyActivationToken(dto.activationToken);
    const user = await this.prisma.wawuUser.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('Invalid or expired activation token');
    }
    if (user.passwordHash) {
      throw new BadRequestException('Account already activated');
    }

    const updated = await this.prisma.wawuUser.update({
      where: { id: user.id },
      data: { passwordHash: await argon2.hash(dto.password) },
    });

    const pair = await this.tokens.issueTokens(updated);
    return { ...pair, user: this.toUserResponse(updated) };
  }
}
