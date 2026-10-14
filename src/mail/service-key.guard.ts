import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';

/**
 * The internal service-key check (X-Service-Key against INTERNAL_SERVICE_KEY),
 * the same rule InternalController applies inline, as a guard so it runs
 * before the body is validated: a caller without the key learns nothing about
 * the shape of the body. An unset key refuses everyone.
 */
@Injectable()
export class ServiceKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers['x-service-key'];
    const provided = typeof header === 'string' ? header : '';
    const expected = this.config.get<string>('INTERNAL_SERVICE_KEY') ?? '';
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid service key');
    }
    return true;
  }
}
