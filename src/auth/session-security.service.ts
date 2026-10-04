import { HttpException, Injectable } from '@nestjs/common';
import type { WawuUser } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { RateLimiter } from './rate-limiter.service';
import { TokenPair, TokensService } from './tokens.service';

/** Wrong current passwords one account may try in a window (SETTINGS-03). */
export const CHANGE_PASSWORD_MAX_TRIES = 5;
export const CHANGE_PASSWORD_WINDOW_SECONDS = 15 * 60;
/** Sign-out calls one address may make a minute. */
export const LOGOUT_PER_ADDRESS_PER_MINUTE = 30;

function problem(
  status: number,
  code: string,
  message: string,
  retryAfterSeconds?: number,
): HttpException {
  return new HttpException(
    {
      statusCode: status,
      code,
      message,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    },
    status,
  );
}

/** A hash to check against when the account has none, so the work is the same. */
let decoy: Promise<string> | undefined;
const decoyHash = () => (decoy ??= argon2.hash('no password set'));

/**
 * What Settings needs on top of sign-in (SETTINGS-03): change the password and
 * end every other session, and sign out for real. Neither route reads or
 * writes anything the web calls.
 */
@Injectable()
export class SessionSecurityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    private readonly limiter: RateLimiter,
  ) {}

  /**
   * Change the password of a signed-in account. The current password must be
   * right. Every refresh token and every pending reset link the account holds
   * dies in the same transaction as the new hash, then this device gets a
   * fresh pair: other devices cannot refresh, and are out when their access
   * token (15 minutes) runs out.
   */
  async changePassword(
    user: WawuUser,
    currentPassword: string,
    newPassword: string,
  ): Promise<TokenPair> {
    // Every try counts BEFORE it is checked, so parallel guesses cannot all
    // squeeze under the limit. A right password gives the tries back.
    const claim = await this.limiter.hit(
      'password-change',
      user.id,
      CHANGE_PASSWORD_MAX_TRIES,
      CHANGE_PASSWORD_WINDOW_SECONDS,
    );
    if (!claim.allowed) {
      throw problem(
        429,
        'RATE_LIMITED',
        'Too many tries. Try again later.',
        claim.retryAfterSeconds,
      );
    }

    const right = await argon2.verify(
      user.passwordHash ?? (await decoyHash()),
      currentPassword,
    );
    if (!user.passwordHash) {
      throw problem(
        409,
        'PASSWORD_NOT_SET',
        'This account has no password yet. Set one with a reset code.',
      );
    }
    if (!right) {
      throw problem(
        400,
        'CURRENT_PASSWORD_WRONG',
        'Your current password is not right.',
      );
    }
    await this.limiter.forget('password-change', user.id);

    if (currentPassword === newPassword) {
      throw problem(
        400,
        'PASSWORD_UNCHANGED',
        'Choose a password you are not using now.',
      );
    }

    const passwordHash = await argon2.hash(newPassword);
    const updated = await this.prisma.$transaction(async (tx) => {
      await this.tokens.lockAccount(tx, user.id);
      const row = await tx.wawuUser.update({
        where: { id: user.id },
        data: { passwordHash },
      });
      await tx.refreshToken.deleteMany({ where: { userId: user.id } });
      await tx.passwordResetToken.deleteMany({ where: { userId: user.id } });
      return row;
    });
    return this.tokens.issueTokens(updated);
  }

  /**
   * Sign out: the presented refresh token stops working. The answer is the
   * same for a live token, a dead one and garbage, so it tells nobody which
   * is which; a device that is already signed out is not shown an error.
   */
  async logout(refreshToken: string, address: string): Promise<void> {
    const claim = await this.limiter.hit(
      'logout-address',
      address,
      LOGOUT_PER_ADDRESS_PER_MINUTE,
      60,
    );
    if (!claim.allowed) {
      throw problem(
        429,
        'RATE_LIMITED',
        'Too many requests. Try again later.',
        claim.retryAfterSeconds,
      );
    }
    await this.tokens.revokeRefreshToken(refreshToken);
  }
}
