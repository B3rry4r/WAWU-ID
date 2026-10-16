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
    if (
      !serviceKeyMatches(
        req.headers['x-service-key'],
        this.config.get<string>('INTERNAL_SERVICE_KEY'),
      )
    ) {
      throw new UnauthorizedException('Invalid service key');
    }
    return true;
  }
}

/**
 * True when the X-Service-Key header is the configured key. A missing or
 * repeated header, and an unset key, never match. One rule for the guard and
 * for the body parser that must know the caller before it reads a big body
 * (mail-relay-body.ts).
 */
export function serviceKeyMatches(
  header: unknown,
  expectedKey: string | undefined,
): boolean {
  const provided = typeof header === 'string' ? header : '';
  const expected = expectedKey ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return Boolean(expected) && a.length === b.length && timingSafeEqual(a, b);
}
