import { json, urlencoded } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { MAIL_RELAY_BODY_LIMIT } from './mail-relay.config';
import { serviceKeyMatches } from './service-key.guard';

/**
 * Body parsers for the whole app (WALLET-35). Express's own 100 kb limit stays
 * on every route except POST /internal/mail/send, which may carry a file (a
 * wallet statement's CSV in base64) and so takes MAIL_RELAY_BODY_LIMIT.
 *
 * The big limit is for a caller that has shown the service key, and only for
 * that caller: the key is checked BEFORE the big parser is chosen, so a caller
 * without it is held to the 100 kb everyone else gets and never makes the
 * server buffer 17 MB (round 2: eight unauthenticated 16 MiB bodies at once
 * took the process from 209 MB to 474 MB before the guard could say 401). The
 * guard still refuses a wrong key afterwards, as it always did.
 *
 * The relay's parser comes first: a body already read is not read again, so
 * the general parser below never sees the relay's body. Call this on an app
 * made with `bodyParser: false`.
 */
export function useBodyParsers(app: NestExpressApplication): void {
  const config = app.get(ConfigService, { strict: false });
  const relayJson = json({ limit: MAIL_RELAY_BODY_LIMIT });
  app.use(
    '/internal/mail/send',
    (req: Request, res: Response, next: NextFunction) => {
      if (
        serviceKeyMatches(
          req.headers['x-service-key'],
          config.get<string>('INTERNAL_SERVICE_KEY'),
        )
      ) {
        relayJson(req, res, next);
      } else {
        next();
      }
    },
  );
  app.use(json());
  app.use(urlencoded({ extended: true }));
}
