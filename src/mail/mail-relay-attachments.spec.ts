import { createServer, IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HttpExceptionFilter } from '../common/http-exception.filter';
import { useBodyParsers } from './mail-relay-body';
import { RELAY_ATTACHMENT_MAX_BYTES } from './mail-relay.config';
import { MailModule } from './mail.module';

/**
 * WALLET-35: POST /internal/mail/send now carries files (the Hub mails a wallet
 * statement's CSV). Against a local stand-in for Resend's POST /emails, with
 * the app's own body parsers (`useBodyParsers`), so the size limits are the
 * real ones: a large body is welcome on this route only.
 */
const SERVICE_KEY = 'wallet35-spec-service-key-not-a-real-secret';
const MAIL = {
  to: 'person@wallet35.test.invalid',
  subject: 'Your wallet statement, 1 September 2026 to 30 September 2026',
  html: '<p>Attached.</p>',
  text: 'Attached.',
};
const b64 = (bytes: number, fill = 'a') =>
  Buffer.alloc(bytes, fill).toString('base64');
const CSV = '﻿Date,Time\r\n2026-09-01,00:30\r\n';

interface Seen {
  headers: IncomingMessage['headers'];
  body: {
    to: string;
    attachments?: Array<{
      filename: string;
      content: string | { type: string; data: number[] };
      content_type?: string;
    }>;
  };
}

