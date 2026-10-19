import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { HttpExceptionFilter } from '../common/http-exception.filter';
import { parsePinResetCode } from '../mail/pin-reset-code';
import { MailService } from '../mail/mail.service';
import { AuthService } from './auth.service';
import { InternalController } from './internal.controller';

/**
 * POST /internal/users/:userId/pin-reset-code (AUTH-09, the Hub's BACKEND_GAPS
 * G-400, ruling R-72): the wallet PIN reset code, mailed to the one account the
 * Hub names. The mail goes out through the real MailService to a local
 * stand-in for Resend (the SDK reads RESEND_BASE_URL), so the mail is seen as
 * the transport receives it and nothing leaves this machine.
 */
describe('POST /internal/users/:userId/pin-reset-code', () => {
  const KEY = 'spec-service-key';
  const OWNER = '00000000-0000-4000-8000-0000000c9001';
  const UNPROVEN = '00000000-0000-4000-8000-0000000c9002';
  const NO_EMAIL = '00000000-0000-4000-8000-0000000c9003';
  const LEGACY = '00000000-0000-4000-8000-0000000c9004';
  const DELETED = '00000000-0000-4000-8000-0000000c9005';
  const DELETING = '00000000-0000-4000-8000-0000000c9006';
  const CODE = '482915';

  type Account = {
    id: string;
    email: string | null;
    emailVerified: boolean;
    phoneVerifiedAt: Date | null;
    status: string;
    deletedAt: Date | null;
  };
  const account = (over: Partial<Account> & { id: string }): Account => ({
    email: null,
    emailVerified: false,
    phoneVerifiedAt: null,
    status: 'active',
    deletedAt: null,
    ...over,
  });
  const accounts: Account[] = [
    account({
      id: OWNER,
      email: 'owner-c9@example.test',
      emailVerified: true,
      phoneVerifiedAt: new Date('2026-09-01T00:00:00Z'),
    }),
    // Signed up on the phone, typed an email, never proved it.
    account({
      id: UNPROVEN,
      email: 'typed-c9@example.test',
      phoneVerifiedAt: new Date('2026-09-01T00:00:00Z'),
    }),
    account({
      id: NO_EMAIL,
      emailVerified: true,
      phoneVerifiedAt: new Date('2026-09-01T00:00:00Z'),
    }),
    // A web or legacy account: no phone proof, so its address is as before.
    account({ id: LEGACY, email: 'legacy-c9@example.test' }),
    // The Hub finished deleting it: the row stays, the details are gone.
    account({
      id: DELETED,
      email: 'deleted-c9@example.test',
      emailVerified: true,
      status: 'banned',
      deletedAt: new Date('2026-10-01T00:00:00Z'),
    }),
    // In its 30 days of deletion.
    account({
      id: DELETING,
      email: 'deleting-c9@example.test',
      emailVerified: true,
      status: 'pending_deletion',
      deletedAt: new Date('2026-10-10T00:00:00Z'),
    }),
  ];

  let resend: Server;
  let sent: Array<{ to: string; subject: string; html: string }>;
  let answer: { status: number; body: unknown };
  const beforeUrl = process.env.RESEND_BASE_URL;
  let app: INestApplication;
  let lookedUp: string[];

  /** The body the Hub sends, field for field (backend `NuvionOtpSender`). */
  const hubBody = (over: Record<string, unknown> = {}) => ({
    code: CODE,
    expiresInMinutes: 5,
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

  /** Everything that wrote a line anywhere while a test ran. */
  let written: string[];

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

  const record = (...args: unknown[]): void => {
    written.push(args.map((a) => String(a)).join(' '));
  };

  beforeEach(async () => {
    sent = [];
    lookedUp = [];
    written = [];
    answer = { status: 200, body: { id: 'mail_1' } };
    for (const level of [
      'log',
      'warn',
      'error',
      'debug',
      'verbose',
      'fatal',
    ] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(record);
    }
    jest.spyOn(console, 'log').mockImplementation(record);
    jest.spyOn(console, 'warn').mockImplementation(record);
    jest.spyOn(console, 'error').mockImplementation(record);
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
      `/internal/users/${userId}/pin-reset-code`,
    );
    if (key !== null) r.set('x-service-key', key);
    return r.set('content-type', 'application/json').send(JSON.stringify(body));
  };

  describe('a code from the Hub', () => {
    it("is mailed once to that account's own address, and the answer says so", async () => {
      const res = await post(OWNER, hubBody()).expect(200);
      expect(res.body).toEqual({ data: { sent: true } });
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe('owner-c9@example.test');
      expect(sent[0].subject).toBe('Your WAWUAfrica verification code');
    });

    it('carries the code, says it is for the transaction PIN, and says how long it lives', async () => {
      await post(OWNER, hubBody({ expiresInMinutes: 5 })).expect(200);
      const html = sent[0].html;
      expect(html).toContain(`>${CODE}<`);
      expect(html).toContain('reset your transaction PIN');
      expect(html).toContain('This code expires in 5 minutes.');
      expect(html).not.toContain('10 minutes');
    });

    it('says "1 minute" for a code that lives one minute', async () => {
      await post(OWNER, hubBody({ expiresInMinutes: 1 })).expect(200);
      expect(sent[0].html).toContain('This code expires in 1 minute.');
    });

    it('has no em-dash anywhere in the mail', async () => {
      await post(OWNER, hubBody()).expect(200);
      expect(sent[0].html).not.toContain(String.fromCharCode(0x2014));
      expect(sent[0].subject).not.toContain(String.fromCharCode(0x2014));
    });

    it('goes to a web or legacy account whose email was never marked proven, as every other mail does', async () => {
      await post(LEGACY, hubBody()).expect(200);
      expect(sent.map((m) => m.to)).toEqual(['legacy-c9@example.test']);
    });

    it('ignores a field it does not know, as the mail holds only the code and its life', async () => {
      await post(
        OWNER,
        hubBody({ subject: 'Hello', link: 'https://x.test' }),
      ).expect(200);
      expect(sent[0].subject).toBe('Your WAWUAfrica verification code');
      expect(sent[0].html).not.toContain('x.test');
    });
  });

  describe('the sign-up code mail is unchanged', () => {
    it('still says 10 minutes when nobody names another life', async () => {
      const mail = new MailService({
        get: (name: string) =>
          name === 'RESEND_API_KEY' ? 're_local' : undefined,
      } as never);
      await mail.sendOtpCode(
        'ada-c9@example.test',
        CODE,
        'verify your email address',
        true,
      );
      expect(sent[0].html).toContain('This code expires in 10 minutes.');
      expect(sent[0].html).toContain('verify your email address');
    });
  });

  describe('who may ask and who gets it', () => {
    it('refuses a call without the service key, or with a wrong one, before anything is read or sent', async () => {
      await post(OWNER, hubBody(), null).expect(401);
      await post(OWNER, hubBody(), 'not-the-key').expect(401);
      await post(OWNER, hubBody(), '').expect(401);
      expect(lookedUp).toEqual([]);
      expect(sent).toEqual([]);
    });

    it('is 404 for an account that does not exist', async () => {
      await post('00000000-0000-4000-8000-0000000000ff', hubBody()).expect(404);
      expect(sent).toEqual([]);
    });

    it('is 404 for an id that is not even a uuid, and never asks the database', async () => {
      await post('not-a-user', hubBody()).expect(404);
      await post('12345', hubBody()).expect(404);
      expect(lookedUp).toEqual([]);
      expect(sent).toEqual([]);
    });

    it('is 404 for a deleted account and for one in its 30 days of deletion', async () => {
      await post(DELETED, hubBody()).expect(404);
      await post(DELETING, hubBody()).expect(404);
      expect(lookedUp).toEqual([DELETED, DELETING]);
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

  describe('a body that is not a code and its life', () => {
    const refused: Array<[string, unknown]> = [
      ['no code', { expiresInMinutes: 5 }],
      ['a code of 5 digits', hubBody({ code: '48291' })],
      ['a code of 7 digits', hubBody({ code: '4829150' })],
      ['a code with a letter', hubBody({ code: '48291a' })],
      ['a code with a space', hubBody({ code: '482 915' })],
      ['a code with a line break after it', hubBody({ code: '482915\n' })],
      ['a code that is a number', hubBody({ code: 482915 })],
      ['a code that is a list', hubBody({ code: ['482915'] })],
      ['no life', { code: CODE }],
      ['a life of 0', hubBody({ expiresInMinutes: 0 })],
      ['a negative life', hubBody({ expiresInMinutes: -5 })],
      ['a life with a fraction', hubBody({ expiresInMinutes: 2.5 })],
      ['a life that is text', hubBody({ expiresInMinutes: '5' })],
      ['a life over an hour', hubBody({ expiresInMinutes: 61 })],
      ['a life that is null', hubBody({ expiresInMinutes: null })],
      ['a list', [hubBody()]],
      ['a string', 'hello'],
      ['null', null],
      ['an empty body', {}],
    ];

    it.each(refused)(
      '%s is 400, and nothing is read or sent',
      async (_n, body) => {
        await post(OWNER, body).expect(400);
        expect(lookedUp).toEqual([]);
        expect(sent).toEqual([]);
      },
    );

    it("takes a life of 1 and of 60 minutes, the Hub's own range", () => {
      expect(parsePinResetCode(hubBody({ expiresInMinutes: 1 }))).toEqual({
        code: CODE,
        expiresInMinutes: 1,
      });
      expect(parsePinResetCode(hubBody({ expiresInMinutes: 60 }))).toEqual({
        code: CODE,
        expiresInMinutes: 60,
      });
    });
  });

  describe('the code and the address stay out of the logs and the answers', () => {
    const seenInLogs = (): string => written.join('\n');

    it('on a mail that was sent', async () => {
      const res = await post(OWNER, hubBody()).expect(200);
      expect(seenInLogs()).not.toContain(CODE);
      expect(seenInLogs()).not.toContain('owner-c9@example.test');
      expect(JSON.stringify(res.body)).not.toContain(CODE);
      expect(JSON.stringify(res.body)).not.toContain('owner-c9');
      expect(JSON.stringify(res.headers)).not.toContain(CODE);
    });

    it('on a mail the provider refused', async () => {
      answer = {
        status: 422,
        body: { message: 'bad address owner-c9@example.test', name: 'x' },
      };
      const res = await post(OWNER, hubBody()).expect(503);
      expect(seenInLogs()).not.toContain(CODE);
      expect(seenInLogs()).not.toContain('owner-c9@example.test');
      expect(JSON.stringify(res.body)).not.toContain(CODE);
      expect(JSON.stringify(res.body)).not.toContain('owner-c9');
    });

    it('on a server with no mail transport (where an unstrict send would log the code)', async () => {
      await app.close();
      await boot(false);
      const res = await post(OWNER, hubBody()).expect(503);
      expect(seenInLogs()).not.toContain(CODE);
      expect(seenInLogs()).not.toContain('owner-c9@example.test');
      expect(JSON.stringify(res.body)).not.toContain(CODE);
    });

    it('on every refusal', async () => {
      const results = [
        await post(OWNER, hubBody(), 'wrong').expect(401),
        await post(OWNER, hubBody({ code: '12' })).expect(400),
        await post('00000000-0000-4000-8000-0000000000ff', hubBody()).expect(
          404,
        ),
        await post(DELETED, hubBody()).expect(404),
        await post(UNPROVEN, hubBody()).expect(409),
      ];
      for (const r of results) {
        expect(JSON.stringify(r.body)).not.toContain(CODE);
        expect(JSON.stringify(r.body)).not.toContain('c9@example.test');
      }
      expect(seenInLogs()).not.toContain(CODE);
      expect(seenInLogs()).not.toContain('c9@example.test');
    });
  });
});
