import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { AuthService } from './auth.service';
import { UpdateTrustScoreDto } from './dto/update-trust-score.dto';
import { UpdateVerificationTierDto } from './dto/update-verification-tier.dto';

/**
 * Service-to-service endpoints. Guarded by the shared X-Service-Key header
 * (same mechanism as ProvisioningController) — there is NO user auth here, so
 * the key check is mandatory on every route.
 */
@Controller('internal')
export class InternalController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  /**
   * PATCH /internal/users/:userId/verification-tier
   * Body: { tier } or { verificationTier } ∈
   *   { certified_professional, trusted_partner, official }.
   * Used by WAWUAfrica-API admin partner provisioning. Never downgrades.
   */
  @Patch('users/:userId/verification-tier')
  @HttpCode(HttpStatus.OK)
  async updateVerificationTier(
    @Param('userId') userId: string,
    @Body() dto: UpdateVerificationTierDto,
    @Headers('x-service-key') serviceKey?: string,
  ) {
    this.assertServiceKey(serviceKey);
    const tier = dto.tier ?? dto.verificationTier;
    if (!tier) {
      throw new BadRequestException(
        'Provide a verification tier as `tier` or `verificationTier`.',
      );
    }
    return { data: await this.auth.updateVerificationTier(userId, tier) };
  }

  /**
   * PATCH /internal/users/:userId/trust-score
   * Body: { trustScore } or { score } — integer in [0, 100].
   * Called by the Hub to keep a user's authoritative trust score in sync. Same
   * X-Service-Key guard as the verification-tier setter.
   */
  @Patch('users/:userId/trust-score')
  @HttpCode(HttpStatus.OK)
  async updateTrustScore(
    @Param('userId') userId: string,
    @Body() dto: UpdateTrustScoreDto,
    @Headers('x-service-key') serviceKey?: string,
  ) {
    this.assertServiceKey(serviceKey);
    const trustScore = dto.trustScore ?? dto.score;
    if (trustScore === undefined) {
      throw new BadRequestException(
        'Provide a trust score as `trustScore` or `score`.',
      );
    }
    return { data: await this.auth.updateTrustScore(userId, trustScore) };
  }

  /**
   * DELETE /internal/users/:userId
   * Query: ?mode=hard (default) | anonymize
   * Same X-Service-Key guard as the tier setter. Hard-deletes the user (related
   * tokens cascade) or anonymizes the row (scrub PII + ban + revoke sessions).
   * Used by WAWUAfrica-API ops tooling to purge residual/test accounts.
   */
  @Delete('users/:userId')
  @HttpCode(HttpStatus.OK)
  async deleteUser(
    @Param('userId') userId: string,
    @Query('mode') mode?: string,
    @Headers('x-service-key') serviceKey?: string,
  ) {
    this.assertServiceKey(serviceKey);
    if (mode && mode !== 'hard' && mode !== 'anonymize') {
      throw new BadRequestException("mode must be 'hard' or 'anonymize'");
    }
    return {
      data: await this.auth.deleteUser(
        userId,
        (mode as 'hard' | 'anonymize') ?? 'hard',
      ),
    };
  }

  private assertServiceKey(provided?: string): void {
    const expected = this.config.get<string>('INTERNAL_SERVICE_KEY') ?? '';
    if (!expected || !this.safeEqual(provided ?? '', expected)) {
      throw new UnauthorizedException('Invalid service key');
    }
  }

  private safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) {
      return false;
    }
    return timingSafeEqual(ab, bb);
  }
}
