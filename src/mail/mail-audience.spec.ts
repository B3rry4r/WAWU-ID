import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HttpExceptionFilter } from '../common/http-exception.filter';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { MailModule } from './mail.module';

/**
 * EMAIL-ID-AUD: GET /internal/mail/audience against a real local Postgres (a
 * stand-in database cannot show ordering or paging). Nothing is sent.
 *
 *   createdb ida_aud_test
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ida_aud_test?schema=public npx prisma migrate deploy
 *   MAIL_AUDIENCE_DATABASE_URL=...same... npx jest src/mail/mail-audience.spec.ts
 *
 * Refuses any database that is not on this machine or whose name lacks "test".
 * Without the variable the cases are skipped.
 */
const DB = process.env.MAIL_AUDIENCE_DATABASE_URL ?? '';
const dbCases =
  DB && /@(localhost|127\.0\.0\.1)[:/]/.test(DB) && /test/.test(DB)
    ? describe
    : describe.skip;

const KEY = 'audience-spec-service-key-not-a-real-secret';
const URL = '/internal/mail/audience';
const uid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

dbCases('GET /internal/mail/audience', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const apps: INestApplication[] = [];
  const before: Record<string, string | undefined> = {};

  async function makeApp(): Promise<INestApplication> {
    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        MailModule,
      ],
    }).compile();
    const a = mod.createNestApplication();
    a.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    a.useGlobalFilters(new HttpExceptionFilter());
    await a.init();
    apps.push(a);
    return a;
  }

  const get = (q = '', key: string | null = KEY, a = app) => {
    const r = request(a.getHttpServer() as Parameters<typeof request>[0]).get(
      `${URL}${q}`,
    );
    return key === null ? r : r.set('X-Service-Key', key);
  };

  const person = (
    n: number,
    over: Record<string, unknown> = {},
  ): Promise<unknown> =>
    prisma.wawuUser.create({
      data: {
        id: uid(n),
        email: `p${n}@audience.test.invalid`,
        phone: `+2348000000${String(n).padStart(3, '0')}`,
        firstName: `First${n}`,
        emailVerified: true,
        ...over,
      } as never,
    });

  beforeAll(async () => {
    for (const k of ['DATABASE_URL', 'INTERNAL_SERVICE_KEY']) {
      before[k] = process.env[k];
    }
    process.env.DATABASE_URL = DB;
    process.env.INTERNAL_SERVICE_KEY = KEY;
    app = await makeApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.wawuUser.deleteMany({
      where: { email: { endsWith: '@audience.test.invalid' } },
    });
  });

  afterAll(async () => {
    await prisma.wawuUser.deleteMany({
      where: { email: { endsWith: '@audience.test.invalid' } },
    });
    for (const a of apps) await a.close();
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('refuses a missing, wrong, empty or wrong-length key, before reading the query', async () => {
    await get('', null).expect(401);
    await get('', 'wrong').expect(401);
    await get('', '').expect(401);
    await get('', `${KEY}x`).expect(401);
    await get('?limit=nonsense', null).expect(401);
  });

  it('refuses everyone while the server has no key set', async () => {
    delete process.env.INTERNAL_SERVICE_KEY;
    try {
      const bare = await makeApp();
      await get('', '', bare).expect(401);
      await get('', KEY, bare).expect(401);
    } finally {
      process.env.INTERNAL_SERVICE_KEY = KEY;
    }
  });

  it('answers { data: [{ id, email, firstName }], nextCursor, total }', async () => {
    await person(1);
    await person(2, { firstName: null });
    const res = await get().expect(200);
    expect(res.body).toEqual({
      data: [
        { id: uid(1), email: 'p1@audience.test.invalid', firstName: 'First1' },
        { id: uid(2), email: 'p2@audience.test.invalid', firstName: null },
      ],
      nextCursor: null,
      total: 2,
    });
  });

  it('gives each account once, in id order, when ids are not in insertion order', async () => {
    for (const n of [5, 3, 1, 4, 2]) await person(n);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(
        `?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      ).expect(200);
      const body = res.body as {
        data: { id: string }[];
        nextCursor: string | null;
        total: number;
      };
      expect(body.total).toBe(5);
      seen.push(...body.data.map((d) => d.id));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([1, 2, 3, 4, 5].map(uid));
  });

  it('gives a last page of exactly limit members no next cursor', async () => {
    await person(1);
    await person(2);
    const res = await get('?limit=2').expect(200);
    expect((res.body as { nextCursor: unknown }).nextCursor).toBeNull();
  });

  it('takes limit 1 to 1000 (default 500) and answers 400 for anything else', async () => {
    await get('?limit=1').expect(200);
    await get('?limit=1000').expect(200);
    await get('?limit=0').expect(400);
    await get('?limit=1001').expect(400);
    await get('?limit=-5').expect(400);
    await get('?limit=abc').expect(400);
    await get('?limit=1.5').expect(400);
    await get('?cursor=not-an-id').expect(400);
  });

  it('lists only active, verified, not deleted accounts that have an email', async () => {
    await person(1);
    await person(2, { status: 'suspended' });
    await person(3, { status: 'banned' });
    await person(4, { status: 'pending_deletion' });
    await person(5, { emailVerified: false });
    await person(6, { deletedAt: new Date() });
    await person(7);
    const res = await get().expect(200);
    const body = res.body as { data: { id: string }[]; total: number };
    expect(body.data.map((d) => d.id)).toEqual([uid(1), uid(7)]);
    expect(body.total).toBe(2);
  });

  it('answers firstName as the first name, or null when it is empty or blank', async () => {
    await person(1, { firstName: '  Ada ' });
    await person(2, { firstName: '' });
    await person(3, { firstName: '   ' });
    await person(4, { firstName: null });
    const res = await get().expect(200);
    expect(
      (res.body as { data: { firstName: string | null }[] }).data.map(
        (d) => d.firstName,
      ),
    ).toEqual(['Ada', null, null, null]);
  });

  it('writes nothing', async () => {
    await person(1);
    const row = await prisma.wawuUser.findUnique({ where: { id: uid(1) } });
    await get().expect(200);
    await get('?limit=1').expect(200);
    expect(await prisma.wawuUser.findUnique({ where: { id: uid(1) } })).toEqual(
      row,
    );
    expect(await prisma.wawuUser.count()).toBe(1);
  });
});
