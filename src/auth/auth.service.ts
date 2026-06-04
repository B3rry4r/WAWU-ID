import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { WawuUser } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { TokenPair, TokensService } from './tokens.service';

export interface UserResponse {
  id: string;
  fullName: string;
  email: string;
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
      fullName: `${user.firstName} ${user.lastName}`.trim(),
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

  // ── endpoints ────────────────────────────────────────────────────────────────

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
    const email = dto.email.toLowerCase().trim();
    const user = await this.prisma.wawuUser.findUnique({ where: { email } });

    if (!user || !user.passwordHash) {
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

  /**
   * Always responds the same way to avoid leaking which emails exist.
   * Email delivery of the reset link is Phase 4 — here we only mint + store it.
   */
  async forgotPassword(email: string): Promise<{ message: string }> {
    const normalized = email.toLowerCase().trim();
    const user = await this.prisma.wawuUser.findUnique({
      where: { email: normalized },
    });

    if (user) {
      const rawToken = randomBytes(32).toString('hex');
      await this.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: await argon2.hash(rawToken),
          expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        },
      });
      // Phase 4: email `rawToken` to the user as a reset link.
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
}
