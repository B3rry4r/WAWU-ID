/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- a stand-in for the mail provider over real HTTP and a real Postgres: rows and bodies are untyped by design */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  Global,
  INestApplication,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HttpExceptionFilter } from '../common/http-exception.filter';
import { PrismaService } from '../prisma/prisma.service';
import { NOTICE_SAMPLES } from '../testing/notice-samples';
import { MailNoticeModule } from './mail-notice.module';
import { NOTICE_KINDS } from './notice/notice-kinds';

/**
 * EMAIL-01: POST /internal/mail/notice. The real controller, guard, service and
 * mailer run; the far end of the mailer is a local stand-in for Resend (never
 * Resend itself), and the database is a real local Postgres:
 *
 *   createdb test_email1_id
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/test_email1_id?schema=public npx prisma migrate deploy
 *   MAIL_NOTICE_DATABASE_URL=...same... npx jest src/mail/mail-notice.spec.ts
 *
 * Refuses any database that is not on this machine or whose name lacks "test".
 * Without the variable the database cases are skipped (the validation cases,
 * which touch no database, run).
 */
const DB = process.env.MAIL_NOTICE_DATABASE_URL ?? '';
const dbCases =
  DB && /@(localhost|127\.0\.0\.1)[:/]/.test(DB) && /test/.test(DB)
    ? describe
    : describe.skip;

const SERVICE_KEY = 'email01-spec-service-key-not-a-real-secret';
const MAIL_FROM = 'Who Made This? <noreply@mail.test.invalid>';

interface Seen {
  headers: IncomingMessage['headers'];
  body: Record<string, any>;
}

let standIn: Server;
let seen: Seen[] = [];
/** Answers for the next requests, one each, then a success. */
let script: Array<{ status: number; name?: string }> = [];
let delayMs = 0;
const envBefore: Record<string, string | undefined> = {};
const ENV = [
  'INTERNAL_SERVICE_KEY',
  'RESEND_API_KEY',
  'RESEND_BASE_URL',
  'MAIL_FROM',
];

beforeAll(async () => {
  for (const k of ENV) envBefore[k] = process.env[k];
  standIn = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      setTimeout(() => {
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
      }, delayMs);
    });
  });
  await new Promise<void>((r) => standIn.listen(0, '127.0.0.1', r));
  process.env.RESEND_BASE_URL = `http://127.0.0.1:${(standIn.address() as AddressInfo).port}`;
  process.env.INTERNAL_SERVICE_KEY = SERVICE_KEY;
  process.env.MAIL_FROM = MAIL_FROM;
  process.env.RESEND_API_KEY = 're_test_local_stand_in';
});
afterAll(async () => {
  for (const k of ENV) {
    if (envBefore[k] === undefined) delete process.env[k];
    else process.env[k] = envBefore[k];
  }
  await new Promise((r) => standIn.close(r));
});
beforeEach(() => {
  seen = [];
  script = [];
  delayMs = 0;
});

async function makeApp(prisma: unknown): Promise<INestApplication> {
  @Global()
  @Module({
    providers: [{ provide: PrismaService, useValue: prisma }],
    exports: [PrismaService],
  })
  class TestPrismaModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      TestPrismaModule,
      MailNoticeModule,
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
  return app;
}

const post = (
  app: INestApplication,
  body: unknown,
  key: string | null = SERVICE_KEY,
) => {
  const r = request(app.getHttpServer() as Parameters<typeof request>[0]).post(
    '/internal/mail/notice',
  );
  return (key === null ? r : r.set('X-Service-Key', key)).send(body as object);
};

const good = (over: Record<string, unknown> = {}) => ({
  wawuId: randomUUID(),
  kind: 'money_in',
  data: NOTICE_SAMPLES.money_in,
  idempotencyKey: `k-${randomUUID()}`,
  ...over,
});

