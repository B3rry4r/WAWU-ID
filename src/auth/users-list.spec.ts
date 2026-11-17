import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { HttpExceptionFilter } from '../common/http-exception.filter';
import { AuthService } from './auth.service';
import { InternalController } from './internal.controller';

/**
 * POST /internal/users/list (R-142, R-143).
 *
 * Runs on an in-memory stand-in for the user table by default, so it needs no
 * database. Set SPEC_DB_URL to a migrated Postgres and the same tests run
 * against the real table (the rows it makes are removed afterwards).
 */
const KEY = 'spec-service-key';
const REAL_URL = process.env.SPEC_DB_URL;

type Row = Record<string, unknown> & { id: string; createdAt: Date };

// ── the in-memory table: reads exactly the where-shapes the route builds ────
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND')
      return (cond as object[]).every((c) => matches(row, c as never));
    if (key === 'OR')
      return (cond as object[]).some((c) => matches(row, c as never));
    if (key === 'NOT') return !matches(row, cond as never);
    const v = row[key];
    if (cond === null || cond instanceof Date || typeof cond !== 'object') {
      if (cond instanceof Date)
        return v instanceof Date && v.getTime() === cond.getTime();
      return v === cond;
    }
    const c = cond as Record<string, unknown>;
    const ci = c.mode === 'insensitive';
    const plain = (x: unknown) =>
      typeof x === 'string' ? x.replace(/\\(.)/g, '$1') : x;
    const norm = (x: unknown) =>
      ci && typeof x === 'string' ? x.toLowerCase() : x;
    const val = norm(v) as string | Date | null;
    return Object.entries(c).every(([op, arg]) => {
      if (op === 'mode') return true;
      if (op === 'in') return (arg as unknown[]).includes(v);
      if (op === 'notIn') return !(arg as unknown[]).includes(v);
      if (op === 'equals') return val === norm(plain(arg));
      if (typeof val !== 'string' && !(val instanceof Date)) return false;
      if (op === 'contains')
        return (val as string).includes(norm(plain(arg)) as string);
      if (op === 'startsWith')
        return (val as string).startsWith(norm(plain(arg)) as string);
      if (op === 'endsWith')
        return (val as string).endsWith(norm(plain(arg)) as string);
      if (op === 'lt') return val < (arg as string | Date);
      throw new Error(`stand-in table does not read ${op}`);
    });
  });
}

function fakeTable(rows: Row[]) {
  return {
    wawuUser: {
      findMany: ({
        where,
        select,
        orderBy,
        take,
      }: {
        where: Record<string, unknown>;
        select: Record<string, true>;
        orderBy?: Array<Record<string, 'asc' | 'desc'>>;
        take?: number;
      }) => {
        let out = rows.filter((r) => matches(r, where));
        if (orderBy) {
          out = [...out].sort((a, b) => {
            for (const o of orderBy) {
              const [k, dir] = Object.entries(o)[0];
              const x = a[k] as string | Date;
              const y = b[k] as string | Date;
              if (x < y) return dir === 'desc' ? 1 : -1;
              if (x > y) return dir === 'desc' ? -1 : 1;
            }
            return 0;
          });
        }
        if (take !== undefined) out = out.slice(0, take);
        // like Prisma: only the selected columns come back
        return Promise.resolve(
          out.map((r) =>
            Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])),
          ),
        );
      },
    },
  };
}

