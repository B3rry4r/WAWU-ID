import {
  Controller,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { ProvisioningService } from './provisioning.service';

@Controller('admin')
export class ProvisioningController {
  constructor(
    private readonly provisioning: ProvisioningService,
    private readonly config: ConfigService,
  ) {}

  /**
   * POST /admin/provision — triggers the one-time provisioning import.
   * Guarded by the X-Service-Key header (no user auth).
   */
  @Post('provision')
  @HttpCode(200)
  async provision(@Headers('x-service-key') serviceKey?: string) {
    const expected = this.config.get<string>('INTERNAL_SERVICE_KEY') ?? '';
    if (!expected || !this.safeEqual(serviceKey ?? '', expected)) {
      throw new UnauthorizedException('Invalid service key');
    }

    return this.provisioning.runProvisioning();
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