describe('POST /internal/mail/notice, before any database', () => {
  let app: INestApplication;
  const lookups: unknown[] = [];

  beforeAll(async () => {
    const touch = () => {
      lookups.push(1);
      throw new Error('the database must not be touched');
    };
    app = await makeApp({
      wawuUser: { findUnique: touch },
      mailNotice: { createMany: touch, findUnique: touch },
    });
  });
  afterAll(() => app.close());
  beforeEach(() => (lookups.length = 0));

  it('refuses a call with no key, a wrong key or a key of the wrong length, before it reads the body', async () => {
    for (const key of [null, 'nope', `${SERVICE_KEY}x`, '']) {
      const res = await post(app, { nonsense: true }, key);
      expect(res.status).toBe(401);
    }
    expect(seen).toHaveLength(0);
    expect(lookups).toHaveLength(0);
  });

  it('refuses everyone while the server has no key set', async () => {
    const saved = process.env.INTERNAL_SERVICE_KEY;
    delete process.env.INTERNAL_SERVICE_KEY;
    const other = await makeApp({});
    try {
      expect((await post(other, good())).status).toBe(401);
    } finally {
      process.env.INTERNAL_SERVICE_KEY = saved;
      await other.close();
    }
  });

  it('answers 400 for an unknown kind and names the kinds it knows', async () => {
    const res = await post(app, good({ kind: 'weekly_earnings' }));
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('kind');
    expect(res.body.message).toContain('money_in');
    expect(lookups).toHaveLength(0);
  });

  it('answers 400 for a body that is missing a part, or a part of the wrong shape', async () => {
    const cases: Array<Record<string, unknown>> = [
      { wawuId: undefined },
      { wawuId: 'not-a-uuid' },
      { wawuId: 5 },
      { kind: undefined },
      { data: undefined },
      { data: 'x' },
      { idempotencyKey: undefined },
      { idempotencyKey: 'short' },
      { idempotencyKey: 'a'.repeat(129) },
      { idempotencyKey: 'has a space in it' },
      { idempotencyKey: 'has/slash-in-it-ok' },
      { idempotencyKey: 'émoji-key-12345' },
    ];
    for (const over of cases) {
      const res = await post(app, good(over));
      expect(res.status).toBe(400);
      expect(res.body.message).not.toContain('—');
    }
    expect(lookups).toHaveLength(0);
  });

  it('answers 400 for data that does not fit its kind, for every kind', async () => {
    for (const kind of NOTICE_KINDS) {
      if (kind === 'account_deleted') continue; // takes an empty object
      const res = await post(app, good({ kind, data: { wrong: true } }));
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/data\./);
    }
    expect(lookups).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });

  it('takes a key of 8 and of 128 letters, numbers, dash and underscore', async () => {
    const noDb = await makeApp({
      wawuUser: { findUnique: () => Promise.resolve(null) },
    });
    try {
      for (const idempotencyKey of ['abcdefgh', 'A_b-9'.repeat(25) + 'abc']) {
        const res = await post(noDb, good({ idempotencyKey }));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ sent: false, reason: 'no_email' });
      }
    } finally {
      await noDb.close();
    }
  });
});

