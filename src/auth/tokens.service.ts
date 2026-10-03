import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { WawuUser } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes, randomUUID } from 'crypto';
import type { SignOptions } from 'jsonwebtoken';
import { PrismaService } from '../prisma/prisma.service';
import { JwksService } from '../jwks/jwks.service';
import { phoneForClients } from './released-phone';
import {
  deriveVerification,
  type VerificationState,
} from '../common/verification.util';

type ExpiresIn = NonNullable<SignOptions['expiresIn']>;

/** Activation links are valid for 72 hours (mirrors password-reset handling). */
const ACTIVATION_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

/** Access-token payload — authoritative shape from Brief Section 2. */
export interface AccessTokenPayload {
  sub: string;
  email: string | null;
  phone: string;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  country: string | null;
  /**
   * LEGACY. Still claimed so a resource server built against the old ladder
   * keeps verifying tokens through this deploy. Read `verification`.
   */
  verificationTier: string;
  /** LEGACY. Trust Score is gone as a product surface. */
  trustScore: number;
  /**
   * The two ticks, derived at issue time. A resource server can draw a badge
   * straight off the token without a round trip.
   *
   * It is a SNAPSHOT: an access token lives 15 minutes, so a tick revoked or
   * an expiry crossed inside that window is still claimed by an already-issued
   * token. Anything that gates money or hosting rights reads the user row,
   * not this claim.
   */
  verification: VerificationState;
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
      phone: phoneForClients(user.phone),
      firstName: user.firstName,
      // Carried so the profile screen can prefill all three name parts
      // without a second round trip. Null for the phone-first signups that
      // never supplied one.
      middleName: user.middleName,
      lastName: user.lastName,
      country: user.country,
      verificationTier: user.verificationTier,
      trustScore: user.trustScore,
      verification: deriveVerification(user),
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
    // A mobile sign-up whose phone code was never entered holds no session,
    // whichever route asks for one (sign-in, email confirmation, the phone
    // OTP, a reset, a refresh). Every token this service mints comes through
    // here, so this is the one place that has to know. Accounts without a
    // pending sign-up (all web and legacy rows) are not touched.
    if (!user.phoneVerifiedAt) {
      const pending = await this.prisma.phoneVerification.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });
      if (pending) {
        throw new ForbiddenException({
          statusCode: 403,
          code: 'PHONE_NOT_CONFIRMED',
          message: 'Confirm your phone number to finish signing up.',
        });
      }
    }

    // `issuer` lets every resource server confirm a token came from THIS
    // identity service rather than merely being signed by some key in the
    // JWKS. Emitted only when configured, and additive: verifiers that do not
    // check `iss` ignore it, so this is safe to ship ahead of them.
    const issuer = this.config.get<string>('JWT_ISSUER');

    const accessToken = await this.jwt.signAsync(this.buildAccessPayload(user), {
      algorithm: 'RS256',
      expiresIn: this.config.getOrThrow<string>('JWT_EXPIRES_IN') as ExpiresIn,
      keyid: this.jwks.kid,
      ...(issuer ? { issuer } : {}),
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

  /**
   * Mint a one-time activation token for Category B users. Mirrors password-reset
   * tokens: a high-entropy random token is returned to the caller (to embed in an
   * emailed link) while only its argon2 hash is persisted, with a 72h expiry.
   */
  async issueActivationToken(userId: string): Promise<string> {
    const rawToken = randomBytes(32).toString('hex');
    await this.prisma.activationToken.create({
      data: {
        userId,
        tokenHash: await argon2.hash(rawToken),
        expiresAt: new Date(Date.now() + ACTIVATION_TOKEN_TTL_MS),
      },
    });
    return rawToken;
  }

  /**
   * Verify a presented activation token against the persisted records for a user
   * and return the matching token record id (so the caller can consume it). The
   * token is matched by argon2 hash and must not be expired.
   */
  async verifyActivationToken(
    userId: string,
    presented: string,
  ): Promise<string> {
    const records = await this.prisma.activationToken.findMany({
      where: { userId },
    });

    let matched: (typeof records)[number] | undefined;
    for (const record of records) {
      if (await argon2.verify(record.tokenHash, presented)) {
        matched = record;
        break;
      }
    }
    if (!matched || matched.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Invalid or expired activation token');
    }
    return matched.id;
  }

  /**
   * Sign out one device: delete the stored record of the presented refresh
   * token. An expired token is still taken out (it was signed by this service
   * and is only being cleaned up); a forged, wrong-type or unknown one does
   * nothing. Never throws for a bad token and never says which case it was.
   */
  async revokeRefreshToken(presented: string): Promise<void> {
    let payload: { sub?: unknown; type?: unknown };
    try {
      payload = await this.jwt.verifyAsync(presented, {
        algorithms: ['RS256'],
        ignoreExpiration: true,
      });
    } catch {
      return;
    }
    if (payload.type !== 'refresh' || typeof payload.sub !== 'string') return;

    const records = await this.prisma.refreshToken
      .findMany({ where: { userId: payload.sub } })
      .catch(() => []);
    for (const record of records) {
      if (await argon2.verify(record.tokenHash, presented)) {
        await this.prisma.refreshToken.deleteMany({ where: { id: record.id } });
        return;
      }
    }
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
