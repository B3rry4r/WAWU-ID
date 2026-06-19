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
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { AuthService } from './auth.service';
import { UpdatePhoneDto } from './dto/update-phone.dto';
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
   * PATCH /internal/users/:userId/phone
   * Body: { phone } — digits, length >= 7. Corrects a user's phone number on
   * request from the Hub (caller resolves the user's own id; never trusts a
   * body-supplied id). Rejects a number already held by another account (409).
   * Same X-Service-Key guard as the verification-tier setter.
   *
   * NOTE: no OTP verification in v1 (WhatsApp/SMS OTP delivery not configured);
   * verifying ownership of the new number is a future enhancement.
   */
  @Patch('users/:userId/phone')
  @HttpCode(HttpStatus.OK)
  async updatePhone(
    @Param('userId') userId: string,
    @Body() dto: UpdatePhoneDto,
    @Headers('x-service-key') serviceKey?: string,
  ) {
    this.assertServiceKey(serviceKey);
    return { data: await this.auth.updatePhone(userId, dto.phone) };
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

  /**
   * POST /internal/users/:userId/mark-deletion
   * Starts the cross-ecosystem account-deletion grace period: marks the account
   * `pending_deletion`, stamps `deletedAt`, and revokes all sessions + reset
   * tokens. Same X-Service-Key guard as the other internal routes. Idempotent.
   * The hub finalizes ~48h later via DELETE /internal/users/:userId?mode=anonymize.
   */
  @Post('users/:userId/mark-deletion')
  @HttpCode(HttpStatus.OK)
  async markDeletion(
    @Param('userId') userId: string,
    @Headers('x-service-key') serviceKey?: string,
  ) {
    this.assertServiceKey(serviceKey);
    return { data: await this.auth.markPendingDeletion(userId) };
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