describe('POST /internal/mail/send with attachments (WALLET-35)', () => {
  let standIn: Server;
  let seen: Seen[] = [];
  const apps: INestApplication[] = [];
  const envBefore: Record<string, string | undefined> = {};
  const ENV = [
    'INTERNAL_SERVICE_KEY',
    'RESEND_API_KEY',
    'RESEND_BASE_URL',
    'MAIL_FROM',
    'MAIL_RELAY_DAILY_CAP',
  ];

  async function makeApp(): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        MailModule,
      ],
    }).compile();
    // As main.ts: no default parser, the app's own.
    const app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    useBodyParsers(app);
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
    body: unknown,
    path = '/internal/mail/send',
  ) =>
    request(app.getHttpServer() as Parameters<typeof request>[0])
      .post(path)
      .set('X-Service-Key', SERVICE_KEY)
      .send(body as object);

  beforeAll(async () => {
    for (const k of ENV) envBefore[k] = process.env[k];
    standIn = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({
          headers: req.headers,
          body: JSON.parse(
            Buffer.concat(chunks).toString('utf8'),
          ) as Seen['body'],
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `stand-in-${seen.length}` }));
      });
    });
    await new Promise<void>((r) => standIn.listen(0, '127.0.0.1', r));
    process.env.RESEND_BASE_URL = `http://127.0.0.1:${(standIn.address() as AddressInfo).port}`;
    process.env.INTERNAL_SERVICE_KEY = SERVICE_KEY;
    process.env.MAIL_FROM = 'WAWU Test Sender <sender@mail.test.invalid>';
    process.env.RESEND_API_KEY = 're_test_local_stand_in';
    delete process.env.MAIL_RELAY_DAILY_CAP;
  });
  beforeEach(() => {
    seen = [];
  });
  afterAll(async () => {
    for (const a of apps) await a.close();
    await new Promise((r) => standIn.close(r));
    for (const k of ENV) {
      if (envBefore[k] === undefined) delete process.env[k];
      else process.env[k] = envBefore[k];
    }
  });

  it('passes a CSV on to the provider with its name, its type and its exact bytes', async () => {
    const app = await makeApp();
    const content = Buffer.from(CSV, 'utf8').toString('base64');
    const res = await post(app, {
      ...MAIL,
      attachments: [
        {
          filename: 'statement-2026-09-01-to-2026-09-30.csv',
          content,
          contentType: 'text/csv; charset=utf-8',
        },
      ],
    }).expect(200);
    expect(res.body).toEqual({ id: 'stand-in-1' });
    const sent = seen[0].body.attachments!;
    expect(sent).toHaveLength(1);
    expect(sent[0].filename).toBe('statement-2026-09-01-to-2026-09-30.csv');
    expect(sent[0].content_type).toBe('text/csv; charset=utf-8');
    // The provider's client sends the bytes as base64 text, so what arrives
    // decodes to the file, byte for byte.
    const arrived =
      typeof sent[0].content === 'string'
        ? Buffer.from(sent[0].content, 'base64')
        : Buffer.from(sent[0].content.data);
    expect(arrived.toString('utf8')).toBe(CSV);
  });

  it('a mail with no files is sent exactly as before, with no attachments key', async () => {
    const app = await makeApp();
    await post(app, MAIL).expect(200);
    await post(app, { ...MAIL, attachments: [] }).expect(200);
    expect(seen).toHaveLength(2);
    for (const s of seen) expect('attachments' in s.body).toBe(false);
  });

  it('takes a body far over 100 kb on this route (a 3 MB file), and only on this route', async () => {
    const app = await makeApp();
    await post(app, {
      ...MAIL,
      attachments: [
        {
          filename: 'big.csv',
          content: b64(3 * 1024 * 1024),
          contentType: 'text/csv',
        },
      ],
    }).expect(200);
    expect(seen).toHaveLength(1);
    // Anywhere else a body over 100 kb is still refused before any route (the
    // app's filter answers 500 for Express's 413, as it did before this task).
    for (const path of [
      '/auth/login',
      '/internal/mail/sendx',
      '/internal/mail',
    ]) {
      const other = await post(app, { filler: 'x'.repeat(150_000) }, path);
      expect([413, 500]).toContain(other.status);
    }
    expect(seen).toHaveLength(1);
  });

  it('refuses files that add up to more than the cap, with a plain 400, and sends nothing', async () => {
    const app = await makeApp();
    const half = Math.ceil(RELAY_ATTACHMENT_MAX_BYTES / 2) + 1024;
    const res = await post(app, {
      ...MAIL,
      attachments: [
        { filename: 'one.csv', content: b64(half), contentType: 'text/csv' },
        { filename: 'two.csv', content: b64(half), contentType: 'text/csv' },
      ],
    }).expect(400);
    expect(JSON.stringify(res.body)).toMatch(/too large/i);
    // Just under the cap goes.
    await post(app, {
      ...MAIL,
      attachments: [
        {
          filename: 'one.csv',
          content: b64(RELAY_ATTACHMENT_MAX_BYTES - 3),
          contentType: 'text/csv',
        },
      ],
    }).expect(200);
    expect(seen).toHaveLength(1);
  });

  it.each([
    ['a path in the name', { filename: '../statement.csv' }],
    ['a space in the name', { filename: 'my statement.csv' }],
    ['a line break in the name', { filename: 'a.csv\r\nBcc: x@y.z' }],
    ['no name', { filename: '' }],
    ['a name that starts with a dot', { filename: '.hidden.csv' }],
    ['content that is not base64', { content: 'not base64 !!' }],
    ['no content', { content: '' }],
    ['a type that is not on the list', { contentType: 'text/html' }],
  ])('refuses %s with a 400 and sends nothing', async (_name, change) => {
    const app = await makeApp();
    const good = {
      filename: 'a.csv',
      content: b64(10),
      contentType: 'text/csv',
    };
    await post(app, { ...MAIL, attachments: [{ ...good, ...change }] }).expect(
      400,
    );
    expect(seen).toHaveLength(0);
  });

  it('refuses more than two files, and a list that is not a list', async () => {
    const app = await makeApp();
    const file = (n: number) => ({
      filename: `f${n}.csv`,
      content: b64(10),
      contentType: 'text/csv',
    });
    await post(app, {
      ...MAIL,
      attachments: [file(1), file(2), file(3)],
    }).expect(400);
    await post(app, { ...MAIL, attachments: 'a.csv' }).expect(400);
    await post(app, { ...MAIL, attachments: [null] }).expect(400);
    expect(seen).toHaveLength(0);
    await post(app, { ...MAIL, attachments: [file(1), file(2)] }).expect(200);
  });

  it('the guard still comes first: no key, no body is read', async () => {
    const app = await makeApp();
    const res = await request(
      app.getHttpServer() as Parameters<typeof request>[0],
    )
      .post('/internal/mail/send')
      .send({
        ...MAIL,
        attachments: [{ filename: 'a.csv', content: b64(2_000_000) }],
      });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });
});