describe('POST /internal/users/list', () => {
  const rows: Row[] = [];
  let real: PrismaClient | null = null;
  let app: INestApplication;
  let seq = 0;
  let failWith: Error | null = null;
  const created: string[] = [];

  const uuid = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const t0 = Date.UTC(2026, 10, 1, 12, 0, 0);

  /** Adds one account; later ones are newer. Secrets are filled in on purpose. */
  async function add(over: Record<string, unknown> = {}): Promise<string> {
    seq += 1;
    const id = (over.id as string) ?? uuid(1000 + seq);
    const data = {
      id,
      email: `user${seq}@example.test`,
      phone: `+2348100${String(seq).padStart(6, '0')}`,
      firstName: `First${seq}`,
      lastName: `Last${seq}`,
      countryCode: 'NG',
      passwordHash: '$argon2id$secret-hash',
      status: 'active',
      deletedAt: null,
      emailVerified: false,
      phoneVerifiedAt: null,
      phoneVerifiedFor: null,
      createdAt: new Date(t0 + seq * 1000),
      ...over,
    };
    if (real) {
      await real.wawuUser.create({ data: data as never });
    } else {
      rows.push(data);
    }
    created.push(id);
    return id;
  }

  async function boot() {
    let prisma: unknown;
    if (REAL_URL) {
      real = new PrismaClient({
        adapter: new PrismaPg({ connectionString: REAL_URL }),
      });
      prisma = real;
    } else {
      const table = fakeTable(rows);
      prisma = {
        wawuUser: {
          findMany: (args: never) => {
            if (failWith) return Promise.reject(failWith);
            return table.wawuUser.findMany(args);
          },
        },
      };
    }
    const auth = new AuthService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
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

  const http = () => app.getHttpServer() as App;
  const list = (body: unknown, key: string | null = KEY) => {
    const r = request(http()).post('/internal/users/list');
    return (key === null ? r : r.set('x-service-key', key)).send(
      body as object,
    );
  };
  type Item = Record<string, unknown> & { id: string };
  type Answer = { items: Item[]; nextCursor: string | null; message?: string };
  const bodyOf = (res: request.Response) => res.body as Answer;
  const idsOf = (res: request.Response) => bodyOf(res).items.map((i) => i.id);

  beforeAll(async () => {
    await boot();
  });
  afterAll(async () => {
    if (real) {
      await real.wawuUser.deleteMany({ where: { id: { in: created } } });
      await real.$disconnect();
    }
    await app.close();
  });
  afterEach(() => {
    failWith = null;
  });

  describe('the key', () => {
    it('refuses no key and a wrong key exactly like users/lookup', async () => {
      const lookupNone = await request(http())
        .post('/internal/users/lookup')
        .send({ ids: [uuid(1)] });
      const lookupWrong = await request(http())
        .post('/internal/users/lookup')
        .set('x-service-key', 'nope')
        .send({ ids: [uuid(1)] });
      const none = await list({}, null);
      const wrong = await list({}, 'nope');
      expect(none.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(bodyOf(none)).toEqual(bodyOf(lookupNone));
      expect(bodyOf(wrong)).toEqual(bodyOf(lookupWrong));
      expect(bodyOf(wrong).message).toBe('Invalid service key');
    });

    it('checks the key before it reads the body', async () => {
      const res = await list({ ids: 'not a list', limit: -5 }, 'nope');
      expect(res.status).toBe(401);
    });
  });

  describe('ids', () => {
    let a: string;
    let b: string;
    let gone: string;
    beforeAll(async () => {
      a = await add({ firstName: 'Ids', lastName: 'Alpha' });
      b = await add({ firstName: 'Ids', lastName: 'Beta' });
      gone = await add({ deletedAt: new Date(t0) });
    });

    it('returns the ones that exist, and nextCursor is null', async () => {
      const res = await list({ ids: [a, b] });
      expect(res.status).toBe(200);
      expect(idsOf(res).sort()).toEqual([a, b].sort());
      expect(bodyOf(res).nextCursor).toBeNull();
    });

    it('leaves out an id that does not exist, and one that is not a uuid', async () => {
      const res = await list({ ids: [a, uuid(999999), 'not-a-uuid', gone] });
      expect(res.status).toBe(200);
      expect(idsOf(res)).toEqual([a]);
    });

    it('answers an empty list when none exist', async () => {
      const res = await list({ ids: [uuid(999998)] });
      expect(res.status).toBe(200);
      expect(bodyOf(res)).toEqual({ items: [], nextCursor: null });
    });

    it('takes 200 ids and refuses 201', async () => {
      const ok = await list({
        ids: Array.from({ length: 200 }, (_, i) => uuid(500000 + i)),
      });
      expect(ok.status).toBe(200);
      const over = await list({
        ids: Array.from({ length: 201 }, (_, i) => uuid(500000 + i)),
      });
      expect(over.status).toBe(400);
    });

    it('refuses an empty list and an id that is not a string', async () => {
      expect((await list({ ids: [] })).status).toBe(400);
      expect((await list({ ids: [a, 12] })).status).toBe(400);
      expect((await list({ ids: [null] })).status).toBe(400);
      expect((await list({ ids: a })).status).toBe(400);
    });

    it('ignores q, cursor and limit, even bad ones', async () => {
      const res = await list({
        ids: [a, b],
        q: 'x',
        cursor: '!!bad!!',
        limit: 0,
      });
      expect(res.status).toBe(200);
      expect(idsOf(res).sort()).toEqual([a, b].sort());
      expect(bodyOf(res).nextCursor).toBeNull();
    });

    it('does not send the same id twice', async () => {
      const res = await list({ ids: [a, a, a] });
      expect(idsOf(res)).toEqual([a]);
    });
  });

  describe('paging', () => {
    it('walks every user once, newest first, with no duplicate while users are added', async () => {
      const mine: string[] = [];
      for (let i = 0; i < 9; i += 1)
        mine.push(await add({ firstName: 'Pager' }));
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      let added = 0;
      do {
        const res: request.Response = await list({
          q: 'Pager',
          limit: 4,
          ...(cursor ? { cursor } : {}),
        });
        expect(res.status).toBe(200);
        expect(bodyOf(res).items.length).toBeLessThanOrEqual(4);
        seen.push(...idsOf(res));
        cursor = bodyOf(res).nextCursor;
        pages += 1;
        // Two newcomers (one with the very same createdAt as an old row) arrive between pages.
        if (pages <= 2) {
          await add({ firstName: 'Pager' });
          await add({ firstName: 'Pager', createdAt: new Date(t0 + 4000) });
          added += 2;
        }
      } while (cursor);
      expect(new Set(seen).size).toBe(seen.length);
      for (const id of mine) expect(seen).toContain(id);
      expect(added).toBe(4);
      // the ones that were there from the start come out newest first
      expect(seen.filter((id) => mine.includes(id))).toEqual(
        [...mine].reverse(),
      );
    });

    it('lists everyone without q, newest first, id descending on a tie', async () => {
      const same = new Date(t0 + 900000);
      const x = await add({ createdAt: same, firstName: 'Tie' });
      const y = await add({ createdAt: same, firstName: 'Tie' });
      const res = await list({ q: 'Tie' });
      const [hi, lo] = [x, y].sort().reverse();
      expect(idsOf(res)).toEqual([hi, lo]);
      const all = await list({ limit: 100 });
      expect(all.status).toBe(200);
      const times = bodyOf(all).items.map((i) => i.createdAt as string);
      expect([...times].sort().reverse()).toEqual(times);
    });

    it('defaults to 50 and refuses a limit outside 1 to 100', async () => {
      for (let i = 0; i < 52; i += 1) await add({ firstName: 'Bulk' });
      const res = await list({ q: 'Bulk' });
      expect(bodyOf(res).items.length).toBe(50);
      expect(bodyOf(res).nextCursor).not.toBeNull();
      expect((await list({ limit: 100 })).status).toBe(200);
      for (const limit of [0, 101, -1, 1.5, '5', 1e9]) {
        expect((await list({ limit })).status).toBe(400);
      }
    });

    it('refuses a cursor that was not issued by this route', async () => {
      for (const cursor of [
        'garbage',
        'a'.repeat(300),
        12,
        Buffer.from('1|nope').toString('base64url'),
      ]) {
        expect((await list({ cursor })).status).toBe(400);
      }
    });
  });

  describe('q', () => {
    let ada: string;
    beforeAll(async () => {
      ada = await add({
        firstName: 'Adaeze',
        lastName: 'Okonkwo-Qtest',
        email: 'Adaeze.Okonkwo@Example.TEST',
        phone: '+2348031234412',
        emailVerified: true,
        phoneVerifiedAt: new Date(t0),
        phoneVerifiedFor: '+2348031234412',
        countryCode: 'GH',
      });
      await add({ firstName: 'Zed', lastName: 'Other' });
    });

    it('matches a part of the first name, or of the last name, any case', async () => {
      expect(idsOf(await list({ q: 'daez' }))).toEqual([ada]);
      expect(idsOf(await list({ q: 'KONKWO-q' }))).toEqual([ada]);
    });

    it('matches a part of "first last"', async () => {
      expect(idsOf(await list({ q: 'adaeze okonk' }))).toEqual([ada]);
      expect(idsOf(await list({ q: 'eze Okonkwo-Qt' }))).toEqual([ada]);
      expect(idsOf(await list({ q: 'Okonkwo Adaeze' }))).toEqual([]);
    });

    it('trims q', async () => {
      expect(idsOf(await list({ q: '   daez  ' }))).toEqual([ada]);
    });

    it('matches the whole email, in another case', async () => {
      expect(idsOf(await list({ q: 'adaeze.okonkwo@example.test' }))).toEqual([
        ada,
      ]);
      expect(idsOf(await list({ q: 'ADAEZE.OKONKWO@EXAMPLE.TEST' }))).toEqual([
        ada,
      ]);
    });

    it('does NOT match a part of an email', async () => {
      expect(idsOf(await list({ q: 'adaeze.okonkwo@example' }))).toEqual([]);
      expect(idsOf(await list({ q: 'okonkwo@example.test' }))).toEqual([]);
      expect(idsOf(await list({ q: '@example.test' }))).toEqual([]);
    });

    it('matches the whole phone in the three usual forms', async () => {
      for (const q of [
        '0803 123 4412',
        '08031234412',
        '+2348031234412',
        '2348031234412',
        '+234 803 123 4412',
      ]) {
        expect(idsOf(await list({ q }))).toEqual([ada]);
      }
    });

    it('does NOT match a part of a phone', async () => {
      expect(idsOf(await list({ q: '0803 123' }))).toEqual([]);
      expect(idsOf(await list({ q: '31234412' }))).toEqual([]);
    });

    it('finds an old-style stored phone from any form', async () => {
      const old = await add({ phone: '08061112233', firstName: 'Oldstyle' });
      expect(idsOf(await list({ q: '+2348061112233' }))).toEqual([old]);
    });

    it('treats % _ and \\ as plain characters', async () => {
      const odd = await add({
        firstName: '100%_Real',
        email: 'a_b@example.test',
      });
      expect(idsOf(await list({ q: '100%_' }))).toEqual([odd]);
      expect(idsOf(await list({ q: '10_%' }))).toEqual([]);
      expect(idsOf(await list({ q: 'a_b@example.test' }))).toEqual([odd]);
      expect(idsOf(await list({ q: 'a%@example.test' }))).toEqual([]);
      expect(idsOf(await list({ q: 'a\\b' }))).toEqual([]);
      expect(idsOf(await list({ q: '%%' }))).toEqual([]);
      expect(idsOf(await list({ q: '__' }))).toEqual([]);
    });

    it('refuses a q shorter than 2 (after trimming) and longer than 120', async () => {
      expect((await list({ q: 'a' })).status).toBe(400);
      expect((await list({ q: '  a  ' })).status).toBe(400);
      expect((await list({ q: '   ' })).status).toBe(400);
      expect((await list({ q: '' })).status).toBe(400);
      expect((await list({ q: 5 })).status).toBe(400);
      expect((await list({ q: 'a'.repeat(121) })).status).toBe(400);
      expect((await list({ q: 'a'.repeat(120) })).status).toBe(200);
      expect((await list({ q: 'ab' })).status).toBe(200);
    });

    it('does not put q in an error message or in a log', async () => {
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
        (m) =>
          jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
      );
      const secret = 'zq-secret-needle@example.test';
      const tooLong = await list({ q: secret + 'x'.repeat(130) });
      expect(tooLong.status).toBe(400);
      expect(JSON.stringify(bodyOf(tooLong))).not.toContain('zq-secret');
      if (!real) {
        failWith = new Error(`query failed for ${secret} and +2348031234412`);
        const boom = await list({ q: secret });
        expect(boom.status).toBe(500);
        expect(JSON.stringify(bodyOf(boom))).not.toContain('zq-secret');
        expect(JSON.stringify(bodyOf(boom))).not.toContain('2348031234412');
      }
      const logged = spies
        .flatMap((s) => s.mock.calls)
        .map((c) => JSON.stringify(c))
        .join('\n');
      expect(logged).not.toContain('zq-secret');
      expect(logged).not.toContain('2348031234412');
      spies.forEach((s) => s.mockRestore());
    });

    it('finds a UK number in every form it is written', async () => {
      const uk = await add({ firstName: 'Ukphone', phone: '+447911123456' });
      for (const q of [
        '+447911123456',
        '+44 7911 123456',
        '07911 123456',
        '07911123456',
        '447911123456',
        '44 7911 123456',
        '00447911123456',
      ]) {
        expect(idsOf(await list({ q }))).toEqual([uk]);
      }
      expect(idsOf(await list({ q: '07911 1234' }))).toEqual([]);
    });

    it('finds a Ghana number in every form it is written', async () => {
      const gh = await add({ firstName: 'Ghphone', phone: '+233241234567' });
      for (const q of [
        '+233241234567',
        '+233 24 123 4567',
        '024 123 4567',
        '0241234567',
        '233241234567',
        '(024) 123-4567',
      ]) {
        expect(idsOf(await list({ q }))).toEqual([gh]);
      }
      expect(idsOf(await list({ q: '0241234' }))).toEqual([]);
    });

    it('still finds a Nigerian number in every form', async () => {
      for (const q of [
        '08031234412',
        '0803 123 4412',
        '+2348031234412',
        '2348031234412',
        '+234-803-123-4412',
        '(0803) 123-4412',
        '002348031234412',
        '8031234412',
      ]) {
        expect(idsOf(await list({ q }))).toEqual([ada]);
      }
    });

    it('refuses a q with a NUL character, as 400', async () => {
      for (const q of ['a\u0000bc', '\u0000\u0000', 'abc\u0000']) {
        const res = await list({ q });
        expect(res.status).toBe(400);
        expect(JSON.stringify(bodyOf(res))).not.toContain('abc');
      }
    });

    it('logs one fixed line when the database fails, with nothing personal', async () => {
      if (real) return;
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
        (m) =>
          jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
      );
      const mail = 'zq-secret-needle@example.test';
      class PrismaClientKnownRequestError extends Error {}
      failWith = new PrismaClientKnownRequestError(
        `bad query for ${mail} +2348031234412 ${uuid(1)}`,
      );
      for (const body of [
        { q: mail },
        { q: '0803 123 4412' },
        { ids: [uuid(1)] },
      ]) {
        expect((await list(body)).status).toBe(500);
      }
      const calls = spies.flatMap((s) => s.mock.calls);
      expect(calls).toHaveLength(3);
      for (const c of calls) {
        expect(c).toEqual([
          'users/list: database call failed (PrismaClientKnownRequestError)',
        ]);
      }
      spies.forEach((s) => s.mockRestore());
    });

    it('reports the account as it is held', async () => {
      const res = await list({ q: 'Adaeze' });
      expect(bodyOf(res).items).toEqual([
        {
          id: ada,
          firstName: 'Adaeze',
          lastName: 'Okonkwo-Qtest',
          email: 'Adaeze.Okonkwo@Example.TEST',
          phone: '+2348031234412',
          countryCode: 'GH',
          createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/) as string,
          emailVerified: true,
          phoneVerified: true,
        },
      ]);
    });
  });

  describe('accounts that are gone', () => {
    it('leaves out deleted accounts only; banned and pending_deletion are returned', async () => {
      const live = await add({ firstName: 'Gonetest', lastName: 'Live' });
      const pend = await add({
        firstName: 'Gonetest',
        status: 'pending_deletion',
      });
      const stamped = await add({
        firstName: 'Gonetest',
        deletedAt: new Date(t0),
      });
      const banned = await add({ firstName: 'Gonetest', status: 'banned' });
      const wiped = await add({
        firstName: 'Gonetest',
        phone: 'deleted:abc',
        email: null,
      });
      // newest first: banned, pend, live
      expect(idsOf(await list({ q: 'Gonetest' }))).toEqual([
        banned,
        pend,
        live,
      ]);
      expect(
        idsOf(await list({ ids: [live, pend, stamped, banned, wiped] })).sort(),
      ).toEqual([live, pend, banned].sort());
    });

    it('keeps an account whose phone was released, with an empty phone', async () => {
      const id = await add({
        firstName: 'Releasedtest',
        phone: 'released:xyz',
      });
      const res = await list({ q: 'Releasedtest' });
      expect(bodyOf(res).items[0]).toMatchObject({
        id,
        phone: '',
        phoneVerified: false,
      });
    });
  });

  describe('what a row carries', () => {
    it('is the nine listed fields and nothing else', async () => {
      const id = await add({
        firstName: 'Shapetest',
        countryCode: null,
        email: null,
        phoneVerifiedAt: new Date(t0),
        phoneVerifiedFor: '+2348199999999',
      });
      for (const body of [{ q: 'Shapetest' }, { ids: [id] }]) {
        const res = await list(body);
        expect(res.status).toBe(200);
        expect(Object.keys(bodyOf(res)).sort()).toEqual([
          'items',
          'nextCursor',
        ]);
        const item = bodyOf(res).items[0];
        expect(Object.keys(item).sort()).toEqual(
          [
            'countryCode',
            'createdAt',
            'email',
            'emailVerified',
            'firstName',
            'id',
            'lastName',
            'phone',
            'phoneVerified',
          ].sort(),
        );
        expect(item.countryCode).toBeNull();
        expect(item.email).toBeNull();
        // the proof was for another number than the one held
        expect(item.phoneVerified).toBe(false);
        const text = JSON.stringify(bodyOf(res));
        expect(text).not.toMatch(/argon2|secret-hash|passwordHash/i);
      }
    });
  });
});
