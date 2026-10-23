import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { HttpExceptionFilter } from '../common/http-exception.filter';
import { parseDataExportLink } from '../mail/data-export-link';
import { MailService } from '../mail/mail.service';
import { AuthService } from './auth.service';
import { InternalController } from './internal.controller';

/**
 * POST /internal/users/:userId/data-export (FIX-53, the Hub's SETTINGS-04,
 * BACKEND_GAPS G-131): the link to download a person's data, mailed to the
 * one account the Hub names. The mail goes out through the real MailService
 * to a local stand-in for Resend (the SDK reads RESEND_BASE_URL), so the mail
 * is seen as the transport receives it and nothing leaves this machine.
 */
describe('POST /internal/users/:userId/data-export', () => {
  const KEY = 'spec-service-key';
  const OWNER = '00000000-0000-4000-8000-00000000b001';
  const UNPROVEN = '00000000-0000-4000-8000-00000000b002';
  const NO_EMAIL = '00000000-0000-4000-8000-00000000b003';
  const LEGACY = '00000000-0000-4000-8000-00000000b004';

  type Account = {
    id: string;
    email: string | null;
    firstName: string | null;
    emailVerified: boolean;
    phoneVerifiedAt: Date | null;
  };
  const accounts: Account[] = [
    {
      id: OWNER,
      email: 'owner@example.test',
      firstName: 'Ada <b>',
      emailVerified: true,
      phoneVerifiedAt: new Date('2026-09-01T00:00:00Z'),
    },
    // Signed up on the phone, typed an email, never proved it.
    {
      id: UNPROVEN,
      email: 'typed@example.test',
      firstName: 'Bola',
      emailVerified: false,
      phoneVerifiedAt: new Date('2026-09-01T00:00:00Z'),
    },
    {
      id: NO_EMAIL,
      email: null,
      firstName: null,
      emailVerified: true,
      phoneVerifiedAt: null,
    },
    // A web or legacy account: no phone proof, so its address is as before.
    {
      id: LEGACY,
      email: 'legacy@example.test',
      firstName: 'Chidi',
      emailVerified: false,
      phoneVerifiedAt: null,
    },
  ];

  let resend: Server;
  let sent: Array<{ to: string; subject: string; html: string }>;
  let answer: { status: number; body: unknown };
  const beforeUrl = process.env.RESEND_BASE_URL;
  let app: INestApplication;
  let lookedUp: string[];

  /** A token as the Hub signs it: base64url payload, a dot, base64url MAC. */
  const TOKEN =
    'eyJyIjoiNjFmM2E5YzAtMWYyZC00ZTc4LWE3YjEtOWM0ZDJlNmY4YTEwIiwiZSI6MTc5MjQzMjAwMH0.' +
    'q1W2e3R4t5Y6u7I8o9P0a1S2d3F4g5H6j7K8l9Z0x1C';
  const LINK = `https://api.wawuafrica.com/api/hub/settings/privacy/export/download?token=${encodeURIComponent(TOKEN)}`;
  const inHours = (h: number): string =>
    new Date(Date.now() + h * 3_600_000).toISOString();

  /** The body the Hub sends, field for field (backend `DataExportMailer`). */
  const hubBody = (over: Record<string, unknown> = {}) => ({
    downloadUrl: LINK,
    expiresAt: inHours(72),
    ...over,
  });

  beforeAll(async () => {
    resend = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const b = JSON.parse(raw) as {
          to: string;
          subject: string;
          html: string;
        };
        if (answer.status < 300) {
          sent.push({ to: b.to, subject: b.subject, html: b.html });
        }
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((done) => resend.listen(0, '127.0.0.1', done));
    process.env.RESEND_BASE_URL = `http://127.0.0.1:${(resend.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (beforeUrl === undefined) delete process.env.RESEND_BASE_URL;
    else process.env.RESEND_BASE_URL = beforeUrl;
    await new Promise((done) => resend.close(done));
  });

  async function boot(withTransport = true) {
    const mail = new MailService({
      get: (name: string) =>
        name === 'RESEND_API_KEY' && withTransport ? 're_local' : undefined,
    } as never);
    const prisma = {
      wawuUser: {
        findUnique: ({ where }: { where: { id: string } }) => {
          lookedUp.push(where.id);
          return Promise.resolve(
            accounts.find((a) => a.id === where.id) ?? null,
          );
        },
      },
    };
    const auth = new AuthService(
      prisma as never,
      {} as never,
      {} as never,
      mail,
      {} as never,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [InternalController],
      providers: [
        { provide: AuthService, useValue: auth },
        {
          provide: ConfigService,
          useValue: {
            get: (k: string) =>
              k === 'INTERNAL_SERVICE_KEY' ? KEY : undefined,
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // The same pipe and filter as main.ts.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: false,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  }

  beforeEach(async () => {
    sent = [];
    lookedUp = [];
    answer = { status: 200, body: { id: 'mail_1' } };
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    await boot();
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  const post = (
    userId: string,
    body: unknown,
    key: string | null = KEY,
  ): request.Test => {
    const r = request(app.getHttpServer() as App).post(
      `/internal/users/${userId}/data-export`,
    );
    if (key !== null) r.set('x-service-key', key);
    return r.set('content-type', 'application/json').send(JSON.stringify(body));
  };

  describe('a link from the Hub', () => {
    it("is mailed once to that account's own address, and the answer says so", async () => {
      const res = await post(OWNER, hubBody()).expect(200);
      expect(res.body).toEqual({ data: { emailed: true } });
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe('owner@example.test');
      expect(sent[0].subject).toBe(
        'Your Who Made This? data is ready to download',
      );
    });

    it('carries the link on the button, the deadline in Lagos time, and escapes the name', async () => {
      const expiresAt = '2026-10-20T13:05:00.000Z';
      jest.useFakeTimers({
        doNotFake: [
          'setImmediate',
          'nextTick',
          'setTimeout',
          'setInterval',
          'clearTimeout',
          'clearInterval',
          'queueMicrotask',
        ],
      });
      jest.setSystemTime(new Date('2026-10-17T13:05:00.000Z'));
      try {
        await post(OWNER, hubBody({ expiresAt })).expect(200);
      } finally {
        jest.useRealTimers();
      }
      const html = sent[0].html;
      expect(html).toContain(`href="${LINK}"`);
      expect(html).toContain('>Download my data</a>');
      // 13:05 UTC is 14:05 in Lagos (UTC+1, no daylight saving).
      expect(html).toContain('Tue 20 Oct 2026 at 14:05');
      expect(html).toContain('Hello Ada &lt;b&gt;,');
      expect(html).not.toContain('Ada <b>');
    });

    it('has no em-dash anywhere in the mail', async () => {
      await post(OWNER, hubBody()).expect(200);
      expect(sent[0].html).not.toContain(String.fromCharCode(0x2014));
      expect(sent[0].subject).not.toContain(String.fromCharCode(0x2014));
    });

    it('is rebuilt from the checked parts, so the mail holds the one link and nothing else', async () => {
      await post(
        OWNER,
        hubBody({
          downloadUrl: `HTTPS://API.WAWUAFRICA.COM:443/api/hub/settings/privacy/export/download?token=${TOKEN}`,
        }),
      ).expect(200);
      expect(sent[0].html).toContain(`href="${LINK}"`);
    });

    it('goes to a web or legacy account whose email was never marked proven, as every other mail does', async () => {
      await post(LEGACY, hubBody()).expect(200);
      expect(sent.map((m) => m.to)).toEqual(['legacy@example.test']);
    });
  });

  describe('who may ask and who gets it', () => {
    it('refuses a call without the service key, or with a wrong one, before anything is read or sent', async () => {
      await post(OWNER, hubBody(), null).expect(401);
      await post(OWNER, hubBody(), 'not-the-key').expect(401);
      expect(lookedUp).toEqual([]);
      expect(sent).toEqual([]);
    });

    it('is 404 for an account that does not exist', async () => {
      await post('00000000-0000-4000-8000-0000000000ff', hubBody()).expect(404);
      expect(sent).toEqual([]);
    });

    it('is 409 for an account with no address, and for one whose typed address was never proven', async () => {
      await post(NO_EMAIL, hubBody()).expect(409);
      await post(UNPROVEN, hubBody()).expect(409);
      expect(sent).toEqual([]);
    });

    it('is 503, never 200, when no mail transport is configured', async () => {
      await app.close();
      await boot(false);
      await post(OWNER, hubBody()).expect(503);
      expect(sent).toEqual([]);
    });

    it('is 503, never 200, when the mail provider refuses the mail', async () => {
      answer = { status: 500, body: { message: 'down' } };
      await post(OWNER, hubBody()).expect(503);
      expect(sent).toEqual([]);
    });
  });

  describe('a body that is not the export link and its deadline', () => {
    const refused: Array<[string, Record<string, unknown>]> = [
      ['a field that is not named', hubBody({ subject: 'Hello' })],
      [
        'a link on another path',
        hubBody({ downloadUrl: 'https://evil.example/login' }),
      ],
      [
        'a link with the right path and another query value',
        hubBody({ downloadUrl: `${LINK}&next=https://evil.example` }),
      ],
      [
        'a link with no token',
        hubBody({
          downloadUrl:
            'https://api.wawuafrica.com/api/hub/settings/privacy/export/download',
        }),
      ],
      [
        'a link with a sign-in name',
        hubBody({
          downloadUrl: `https://user:pw@api.wawuafrica.com/api/hub/settings/privacy/export/download?token=${TOKEN}`,
        }),
      ],
      ['a link with a fragment', hubBody({ downloadUrl: `${LINK}#x` })],
      [
        'a link over plain http to another machine',
        hubBody({ downloadUrl: LINK.replace('https:', 'http:') }),
      ],
      [
        'a token with a character a signed link never has',
        hubBody({
          downloadUrl:
            'https://api.wawuafrica.com/api/hub/settings/privacy/export/download?token=abc%22%3E%3Cscript%3Ealert(1)%3C/script%3E',
        }),
      ],
      [
        'a token that is too short',
        hubBody({
          downloadUrl:
            'https://api.wawuafrica.com/api/hub/settings/privacy/export/download?token=abc',
        }),
      ],
      ['a link that is not a link', hubBody({ downloadUrl: 'not a link' })],
      ['a link that is a number', hubBody({ downloadUrl: 7 })],
      ['a deadline that is not a date', hubBody({ expiresAt: 'tomorrow' })],
      ['a deadline that is not text', hubBody({ expiresAt: 1792432000 })],
      ['a deadline already past', hubBody({ expiresAt: inHours(-1) })],
      ['a deadline over a week away', hubBody({ expiresAt: inHours(24 * 8) })],
    ];

    it.each(refused)(
      '%s is 400, and nothing is read or sent',
      async (_n, body) => {
        await post(OWNER, body).expect(400);
        expect(lookedUp).toEqual([]);
        expect(sent).toEqual([]);
      },
    );

    it('a body that is a list, a string or empty is 400 too', async () => {
      await post(OWNER, [hubBody()]).expect(400);
      await post(OWNER, 'hello').expect(400);
      await post(OWNER, {}).expect(400);
      expect(sent).toEqual([]);
    });
  });

  describe('the link check on its own', () => {
    const now = new Date('2026-10-17T12:00:00.000Z');
    const at = (h: number) =>
      new Date(now.getTime() + h * 3_600_000).toISOString();

    it('takes http to this machine outside production, and refuses it in production', () => {
      const local = `http://localhost:3001/api/hub/settings/privacy/export/download?token=${TOKEN}`;
      expect(
        parseDataExportLink(
          { downloadUrl: local, expiresAt: at(72) },
          now,
          false,
        ).downloadUrl,
      ).toBe(local);
      expect(() =>
        parseDataExportLink(
          { downloadUrl: local, expiresAt: at(72) },
          now,
          true,
        ),
      ).toThrow('downloadUrl must be the export link.');
    });

    it('takes a deadline up to a week away and refuses one past it', () => {
      expect(
        parseDataExportLink(
          { downloadUrl: LINK, expiresAt: at(167) },
          now,
          true,
        ).expiresAt.toISOString(),
      ).toBe(at(167));
      expect(() =>
        parseDataExportLink(
          { downloadUrl: LINK, expiresAt: at(169) },
          now,
          true,
        ),
      ).toThrow('expiresAt must be within the next 7 days.');
      expect(() =>
        parseDataExportLink({ downloadUrl: LINK, expiresAt: at(0) }, now, true),
      ).toThrow('expiresAt must be within the next 7 days.');
    });
  });
});
