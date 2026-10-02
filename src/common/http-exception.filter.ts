import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * Formats every error as the contract's error envelope: { statusCode, message },
 * carrying an optional machine-readable `code`, an optional
 * `retryAfterSeconds` (also sent as a Retry-After header) when the caller must
 * wait, and honouring a body-provided statusCode (lets a handler signal e.g.
 * 404 from inside an HttpException body).
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let code: string | undefined;
    let retryAfterSeconds: number | undefined;

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (typeof body === 'object' && body !== null) {
        const b = body as {
          statusCode?: number;
          message?: string | string[];
          code?: string;
          retryAfterSeconds?: number;
        };
        if (typeof b.statusCode === 'number') {
          statusCode = b.statusCode;
        }
        message = Array.isArray(b.message)
          ? b.message.join(', ')
          : (b.message ?? exception.message);
        if (typeof b.code === 'string') {
          code = b.code;
        }
        if (
          typeof b.retryAfterSeconds === 'number' &&
          Number.isFinite(b.retryAfterSeconds)
        ) {
          retryAfterSeconds = b.retryAfterSeconds;
        }
      }
    } else {
      this.logger.error(exception);
    }

    if (retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(retryAfterSeconds));
    }

    response.status(statusCode).json({
      statusCode,
      ...(code ? { code } : {}),
      message,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    });
  }
}