dbCases('POST /internal/mail/notice against a real database', () => {
  jest.setTimeout(30_000);
  let prisma: PrismaService;
  let app: INestApplication;
  const config = {
    get: (k: string) => (k === 'DATABASE_URL' ? DB : undefined),
    getOrThrow: (k: string) => (k === 'DATABASE_URL' ? DB : undefined),
  } as never;
  let seq = 0;

  async function person(
    over: Record<string, unknown> = {},
  ): Promise<{ id: string; email: string | null }> {
    seq += 1;
    const id = randomUUID();
    const email =
      over.email === undefined
        ? `p${seq}-${id.slice(0, 8)}@email01.test.invalid`
        : (over.email as string | null);
    await prisma.wawuUser.create({
      data: {
        id,
        email,
        phone: `+9${Math.floor(Math.random() * 1e12)
          .toString()
          .padStart(12, '0')}`,
        firstName: 'Ada',
        emailVerified: true,
        ...over,
      } as never,
    });
    return { id, email };
  }
  const rows = (key: string) =>
    prisma.mailNotice.findUnique({ where: { idempotencyKey: key } });

  beforeAll(async () => {
    prisma = new PrismaService(config);
    await prisma.$connect();
    app = await makeApp(prisma);
  });
  afterAll(async () => {
    await prisma.mailNotice.deleteMany({});
    await prisma.wawuUser.deleteMany({
      where: { email: { endsWith: '@email01.test.invalid' } },
    });
    await app.close();
    await prisma.$disconnect();
  });

  it('sends the mail once, to the address of the person, from the sender, with html, a text part and a provider key', async () => {
    const p = await person();
    const body = good({ wawuId: p.id });
    const res = await post(app, body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    expect(seen).toHaveLength(1);
    const mail = seen[0].body;
    expect(mail.from).toBe(MAIL_FROM);
    expect(mail.to).toBe(p.email);
    expect(mail.subject).toMatch(/₦5,000\.00/);
    expect(mail.html).toContain('₦5,000.00');
    expect(mail.html).toContain('Ada Obi');
    expect(mail.text).toContain('Amount: ₦5,000.00');
    expect(mail.text).toContain('From: Ada Obi');
    expect(mail.text).toContain('Hello Ada,');
    expect(mail.html).not.toContain('—');
    expect(mail.html).not.toMatch(/by WAWU/i);
    // The provider is told the key too, so it answers a repeat with the first send.
    expect(String(seen[0].headers['idempotency-key'])).toContain(
      String(body.idempotencyKey),
    );
    const row = await rows(String(body.idempotencyKey));
    expect(row).toMatchObject({
      userId: p.id,
      kind: 'money_in',
      status: 'sent',
    });
    expect(row?.sentAt).toBeInstanceOf(Date);
    expect(row?.providerId).toBe('stand-in-1');
  });

  it('sends every kind', async () => {
    const p = await person();
    for (const kind of NOTICE_KINDS) {
      const res = await post(
        app,
        good({ wawuId: p.id, kind, data: NOTICE_SAMPLES[kind] }),
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ sent: true });
    }
    expect(seen).toHaveLength(NOTICE_KINDS.length);
    for (const s of seen) {
      expect(s.body.text).toEqual(expect.any(String));
      expect(s.body.html).toContain('Who Made This?');
    }
  });

  it('answers a repeat of the same key with replayed, and sends nothing more', async () => {
    const p = await person();
    const body = good({ wawuId: p.id });
    expect((await post(app, body)).body).toEqual({ sent: true });
    const again = await post(app, body);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ sent: false, replayed: true });
    expect((await post(app, body)).body).toEqual({
      sent: false,
      replayed: true,
    });
    expect(seen).toHaveLength(1);
  });

  it('sends once when two calls with the same key race, and when many do', async () => {
    const p = await person();
    delayMs = 150; // the provider is slow, so the second call arrives mid-send
    const two = good({ wawuId: p.id });
    const answers = await Promise.all([post(app, two), post(app, two)]);
    expect(answers.map((a) => a.status)).toEqual([200, 200]);
    expect(
      answers
        .map((a) => a.body)
        .sort((a, b) => Number(!!b.sent) - Number(!!a.sent)),
    ).toEqual([{ sent: true }, { sent: false, replayed: true }]);
    expect(seen).toHaveLength(1);

    seen = [];
    const many = good({ wawuId: p.id, idempotencyKey: `many-${randomUUID()}` });
    const all = await Promise.all(
      Array.from({ length: 8 }, () => post(app, many)),
    );
    expect(all.filter((a) => a.body.sent === true)).toHaveLength(1);
    expect(all.filter((a) => a.body.replayed === true)).toHaveLength(7);
    expect(seen).toHaveLength(1);
  });

  it('sends different keys separately', async () => {
    const p = await person();
    await post(app, good({ wawuId: p.id }));
    await post(app, good({ wawuId: p.id }));
    expect(seen).toHaveLength(2);
  });

  it('answers 409 when a key is used again for another person or another kind, and does not send', async () => {
    const a = await person();
    const b = await person();
    const body = good({ wawuId: a.id });
    expect((await post(app, body)).body).toEqual({ sent: true });
    const other = await post(app, { ...body, wawuId: b.id });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const kind = await post(app, {
      ...body,
      kind: 'pin_changed',
      data: NOTICE_SAMPLES.pin_changed,
    });
    expect(kind.status).toBe(409);
    expect(seen).toHaveLength(1);
  });

  describe('a person with no email to send to', () => {
    const expectNoEmail = async (
      id: string,
      over: Record<string, unknown> = {},
    ) => {
      const body = good({ wawuId: id, ...over });
      const res = await post(app, body);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ sent: false, reason: 'no_email' });
      expect(seen).toHaveLength(0);
      // Nothing was claimed, so the same key can send once there is an address.
      expect(await rows(String(body.idempotencyKey))).toBeNull();
    };

    it('has no address at all', async () => {
      await expectNoEmail((await person({ email: null })).id);
    });
    it('has an address a mobile sign-up never proved', async () => {
      await expectNoEmail(
        (await person({ emailVerified: false, phoneVerifiedAt: new Date() }))
          .id,
      );
    });
    it('is in the 30 days of a deletion (money mail does not go there)', async () => {
      await expectNoEmail(
        (await person({ status: 'pending_deletion', deletedAt: new Date() }))
          .id,
      );
    });
    it('has an account that does not exist', async () => {
      await expectNoEmail(randomUUID());
    });
    it('sends the mail once the address is proven, with the key that found none', async () => {
      const p = await person({
        emailVerified: false,
        phoneVerifiedAt: new Date(),
      });
      const body = good({ wawuId: p.id });
      expect((await post(app, body)).body).toEqual({
        sent: false,
        reason: 'no_email',
      });
      await prisma.wawuUser.update({
        where: { id: p.id },
        data: { emailVerified: true },
      });
      expect((await post(app, body)).body).toEqual({ sent: true });
      expect(seen).toHaveLength(1);
    });
    it('sends to an account whose email was never proven but who never used a phone sign-up (web and legacy accounts)', async () => {
      const p = await person({ emailVerified: false, phoneVerifiedAt: null });
      expect((await post(app, good({ wawuId: p.id }))).body).toEqual({
        sent: true,
      });
    });
  });

  describe('the two deletion mails', () => {
    it('go to a person in the 30 days of a deletion, who still has an address', async () => {
      const p = await person({
        status: 'pending_deletion',
        deletedAt: new Date(),
      });
      for (const kind of ['account_deletion_started', 'account_deleted']) {
        const res = await post(
          app,
          good({ wawuId: p.id, kind, data: NOTICE_SAMPLES[kind] }),
        );
        expect(res.body).toEqual({ sent: true });
      }
      expect(seen).toHaveLength(2);
    });
    it('find no address once the account has been scrubbed', async () => {
      const p = await person({
        email: null,
        phone: `deleted:${randomUUID()}`,
        status: 'banned',
        deletedAt: new Date(),
      });
      const res = await post(
        app,
        good({ wawuId: p.id, kind: 'account_deleted', data: {} }),
      );
      expect(res.body).toEqual({ sent: false, reason: 'no_email' });
    });
  });

  describe('when the provider does not take the mail', () => {
    it('answers 503 when it is busy, gives the key back, and sends on the next try', async () => {
      const p = await person();
      const body = good({ wawuId: p.id });
      script = [{ status: 503 }];
      const failed = await post(app, body);
      expect(failed.status).toBe(503);
      expect(await rows(String(body.idempotencyKey))).toBeNull();
      const retry = await post(app, body);
      expect(retry.body).toEqual({ sent: true });
      expect(seen).toHaveLength(1);
    });
    it('answers 429 from the provider as 503 too', async () => {
      const p = await person();
      script = [{ status: 429, name: 'rate_limit_exceeded' }];
      expect((await post(app, good({ wawuId: p.id }))).status).toBe(503);
    });
    it('answers 502 when the provider refuses the sender, and gives the key back', async () => {
      const p = await person();
      const body = good({ wawuId: p.id });
      script = [{ status: 403, name: 'invalid_from_address' }];
      const res = await post(app, body);
      expect(res.status).toBe(502);
      expect(await rows(String(body.idempotencyKey))).toBeNull();
    });
    it('reads an address the provider calls invalid as a person with no email to send to', async () => {
      const p = await person();
      const body = good({ wawuId: p.id });
      script = [{ status: 422, name: 'validation_error' }];
      const res = await post(app, body);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ sent: false, reason: 'no_email' });
      expect(await rows(String(body.idempotencyKey))).toBeNull();
    });
    it('answers 503 with a plain message while no email key is set here', async () => {
      const p = await person();
      const saved = process.env.RESEND_API_KEY;
      delete process.env.RESEND_API_KEY;
      const bare = await makeApp(prisma);
      try {
        const body = good({ wawuId: p.id });
        const res = await post(bare, body);
        expect(res.status).toBe(503);
        expect(res.body.message).not.toContain('—');
        expect(await rows(String(body.idempotencyKey))).toBeNull();
      } finally {
        process.env.RESEND_API_KEY = saved;
        await bare.close();
      }
    });
  });

  describe('a claim that was never finished', () => {
    it('is left alone while it is fresh, and taken over once it is stale', async () => {
      const p = await person();
      const body = good({ wawuId: p.id });
      await prisma.mailNotice.create({
        data: {
          idempotencyKey: String(body.idempotencyKey),
          userId: p.id,
          kind: 'money_in',
          status: 'sending',
          claimedAt: new Date(),
        },
      });
      expect((await post(app, body)).body).toEqual({
        sent: false,
        replayed: true,
      });
      expect(seen).toHaveLength(0);

      await prisma.mailNotice.update({
        where: { idempotencyKey: String(body.idempotencyKey) },
        data: { claimedAt: new Date(Date.now() - 10 * 60 * 1000) },
      });
      expect((await post(app, body)).body).toEqual({ sent: true });
      expect(seen).toHaveLength(1);
      expect((await rows(String(body.idempotencyKey)))?.status).toBe('sent');
    });
  });

  it('keeps the address and the words out of the notice row', async () => {
    const p = await person();
    const body = good({ wawuId: p.id });
    await post(app, body);
    const row = await rows(String(body.idempotencyKey));
    expect(JSON.stringify(row)).not.toContain('@');
    expect(JSON.stringify(row)).not.toContain('Ada Obi');
  });
});
