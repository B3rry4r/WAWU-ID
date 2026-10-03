import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { WawuUser } from '@prisma/client';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';

const SIGN_IN_AGAIN = () =>
  new UnauthorizedException({
    statusCode: 401,
    code: 'SESSION_INVALID',
    message: 'Sign in again.',
  });

/**
 * The account behind `Authorization: Bearer <access token>`, for the few
 * wawu-id routes a signed-in person calls (the sign-up sequence, AUTH-05).
 *
 * The token is checked exactly as a resource server checks it: an RS256
 * signature by this service's key, not expired, and the configured issuer
 * when there is one. A refresh token is signed by the same key, so it is
 * refused by its `type`: only an access token opens these routes. The account
 * must still exist and be active (not suspended, banned or being deleted).
 */
@Injectable()
export class SessionReader {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async accountFor(req: Request): Promise<WawuUser> {
    const header = req.headers.authorization;
    const match =
      typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    if (!match) throw SIGN_IN_AGAIN();

    const issuer = this.config.get<string>('JWT_ISSUER');
    let payload: { sub?: unknown; type?: unknown };
    try {
      payload = await this.jwt.verifyAsync(match[1], {
        algorithms: ['RS256'],
        ...(issuer ? { issuer } : {}),
      });
    } catch {
      throw SIGN_IN_AGAIN();
    }
    if (payload.type !== undefined || typeof payload.sub !== 'string') {
      throw SIGN_IN_AGAIN();
    }

    const user = await this.prisma.wawuUser
      .findUnique({ where: { id: payload.sub } })
      .catch(() => null);
    if (!user || user.deletedAt || user.status !== 'active') {
      throw SIGN_IN_AGAIN();
    }
    return user;
  }
}
