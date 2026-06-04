import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { WawuUser } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'crypto';
import type { SignOptions } from 'jsonwebtoken';
import { PrismaService } from '../prisma/prisma.service';
import { JwksService } from '../jwks/jwks.service';

type ExpiresIn = NonNullable<SignOptions['expiresIn']>;

/** Access-token payload — authoritative shape from Brief Section 2. */
export interface AccessTokenPayload {
  sub: string;
  email: string | null;
  phone: string;
  firstName: string | null;
  lastName: string | null;
  country: string | null;
  verificationTier: string;
  trustScore: number;
  status: string;
  platformRefs: {
    wawuafricaAppUserId: number | null;
    onboardingRef: string | null;
    beautyUserId: number | null;
    basketUserId: string | null;
  };
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class TokensService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly jwks: JwksService,
    private readonly prisma: PrismaService,
  ) {}

  private buildAccessPayload(user: WawuUser): AccessTokenPayload {
    return {
      sub: user.id,
      email: user.email,
      phone: user.phone,
      firstName: user.firstName,
      lastName: user.lastName,
      country: user.country,
      verificationTier: user.verificationTier,
      trustScore: user.trustScore,
      status: user.status,
      platformRefs: {
        wawuafricaAppUserId: user.wawuafricaAppUserId,
        onboardingRef: user.onboardingRef,
        beautyUserId: user.beautyUserId,
        basketUserId: user.basketUserId,
      },
    };
  }

  /** Issue a fresh access+refresh pair and persist the refresh-token hash. */
  async issueTokens(user: WawuUser): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync(this.buildAccessPayload(user), {
      algorithm: 'RS256',
      expiresIn: this.config.getOrThrow<string>('JWT_EXPIRES_IN') as ExpiresIn,
      keyid: this.jwks.kid,
    });

    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, jti: randomUUID(), type: 'refresh' },
      {
        algorithm: 'RS256',
        expiresIn: this.config.getOrThrow<string>(
          'REFRESH_EXPIRES_IN',
        ) as ExpiresIn,
      },
    );

    const decoded = this.jwt.decode(refreshToken) as { exp: number };
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: await argon2.hash(refreshToken),
        expiresAt: new Date(decoded.exp * 1000),
      },
    });

    return { accessToken, refreshToken };
  }

  /** Mint a one-time activation token (used by Phase 4 provisioning). */
  async signActivationToken(userId: string): Promise<string> {
    return this.jwt.signAsync(
      { sub: userId, type: 'activation' },
      { algorithm: 'RS256', expiresIn: '7d' as ExpiresIn },
    );
  }

  /** Verify an activation token and return the user id it was issued for. */
  async verifyActivationToken(token: string): Promise<string> {
    let payload: { sub: string; type?: string };
    try {
      payload = await this.jwt.verifyAsync(token, { algorithms: ['RS256'] });
    } catch {
      throw new UnauthorizedException('Invalid or expired activation token');
    }
    if (payload.type !== 'activation') {
      throw new UnauthorizedException('Invalid or expired activation token');
    }
    return payload.sub;
  }

  /**
   * Validate a presented refresh token, delete the stored record (single-use
   * rotation), and issue a new pair from the user's current state.
   */
  async rotateRefreshToken(presented: string): Promise<TokenPair> {
    let payload: { sub: string; type?: string };
    try {
      payload = await this.jwt.verifyAsync(presented, { algorithms: ['RS256'] });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const records = await this.prisma.refreshToken.findMany({
      where: { userId: payload.sub },
    });

    let matched: (typeof records)[number] | undefined;
    for (const record of records) {
      if (await argon2.verify(record.tokenHash, presented)) {
        matched = record;
        break;
      }
    }
    if (!matched) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Single-use: remove the old token before issuing a replacement.
    await this.prisma.refreshToken.delete({ where: { id: matched.id } });

    if (matched.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.prisma.wawuUser.findUnique({
      where: { id: payload.sub },
    });
    if (!user) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    return this.issueTokens(user);
  }
}
