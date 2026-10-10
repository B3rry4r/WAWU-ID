import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Prisma, RefreshToken, WawuUser } from '@prisma/client';
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

/**
 * Expired refresh-token records of one account removed per issue or sign-out.
 * A bounded number of single-row deletes, so a sign-in never waits on an
 * account with a long backlog; the next one takes the next batch.
 */
export const EXPIRED_SWEEP_BATCH = 50;

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
  private readonly logger = new Logger(TokensService.name);

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

  /** A sign-up whose phone code was never entered holds no session (403). */
  private async refuseIfPhonePending(
    user: WawuUser,
    db: Prisma.TransactionClient | PrismaService,
  ): Promise<void> {
    if (!user.phoneVerifiedAt) {
      const pending = await db.phoneVerification.findUnique({
        where: { userId: user.id },
        select: { id: true, channel: true },
      });
      if (pending) {
        throw new ForbiddenException({
          statusCode: 403,
          code: 'PHONE_NOT_CONFIRMED',
          message:
            pending.channel === 'email'
              ? 'Enter the code we emailed you to finish signing up.'
              : 'Confirm your phone number to finish signing up.',
        });
      }
    }
  }

  /** Issue a fresh access+refresh pair and persist the refresh-token hash. */
  async issueTokens(
    user: WawuUser,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<TokenPair> {
    // A mobile sign-up whose phone code was never entered holds no session,
    // whichever route asks for one (sign-in, email confirmation, the phone
    // OTP, a reset, a refresh). Every token this service mints comes through
    // here, so this is the one place that has to know. Accounts without a
    // pending sign-up (all web and legacy rows) are not touched.
    await this.refuseIfPhonePending(user, db);

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

    // The jti is the record's lookup key: it is signed into the token and
    // stored on the row, so a refresh or a sign-out finds the one row and
    // verifies the hash once, instead of hash-checking every row the account
    // holds.
    const jti = randomUUID();
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, jti, type: 'refresh' },
      {
        algorithm: 'RS256',
        expiresIn: this.config.getOrThrow<string>(
          'REFRESH_EXPIRES_IN',
        ) as ExpiresIn,
      },
    );

    const decoded = this.jwt.decode(refreshToken) as { exp: number };
    await this.deleteExpiredRefreshTokens(user.id, db);
    await db.refreshToken.create({
      data: {
        userId: user.id,
        jti,
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
   * Take the account's row lock. Rotating a refresh token, changing the
   * password and signing out all hold it while they touch the account's
   * refresh tokens, so they run one after another: a rotation cannot insert a
   * new token after a revocation has swept the old ones.
   */
  async lockAccount(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM wawu_users WHERE id = ${userId}::uuid FOR UPDATE`;
  }

  /**
   * Housekeeping: delete the account's expired refresh-token records, at most
   * EXPIRED_SWEEP_BATCH of them. Nothing else removes an expired row (a token
   * nobody presents again leaves one behind), and the old scan paid argon2 for
   * each. Runs on every issue and every sign-out, so the rows of an account
   * that is in use never pile up. Best effort: it never fails the sign-in or
   * sign-out it rides on, and inside a transaction a failure here fails the
   * statement after it anyway.
   */
  private async deleteExpiredRefreshTokens(
    userId: string,
    db: Prisma.TransactionClient | PrismaService,
  ): Promise<void> {
    try {
      const now = Date.now();
      const stale = await db.refreshToken.findMany({
        where: { userId, expiresAt: { lte: new Date(now) } },
        select: { id: true, expiresAt: true },
        take: EXPIRED_SWEEP_BATCH,
      });
      for (const row of stale) {
        // The query already says so; the check keeps a live token safe from
        // a mistake in it.
        if (row.expiresAt.getTime() > now) continue;
        await db.refreshToken.deleteMany({ where: { id: row.id } });
      }
    } catch (err) {
      this.logger.warn(
        `Could not prune expired refresh tokens: ${String(err)}`,
      );
    }
  }

  /**
   * The stored record of a presented refresh token, or undefined.
   *
   * A token minted by this code carries a jti that its row also carries: the
   * one row is looked up by (account, jti) and its hash is verified once. A
   * row that is missing (rotated, signed out, swept, never existed) or whose
   * hash does not verify refuses the token, the same answer as an unknown one.
   *
   * A token minted before the jti was stored has a row with a null jti; its
   * payload may or may not name a jti, but no row holds it. When no row holds
   * the token's jti, the old scan runs over the account's null-jti rows that
   * have not expired, until those tokens expire (30 days at most). No row that
   * carries a jti is ever hash-checked on that path.
   */
  private async findRefreshRecord(
    userId: string,
    jti: unknown,
    presented: string,
  ): Promise<RefreshToken | undefined> {
    if (typeof jti === 'string' && jti.length > 0) {
      const rows = await this.prisma.refreshToken.findMany({
        where: { userId, jti },
        take: 1,
      });
      // Belt and braces: the row must be this account's and carry this jti.
      const row = rows.find((r) => r.userId === userId && r.jti === jti);
      if (row) {
        return (await argon2.verify(row.tokenHash, presented))
          ? row
          : undefined;
      }
    }

    const now = Date.now();
    const legacy = await this.prisma.refreshToken.findMany({
      where: { userId, jti: null, expiresAt: { gt: new Date(now) } },
    });
    for (const record of legacy) {
      if (record.jti != null || record.expiresAt.getTime() <= now) continue;
      if (await argon2.verify(record.tokenHash, presented)) return record;
    }
    return undefined;
  }

  /**
   * Sign out one device: delete the stored record of the presented refresh
   * token. An expired token is still taken out (it was signed by this service
   * and is only being cleaned up); a forged, wrong-type or unknown one does
   * nothing. Never throws for a bad token and never says which case it was.
   */
  async revokeRefreshToken(presented: string): Promise<void> {
    let payload: { sub?: unknown; type?: unknown; jti?: unknown };
    try {
      payload = await this.jwt.verifyAsync(presented, {
        algorithms: ['RS256'],
        ignoreExpiration: true,
      });
    } catch {
      return;
    }
    if (payload.type !== 'refresh' || typeof payload.sub !== 'string') return;
    const userId = payload.sub;

    // Expired rows go first: an expired token presented here is cleaned up by
    // the sweep (the lookup below ignores expired old-style rows).
    await this.deleteExpiredRefreshTokens(userId, this.prisma);

    const record = await this.findRefreshRecord(
      userId,
      payload.jti,
      presented,
    ).catch(() => undefined);
    if (!record) return;
    await this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, userId);
      await tx.refreshToken.deleteMany({ where: { id: record.id } });
    });
  }

  /**
   * Validate a presented refresh token, delete the stored record (single-use
   * rotation), and issue a new pair from the user's current state.
   */
  async rotateRefreshToken(presented: string): Promise<TokenPair> {
    let payload: { sub: string; type?: string; jti?: unknown };
    try {
      payload = await this.jwt.verifyAsync(presented, { algorithms: ['RS256'] });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const matched = await this.findRefreshRecord(
      payload.sub,
      payload.jti,
      presented,
    );
    if (!matched) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Single-use, and exclusive with a revocation: under the account's lock
    // the token must still exist, is removed, and its replacement is stored
    // before the lock is let go. A password change or sign-out that ran first
    // has already deleted it, so the rotation is refused; one that runs after
    // finds the replacement and sweeps it too.
    const userId = payload.sub;
    const known = await this.prisma.wawuUser.findUnique({
      where: { id: userId },
    });
    if (!known) throw new UnauthorizedException('Invalid refresh token');
    await this.refuseIfPhonePending(known, this.prisma);
    const outcome = await this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, userId);
      const removed = await tx.refreshToken.deleteMany({
        where: { id: matched.id },
      });
      if (removed.count !== 1) return 'refused' as const;
      if (matched.expiresAt.getTime() <= Date.now()) return 'expired' as const;
      const user = await tx.wawuUser.findUnique({ where: { id: userId } });
      if (!user) return 'refused' as const;
      return this.issueTokens(user, tx);
    });
    if (typeof outcome === 'string') {
      throw new UnauthorizedException('Invalid refresh token');
    }
    return outcome;
  }
}
