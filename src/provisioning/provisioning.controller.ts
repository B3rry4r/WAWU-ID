import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { SafProvisionDto } from './dto/saf-provision.dto';
import { ProvisioningService } from './provisioning.service';

@Controller('admin')
export class ProvisioningController {
  constructor(
    private readonly provisioning: ProvisioningService,
    private readonly config: ConfigService,
  ) {}

  /**
   * POST /admin/provision — fire the one-time import in the background and
   * return immediately. Guarded by the X-Service-Key header (no user auth).
   */
  @Post('provision')
  @HttpCode(200)
  provision(@Headers('x-service-key') serviceKey?: string) {
    this.assertServiceKey(serviceKey);
    this.provisioning.start();
    return { message: 'Provisioning job started', status: 'running' };
  }

  /**
   * POST /admin/provision/saf — synchronously provision a single SAF user and
   * return the new WAWU-ID plus the one-time activation token (empty string when
   * no email was supplied). Guarded by the X-Service-Key header.
   */
  @Post('provision/saf')
  @HttpCode(201)
  async provisionSaf(
    @Headers('x-service-key') serviceKey: string,
    @Body() dto: SafProvisionDto,
  ) {
    this.assertServiceKey(serviceKey);
    return this.provisioning.provisionSafUser(dto);
  }

  /**
   * POST /admin/provision/saf/delete — remove a provisioned user by email or
   * phone. Service-key guarded. For test-data cleanup and admin removal.
   */
  @Post('provision/saf/delete')
  @HttpCode(200)
  async deleteSaf(
    @Headers('x-service-key') serviceKey: string,
    @Body() dto: { email?: string; phone?: string },
  ) {
    this.assertServiceKey(serviceKey);
    return this.provisioning.deleteSafUser(dto);
  }

  /** GET /admin/provision/status — last (or in-flight) job result. */
  @Get('provision/status')
  status(@Headers('x-service-key') serviceKey?: string) {
    this.assertServiceKey(serviceKey);
    return this.provisioning.getStatus();
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
