import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { PoliciesService } from './policies.service';
import { PublishPolicyDto } from './dto/publish-policy.dto';

@Controller('policies')
export class PoliciesController {
  constructor(
    private readonly policies: PoliciesService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /** GET /policies — current published version of every policy. Public. */
  @Get()
  async list() {
    return { data: await this.policies.listCurrent() };
  }

  /** GET /policies/:slug — current published version of one policy. Public. */
  @Get(':slug')
  async getOne(@Param('slug') slug: string) {
    return { data: await this.policies.getCurrent(slug) };
  }

  /**
   * GET /policies/:slug/status — does the authenticated user's latest acceptance
   * match the current version? Bearer access token required.
   */
  @Get(':slug/status')
  async status(@Param('slug') slug: string, @Headers('authorization') auth?: string) {
    const userId = await this.userIdFromAuth(auth);
    return { data: await this.policies.consentStatus(userId, slug) };
  }

  /**
   * POST /policies/:slug/accept — record the authenticated user's acceptance of
   * the current version. Bearer access token required. Body: { source? }.
   */
  @Post(':slug/accept')
  @HttpCode(200)
  async accept(
    @Param('slug') slug: string,
    @Body() body: { source?: string },
    @Req() req: Request,
    @Headers('authorization') auth?: string,
  ) {
    const userId = await this.userIdFromAuth(auth);
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip;
    return { data: await this.policies.recordConsent(userId, slug, body?.source, ip) };
  }

  /**
   * POST /policies — publish a new policy version. Service-key guarded (admin).
   * This is how an updated policy is rolled out to every app at once.
   */
  @Post()
  @HttpCode(201)
  async publish(
    @Headers('x-service-key') serviceKey: string,
    @Body() dto: PublishPolicyDto,
  ) {
    this.assertServiceKey(serviceKey);
    return { data: await this.policies.publish(dto) };
  }

  private async userIdFromAuth(authHeader?: string): Promise<string> {
    const token = (authHeader ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      throw new UnauthorizedException('Missing access token');
    }
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token, {
        algorithms: ['RS256'],
      });
      return payload.sub;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
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
