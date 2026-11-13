import { createServer, IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HttpExceptionFilter } from '../common/http-exception.filter';
import { mailRelayDailyCap } from './mail-relay.config';
import { MailModule } from './mail.module';

/**
 * EMAIL-02: POST /internal/mail/send against a local stand-in for Resend's
 * POST /emails (never Resend itself). The real controller, guard, relay and
 * mailer run; only the far end is local.
 */
const SERVICE_KEY = 'email02-spec-service-key-not-a-real-secret';
const MAIL_FROM = 'WAWU Test Sender <sender@mail.test.invalid>';
const BODY = {
  to: 'person@email02.test.invalid',
  subject: 'A test subject',
  html: '<p>Hello</p>',
  text: 'Hello',
  headers: {
    'List-Unsubscribe': '<https://hub.test.invalid/u/abc>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  },
  tag: 'campaign-1',
};

interface Seen {
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

describe('POST /internal/mail/send', () => {
  let standIn: Server;
  let seen: Seen[] = [];
  /** Answers for the next requests, one each, then a success. */
  let script: Array<{ status: number; name?: string }> = [];
  const apps: INestApplication[] = [];
  const envBefore: Record<string, string | undefined> = {};
  const ENV = [
    'INTERNAL_SERVICE_KEY',
    'RESEND_API_KEY',
    'RESEND_BASE_URL',
    'MAIL_FROM',
    'MAIL_RELAY_DAILY_CAP',
    'VOICES_MAIL_FROM',
  ];

  async function makeApp(): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        MailModule,
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: false,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    apps.push(app);
    return app;
  }
  const post = (
    app: INestApplication,
    body: unknown = BODY,
    key: string | null = SERVICE_KEY,
  ) => {
    const r = request(
      app.getHttpServer() as Parameters<typeof request>[0],
    ).post('/internal/mail/send');
    return (key === null ? r : r.set('X-Service-Key', key)).send(
      body as object,
    );
  };

  beforeAll(async () => {
    for (const k of ENV) envBefore[k] = process.env[k];
    standIn = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const next = script.shift();
        if (next) {
          res.writeHead(next.status, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              statusCode: next.status,
              name: next.name ?? 'application_error',
              message: 'Stand-in refusal.',
            }),
          );
          return;
        }
        seen.push({
          headers: req.headers,
          body: JSON.parse(raw) as Record<string, unknown>,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `stand-in-${seen.length}` }));
      });
    });
    await new Promise<void>((r) => standIn.listen(0, '127.0.0.1', r));
    process.env.RESEND_BASE_URL = `http://127.0.0.1:${(standIn.address() as AddressInfo).port}`;
    process.env.INTERNAL_SERVICE_KEY = SERVICE_KEY;
    process.env.MAIL_FROM = MAIL_FROM;
    process.env.RESEND_API_KEY = 're_test_local_stand_in';
    delete process.env.MAIL_RELAY_DAILY_CAP;
    delete process.env.VOICES_MAIL_FROM;
  });

  beforeEach(() => {
    seen = [];
    script = [];
  });

  afterAll(async () => {
    for (const a of apps) await a.close();
    await new Promise((r) => standIn.close(r));
    for (const k of ENV) {
      if (envBefore[k] === undefined) delete process.env[k];
      else process.env[k] = envBefore[k];
    }
  });

  describe('the service-key guard', () => {
    it('refuses a call with no key, a wrong key or a key of the wrong length', async () => {
      const app = await makeApp();
      await post(app, BODY, null).expect(401);
      await post(app, BODY, 'wrong').expect(401);
      await post(app, BODY, `${SERVICE_KEY}x`).expect(401);
      expect(seen).toHaveLength(0);
    });

    it('refuses before it looks at the body', async () => {
      const app = await makeApp();
      const res = await post(app, { nonsense: true }, null).expect(401);
      expect(JSON.stringify(res.body)).not.toMatch(/subject|html|must be/i);
    });

    it('refuses everyone while the server has no key set', async () => {
      delete process.env.INTERNAL_SERVICE_KEY;
      try {
        const app = await makeApp();
        await post(app, BODY, '').expect(401);
        await post(app, BODY, SERVICE_KEY).expect(401);
      } finally {
        process.env.INTERNAL_SERVICE_KEY = SERVICE_KEY;
      }
      expect(seen).toHaveLength(0);
    });
  });

  describe('a send', () => {
    it('answers { id } and passes the mail on with the unsubscribe headers and the tag', async () => {
      const app = await makeApp();
      const res = await post(app)
        .set('Idempotency-Key', 'wawu-email-r1')
        .expect(200);
      expect(res.body).toEqual({ id: 'stand-in-1' });
      expect(seen).toHaveLength(1);
      const sent = seen[0];
      expect(sent.headers.authorization).toBe('Bearer re_test_local_stand_in');
      expect(sent.headers['idempotency-key']).toBe('wawu-email-r1');
      expect(sent.body).toMatchObject({
        to: BODY.to,
        subject: BODY.subject,
        html: BODY.html,
        text: BODY.text,
        headers: BODY.headers,
        tags: [{ name: 'campaign', value: 'campaign-1' }],
      });
    });

    it('always sends from MAIL_FROM, whatever the caller puts in the body', async () => {
      const app = await makeApp();
      await post(app, {
        ...BODY,
        from: 'Someone Else <ceo@evil.test.invalid>',
      }).expect(200);
      expect(seen[0].body.from).toBe(MAIL_FROM);
    });

    it('accepts the two headers in any letter case and leaves headers out when none are given', async () => {
      const app = await makeApp();
      await post(app, {
        ...BODY,
        headers: { 'list-unsubscribe': '<https://hub.test.invalid/u/x>' },
      }).expect(200);
      expect(seen[0].body.headers).toEqual({
        'List-Unsubscribe': '<https://hub.test.invalid/u/x>',
      });
      const { headers: _h, tag: _t, ...bare } = BODY;
      void _h;
      void _t;
      await post(app, bare).expect(200);
      expect(seen[1].body.headers).toBeUndefined();
      expect(seen[1].body.tags).toBeUndefined();
    });
  });

  describe('the header allowlist', () => {
    it.each([
      ['From', 'Boss <boss@evil.test.invalid>'],
      ['Reply-To', 'x@evil.test.invalid'],
      ['Bcc', 'x@evil.test.invalid'],
      ['X-Anything', 'yes'],
    ])('refuses %s with a 400 and sends nothing', async (name, value) => {
      const app = await makeApp();
      await post(app, {
        ...BODY,
        headers: { ...BODY.headers, [name]: value },
      }).expect(400);
      expect(seen).toHaveLength(0);
    });

    it('refuses an allowed header whose value is a line break away from a second header', async () => {
      const app = await makeApp();
      await post(app, {
        ...BODY,
        headers: {
          'List-Unsubscribe':
            '<https://hub.test.invalid/u>\r\nBcc: x@evil.test.invalid',
        },
      }).expect(400);
      await post(app, {
        ...BODY,
        subject: 'Hi\r\nBcc: x@evil.test.invalid',
      }).expect(400);
      expect(seen).toHaveLength(0);
    });
  });

  describe('failures', () => {
    it('answers 400 for an address that is not one, without calling the provider', async () => {
      const app = await makeApp();
      await post(app, { ...BODY, to: 'not-an-address' }).expect(400);
      expect(seen).toHaveLength(0);
    });

    it.each([
      [429, 'rate_limit_exceeded', 503],
      [500, 'internal_server_error', 503],
      [503, 'application_error', 503],
      [422, 'validation_error', 400],
      [400, 'invalid_parameter', 400],
      [401, 'invalid_api_key', 502],
      [403, 'invalid_access', 502],
    ])('maps a provider %s (%s) to %s', async (status, name, expected) => {
      const app = await makeApp();
      script = [{ status, name }];
      const res = await post(app).expect(expected);
      expect(JSON.stringify(res.body)).not.toContain('re_test_local_stand_in');
      expect(JSON.stringify(res.body)).not.toContain('—');
    });

    it('answers 503 when the provider cannot be reached', async () => {
      const app = await makeApp();
      const keep = process.env.RESEND_BASE_URL;
      await new Promise((r) => standIn.close(r));
      try {
        await post(app).expect(503);
      } finally {
        await new Promise<void>((r) =>
          standIn.listen(Number(new URL(keep!).port), '127.0.0.1', r),
        );
      }
    });

    it('answers 503 with a plain message when no Resend key is set here', async () => {
      delete process.env.RESEND_API_KEY;
      try {
        const app = await makeApp();
        const res = await post(app).expect(503);
        expect((res.body as { message: string }).message).toBe(
          'WAWU ID has no email key set (RESEND_API_KEY), so no email can be sent.',
        );
      } finally {
        process.env.RESEND_API_KEY = 're_test_local_stand_in';
      }
      expect(seen).toHaveLength(0);
    });
  });

  describe('the daily cap', () => {
    it('answers 429 once the cap is reached, and a mail that failed gives its place back', async () => {
      process.env.MAIL_RELAY_DAILY_CAP = '2';
      try {
        const app = await makeApp();
        await post(app).expect(200);
        script = [{ status: 500 }];
        await post(app).expect(503);
        await post(app).expect(200);
        const res = await post(app).expect(429);
        expect((res.body as { message: string }).message).toBe(
          'The daily email limit has been reached. Try again tomorrow.',
        );
        expect(seen).toHaveLength(2);
      } finally {
        delete process.env.MAIL_RELAY_DAILY_CAP;
      }
    });

    it('defaults to 5000 when the setting is missing or not a whole number', () => {
      const get = (v: string | undefined) => ({ get: () => v }) as never;
      expect(mailRelayDailyCap(get(undefined))).toBe(5000);
      expect(mailRelayDailyCap(get('lots'))).toBe(5000);
      expect(mailRelayDailyCap(get('-3'))).toBe(5000);
      expect(mailRelayDailyCap(get('120'))).toBe(120);
    });
  });

  describe('the app field (EMAIL-RELAY)', () => {
    const VOICES_FROM = 'Voices <hello@voices.test.invalid>';

    it('sends app voices from VOICES_MAIL_FROM', async () => {
      process.env.VOICES_MAIL_FROM = VOICES_FROM;
      try {
        const app = await makeApp();
        await post(app, { ...BODY, app: 'voices' }).expect(200);
        expect(seen[0].body.from).toBe(VOICES_FROM);
      } finally {
        delete process.env.VOICES_MAIL_FROM;
      }
    });

    it('falls back to MAIL_FROM for app voices while VOICES_MAIL_FROM is unset', async () => {
      const app = await makeApp();
      await post(app, { ...BODY, app: 'voices' }).expect(200);
      expect(seen[0].body.from).toBe(MAIL_FROM);
    });

    it('with no app sends from MAIL_FROM even when VOICES_MAIL_FROM is set', async () => {
      process.env.VOICES_MAIL_FROM = VOICES_FROM;
      try {
        const app = await makeApp();
        await post(app).expect(200);
        expect(seen[0].body.from).toBe(MAIL_FROM);
      } finally {
        delete process.env.VOICES_MAIL_FROM;
      }
    });

    it.each(['wmt', 'nope', '', 7, null])(
      'refuses an unknown app (%p) with a 400 and sends nothing',
      async (value) => {
        const app = await makeApp();
        await post(app, { ...BODY, app: value }).expect(400);
        expect(seen).toHaveLength(0);
      },
    );
  });

  describe('429 codes (EMAIL-RELAY)', () => {
    it('answers the provider daily quota as 429 with code provider_daily_quota', async () => {
      const app = await makeApp();
      script = [{ status: 429, name: 'daily_quota_exceeded' }];
      const res = await post(app).expect(429);
      expect(res.body).toEqual({
        statusCode: 429,
        code: 'provider_daily_quota',
        message:
          'The email provider has reached its daily limit. Try again tomorrow.',
      });
    });

    it('answers the provider monthly quota as 429 with code provider_monthly_quota', async () => {
      const app = await makeApp();
      script = [{ status: 429, name: 'monthly_quota_exceeded' }];
      const res = await post(app).expect(429);
      expect(res.body).toEqual({
        statusCode: 429,
        code: 'provider_monthly_quota',
        message: 'The email provider has reached its monthly limit.',
      });
    });

    it('answers its own cap as 429 with code daily_cap', async () => {
      process.env.MAIL_RELAY_DAILY_CAP = '1';
      try {
        const app = await makeApp();
        await post(app).expect(200);
        const res = await post(app).expect(429);
        expect(res.body).toEqual({
          statusCode: 429,
          code: 'daily_cap',
          message:
            'The daily email limit has been reached. Try again tomorrow.',
        });
      } finally {
        delete process.env.MAIL_RELAY_DAILY_CAP;
      }
    });

    it('keeps rate_limit_exceeded as a 503 with no 429 code', async () => {
      const app = await makeApp();
      script = [{ status: 429, name: 'rate_limit_exceeded' }];
      const res = await post(app).expect(503);
      expect((res.body as { code?: string }).code).toBeUndefined();
    });

    it('gives the cap place back when the provider refuses on a quota', async () => {
      process.env.MAIL_RELAY_DAILY_CAP = '1';
      try {
        const app = await makeApp();
        script = [
          { status: 429, name: 'daily_quota_exceeded' },
          { status: 429, name: 'monthly_quota_exceeded' },
        ];
        // Had the places not come back, the second call would be daily_cap.
        const a = await post(app).expect(429);
        const b = await post(app).expect(429);
        expect((a.body as { code: string }).code).toBe('provider_daily_quota');
        expect((b.body as { code: string }).code).toBe(
          'provider_monthly_quota',
        );
        await post(app).expect(200);
      } finally {
        delete process.env.MAIL_RELAY_DAILY_CAP;
      }
    });

    it('carries no dash characters in the 429 words', async () => {
      const app = await makeApp();
      script = [{ status: 429, name: 'daily_quota_exceeded' }];
      const res = await post(app).expect(429);
      expect(JSON.stringify(res.body)).not.toMatch(/[\u2013\u2014]/);
    });
  });
});
