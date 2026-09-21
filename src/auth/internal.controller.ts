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
import { ConfirmPhoneChangeDto } from './dto/confirm-phone-change.dto';
import { UpdateGenderDto } from './dto/update-gender.dto';
import { UpdateNameDto } from './dto/update-name.dto';
import { RequestPhoneChangeDto } from './dto/request-phone-change.dto';
import { UpdatePhoneDto } from './dto/update-phone.dto';
import { UpdateTrustScoreDto } from './dto/update-trust-score.dto';
import { UpdateVerificationTierDto } from './dto/update-verification-tier.dto';
import { UpdateVerificationDto } from './dto/update-verification.dto';
import { LookupUsersDto } from './dto/lookup-users.dto';
import { DittoInviteDto } from './dto/ditto-invite.dto';
import { UnpaidWarningDto } from './dto/unpaid-warning.dto';

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
   * POST /internal/users/lookup
   * Body: { ids: string[] } (max 100)
   *
   * Display name + verification tier for a set of users, so a sibling service
   * can render real people in a list instead of inventing them. POST rather
   * than GET because the id set is the request body, not a URL a proxy or
   * access log should be carrying.
   */
  @Post('users/lookup')
  @HttpCode(HttpStatus.OK)
  async lookupUsers(
    @Body() dto: LookupUsersDto,
    @Headers('x-service-key') serviceKey?: string,
  ) {
    this.assertServiceKey(serviceKey);
    return { data: await this.auth.lookupPublicIdentities(dto.ids) };
  }

  /**
   * PATCH /internal/users/:userId/verification
   * Body: { tick: 'creator' | 'professional', granted: boolean,
   *         expiresAt?: string | null }
   *
   * The Hub grants a tick when the annual fee clears, renews it with a new
   * `expiresAt`, and revokes it when an admin withdraws the badge. One call,
   * one tick: the purple (creator) and green (professional) verifications are
   * independent because one person can hold both roles.
   *
   * `expiresAt` null on a grant is a perpetual, admin-granted tick. There is
   * no `verified` field to send: whether a tick draws is derived from the
   * expiry on every read, server-side, so a caller cannot assert it.
   *
   * Returns the updated user, carrying `verification` (the two ticks) and the
   * legacy `verificationTier` field unchanged.
   */
  @Patch('users/:userId/verification')
  @HttpCode(HttpStatus.OK)
  async updateVerification(
    @Param('userId') userId: string,
    @Body() dto: UpdateVerificationDto,
    @Headers('x-service-key') serviceKey?: string,
  ) {
    this.assertServiceKey(serviceKey);
    return {
      data: await this.auth.setVerification(
        userId,
        dto.tick,
        dto.granted,
        dto.expiresAt ?? null,
      ),
    };
  }

  /**
   * PATCH /internal/users/:userId/verification-tier
   * Body: { tier } or { verificationTier } ∈
   *   { certified_professional, trusted_partner, official }.
   * Used by WAWUAfrica-API admin partner provisioning. Never downgrades.
   *
   * SUPERSEDED by PATCH /internal/users/:userId/verification above. Kept
   * routable so an older Hub build calling it mid-deploy gets a 200 rather
   * than a 404; it writes only the legacy `verification_tier` column, which
   * no read path consults. Same expand/contract reasoning as the migration
   * that left that column in place.
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
   *
   * SUPERSEDED: Trust Score is gone as a product surface, and nothing replaces
   * it. Two ticks are the whole verification story, via PATCH
   * /internal/users/:userId/verification. Kept routable for the same reason as
   * the verification-tier route: a 200 beats a 404 while both sides deploy.
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
   * PATCH /internal/users/:userId/gender
   * Body: { gender } — free string, normalized to 'male'|'female' (anything
   * unrecognised, or omitted, clears it to null). The hub proxies a user's own
   * profile gender edit here. Same X-Service-Key guard as the other routes.
   */
  /**
   * PATCH /internal/users/:userId/name
   * Body: { firstName, middleName?, lastName }
   *
   * The hub proxies a user's own name edit here — names are WAWU ID's, not
   * the hub's. Same X-Service-Key guard as the other internal routes.
   */
  @Patch('users/:userId/name')
  @HttpCode(HttpStatus.OK)
  async updateName(
    @Param('userId') userId: string,
    @Body() dto: UpdateNameDto,
    @Headers('x-service-key') serviceKey?: string,
  ) {
    this.assertServiceKey(serviceKey);
    return { data: await this.auth.updateName(userId, dto) };
  }

  @Patch('users/:userId/gender')
  @HttpCode(HttpStatus.OK)
  async updateGender(
    @Param('userId') userId: string,
    @Body() dto: UpdateGenderDto,
    @Headers('x-service-key') serviceKey?: string,
  ) {
    this.assertServiceKey(serviceKey);
    return { data: await this.auth.updateGender(userId, dto.gender ?? null) };
  }

  /**
   * POST /internal/users/:userId/phone/request
   * Body: { phone } — the new number. Step 1 of the verified phone-change flow:
   * validates + uniqueness-checks the number, then emails a 6-digit OTP to the
   * user's registered email (caller resolves the user's own id; never trusts a
   * body-supplied id). Returns { sent: true } — never the code. 409 if taken.
   * Same X-Service-Key guard as the other internal routes.
   */
  @Post('users/:userId/phone/request')
  @HttpCode(HttpStatus.OK)
  async requestPhoneChange(
    @Param('userId') userId: string,
    @Body() dto: RequestPhoneChangeDto,
    @Headers('x-service-key') serviceKey?: string,
  ) {
    this.assertServiceKey(serviceKey);
    return { data: await this.auth.requestPhoneChange(userId, dto.phone) };
  }

  /**
   * POST /internal/users/:userId/phone/confirm
   * Body: { code } — the 6-digit OTP from step 1. Verifies the code, re-checks
   * uniqueness, updates the user's phone, and returns the updated user. A
   * bad/expired code is rejected (401). Same X-Service-Key guard.
   */
  @Post('users/:userId/phone/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmPhoneChange(
    @Param('userId') userId: string,
    @Body() dto: ConfirmPhoneChangeDto,
    @Headers('x-service-key') serviceKey?: string,
  ) {
    this.assertServiceKey(serviceKey);
    return { data: await this.auth.confirmPhoneChange(userId, dto.code) };
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

  /**
   * POST /internal/users/:userId/ditto-invite
   * Body: { signupUrl, discountPercent }
   *
   * Sends the Ditto Music distribution email. Deliberately NOT a general mail
   * relay: the hub cannot choose the subject, the body, or the recipient — it
   * names a user and the link, and this service decides the rest. A generic
   * "send this HTML to this address" route behind a shared key is an open
   * relay the moment that key leaks.
   */
  @Post('users/:userId/ditto-invite')
  @HttpCode(HttpStatus.OK)
  async dittoInvite(
    @Headers('x-service-key') serviceKey: string,
    @Param('userId') userId: string,
    @Body() dto: DittoInviteDto,
  ) {
    this.assertServiceKey(serviceKey);
    return this.auth.sendDittoInvite(userId, dto.signupUrl, dto.discountPercent);
  }

  /**
   * POST /internal/users/:userId/unpaid-warning
   * Body: { hoursLeft, planUrl }
   *
   * The single warning email before the hub removes an unpaid creator
   * account. Same reasoning as ditto-invite: the hub names the user and the
   * deadline, this service decides the subject, the wording and the address.
   */
  @Post('users/:userId/unpaid-warning')
  @HttpCode(HttpStatus.OK)
  async unpaidWarning(
    @Headers('x-service-key') serviceKey: string,
    @Param('userId') userId: string,
    @Body() dto: UnpaidWarningDto,
  ) {
    this.assertServiceKey(serviceKey);
    return { data: await this.auth.sendUnpaidDeletionWarning(userId, dto.hoursLeft, dto.planUrl) };
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
