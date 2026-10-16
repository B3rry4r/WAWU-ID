import { json, urlencoded } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { MAIL_RELAY_BODY_LIMIT } from './mail-relay.config';

/**
 * Body parsers for the whole app (WALLET-35). Express's own 100 kb limit stays
 * on every route except POST /internal/mail/send, which may carry a file (a
 * wallet statement's CSV in base64) and so takes MAIL_RELAY_BODY_LIMIT. The
 * relay's parser comes first: a body already read is not read again, so the
 * general parser below never sees the relay's body. Call this on an app made
 * with `bodyParser: false`.
 */
export function useBodyParsers(app: NestExpressApplication): void {
  app.use('/internal/mail/send', json({ limit: MAIL_RELAY_BODY_LIMIT }));
  app.use(json());
  app.use(urlencoded({ extended: true }));
}
