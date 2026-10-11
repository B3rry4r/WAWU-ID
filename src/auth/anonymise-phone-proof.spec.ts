import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthService } from './auth.service';
import { InternalController } from './internal.controller';
import { phoneIsProven } from './phone-proof';

/**
 * JOIN-03 round 3, D3: `DELETE /internal/users/:id?mode=anonymize` is the call
 * the Hub makes to finalise an account deletion. The number the account proved
 * (`wawu_users.phone_verified_for`) is its real phone number, so it goes with
 * the phone: the row is read back after the request, through the route.
 *
 * Round 4 (N16, D7): the same call also removes the rows OUTSIDE the account's
 * row that hold the person's number or address, and each table is read back
 * here after the request. The tables are small in-memory stores that apply the
 * `where` they are given, so a filter that matches the wrong rows (or none)
 * shows up as a row left behind or a stranger's row gone.
 */
describe('DELETE /internal/users/:id?mode=anonymize clears the number the account proved', () => {
  const KEY = 'spec-service-key';
  const ID = '00000000-0000-4000-8000-0000000000d3';
  const REAL = '+2348031234567';

  type Row = {
    id: string;
    email: string | null;
    phone: string;
    phoneVerifiedAt: Date | null;
    phoneVerifiedFor: string | null;
    firstName: string | null;
    status: string;
    deletedAt: Date | null;
    passwordHash: string | null;
  };

  const OTHER = '+2348055550000';
  const GONE_ADDRESS = 'ada@example.test';

  type Stored = Record<string, unknown>;
  type Where = Record<string, unknown>;
  const store = {
    phoneVerification: [] as Stored[],
    phoneChangeRequest: [] as Stored[],
    rateCounter: [] as Stored[],
    phoneGuessBudget: [] as Stored[],
    otpSession: [] as Stored[],
  };
  /** Every place a number or an address is kept outside the account's own row: the person's, and a stranger's beside each. */
  const seeded = (): typeof store => ({
    phoneVerification: [
      { userId: ID, phone: REAL, claimEmail: 'claimer@example.test' },
      { userId: 'other-user', phone: OTHER, claimEmail: null },
    ],
    phoneChangeRequest: [
      { userId: ID, newPhone: '0805 111 2222' },
      { userId: 'other-user', newPhone: '0805 111 2222' },
    ],
    rateCounter: [
      { scope: 'sms-phone-gap', key: REAL },
      { scope: 'sms-phone-day', key: REAL },
      { scope: 'sms-phone-day', key: '08031234567' },
      { scope: 'signup-mail-gap', key: GONE_ADDRESS },
      { scope: 'signup-mail-gap', key: 'claimer@example.test' },
      { scope: 'sms-phone-gap', key: OTHER },
      { scope: 'signup-mail-gap', key: 'bob@example.test' },
      { scope: 'sms-ip', key: '203.0.113.7' },
    ],
    phoneGuessBudget: [
      { phone: REAL },
      { phone: `signup-email:${GONE_ADDRESS}` },
      { phone: OTHER },
      { phone: 'signup-email:bob@example.test' },
    ],
    otpSession: [{ phone: REAL }, { phone: '08031234567' }, { phone: OTHER }],
  });
  const matches = (stored: Stored, where: Where) =>
    Object.entries(where).every(([key, want]) =>
      want && typeof want === 'object' && 'in' in want
        ? (want.in as unknown[]).includes(stored[key])
        : stored[key] === want,
    );
  const order: string[] = [];
  const table = (name: keyof typeof store) => ({
    findMany: ({ where }: { where: Where }) =>
      Promise.resolve(store[name].filter((r) => matches(r, where))),
    deleteMany: ({ where }: { where: Where }) => {
      order.push(`${name}.deleteMany`);
      const before = store[name].length;
      store[name] = store[name].filter((r) => !matches(r, where));
      return Promise.resolve({ count: before - store[name].length });
    },
  });

  let app: INestApplication;
  let row: Row;
  const gone: string[] = [];

  beforeEach(async () => {
    row = {
      id: ID,
      email: 'ada@example.test',
      phone: REAL,
      phoneVerifiedAt: new Date('2026-10-01T10:00:00Z'),
      phoneVerifiedFor: REAL,
      firstName: 'Ada',
      status: 'active',
      deletedAt: null,
      passwordHash: 'hash',
    };
    gone.length = 0;
    order.length = 0;
    for (const [name, seed] of Object.entries(seeded())) {
      store[name as keyof typeof store] = seed;
    }
    const tx = {
      wawuUser: {
        findUnique: ({ where }: { where: { id: string } }) =>
          Promise.resolve(where.id === row.id ? { ...row } : null),
        update: ({ data }: { data: Partial<Row> }) => {
          order.push('wawuUser.update');
          Object.assign(row, data);
          return Promise.resolve(row);
        },
      },
      refreshToken: {
        deleteMany: () => (gone.push('refresh'), Promise.resolve({ count: 1 })),
      },
      passwordResetToken: {
        deleteMany: () => (gone.push('reset'), Promise.resolve({ count: 0 })),
      },
      phoneVerification: table('phoneVerification'),
      phoneChangeRequest: table('phoneChangeRequest'),
      rateCounter: table('rateCounter'),
      phoneGuessBudget: table('phoneGuessBudget'),
      otpSession: table('otpSession'),
    };
    const prisma = {
      wawuUser: {
        findUnique: ({ where }: { where: { id: string } }) =>
          Promise.resolve(where.id === row.id ? row : null),
        delete: () => {
          row = undefined as never;
          return Promise.resolve({});
        },
      },
      $transaction: (run: (t: typeof tx) => Promise<unknown>) => run(tx),
    };
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
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const anonymise = () =>
    request(app.getHttpServer() as App)
      .delete(`/internal/users/${ID}?mode=anonymize`)
      .set('x-service-key', KEY);

  it('reads back null in phone_verified_for, with the phone a deleted marker', async () => {
    expect(row.phoneVerifiedFor).toBe(REAL);
    const res = await anonymise().expect(200);
    expect(res.body).toEqual({
      data: { id: ID, status: 'banned', deleted: false },
    });
    expect(row.phone).toBe(`deleted:${ID}`);
    expect(row.phoneVerifiedFor).toBeNull();
    // the rest of the scrub is as it was
    expect(row).toMatchObject({
      email: null,
      firstName: null,
      passwordHash: null,
      status: 'banned',
    });
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(gone).toEqual(['refresh', 'reset']);
  });

  it('leaves no copy of the number anywhere in the row', async () => {
    await anonymise().expect(200);
    expect(JSON.stringify(row)).not.toContain('8031234567');
  });

  it('an anonymised account proves nothing even if phone_verified_at stays set', async () => {
    await anonymise().expect(200);
    expect(row.phoneVerifiedAt).not.toBeNull();
    expect(phoneIsProven(row)).toBe(false);
  });

  it('refuses a request without the service key and changes nothing', async () => {
    await request(app.getHttpServer() as App)
      .delete(`/internal/users/${ID}?mode=anonymize`)
      .expect(401);
    expect(row.phoneVerifiedFor).toBe(REAL);
    expect(row.phone).toBe(REAL);
  });

  it('a hard delete removes the row and leaves nothing to clear', async () => {
    await request(app.getHttpServer() as App)
      .delete(`/internal/users/${ID}`)
      .set('x-service-key', KEY)
      .expect(200);
    expect(row).toBeUndefined();
  });

  // ── JOIN-03 round 4 (N16, D7): the rows outside the account's own row ───────

  describe("removes the person's number and address from every other table", () => {
    it('removes the rows keyed on the number, in every spelling, and on the address', async () => {
      await anonymise().expect(200);
      // rate_counters: the text counters of the number (two scopes, and a second spelling) and the mail counters of the
      // address and of the address a sign-up was claiming; a stranger's number, a stranger's address and an IP stay.
      expect(store.rateCounter).toEqual([
        { scope: 'sms-phone-gap', key: OTHER },
        { scope: 'signup-mail-gap', key: 'bob@example.test' },
        { scope: 'sms-ip', key: '203.0.113.7' },
      ]);
      // phone_guess_budgets: the number's, and the mailed sign-up's under its prefix.
      expect(store.phoneGuessBudget).toEqual([
        { phone: OTHER },
        { phone: 'signup-email:bob@example.test' },
      ]);
      // otp_sessions: the number as stored and as 0803...
      expect(store.otpSession).toEqual([{ phone: OTHER }]);
    });

    it("removes the pending phone change and the sign-up code the person was waiting on, and nobody else's", async () => {
      await anonymise().expect(200);
      expect(store.phoneChangeRequest).toEqual([
        { userId: 'other-user', newPhone: '0805 111 2222' },
      ]);
      expect(store.phoneVerification).toEqual([
        { userId: 'other-user', phone: OTHER, claimEmail: null },
      ]);
    });

    it('leaves no copy of the number or the address in any table or in the row', async () => {
      await anonymise().expect(200);
      const everything = JSON.stringify({ store, row });
      for (const needle of [
        '8031234567',
        '8051112222',
        GONE_ADDRESS,
        'claimer@example.test',
      ]) {
        expect(everything).not.toContain(needle);
      }
      // and the stranger's is still where it was
      expect(everything).toContain('8055550000');
    });

    it('also removes the counters of the number the account PROVED when its phone has since been changed to another, and of the new one', async () => {
      // a proven account holds no sign-up code row any more; the internal phone-change route moved its phone
      store.phoneVerification = store.phoneVerification.filter(
        (r) => r.userId !== ID,
      );
      row.phone = '+2349011112222';
      store.rateCounter.push({ scope: 'sms-phone-day', key: row.phone });
      await anonymise().expect(200);
      expect(JSON.stringify(store)).not.toContain('8031234567');
      expect(JSON.stringify(store)).not.toContain('9011112222');
    });

    it('takes the sign-up code row first and the account last, the order the confirm routes lock them in', async () => {
      await anonymise().expect(200);
      expect(
        order.indexOf('phoneVerification.deleteMany'),
      ).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('phoneVerification.deleteMany')).toBeLessThan(
        order.indexOf('wawuUser.update'),
      );
    });

    it("a second request finds only markers, and removes no one else's row", async () => {
      await anonymise().expect(200);
      const after = JSON.stringify(store);
      await anonymise().expect(200);
      expect(JSON.stringify(store)).toBe(after);
    });

    it('a request refused for its key removes nothing', async () => {
      await request(app.getHttpServer() as App)
        .delete(`/internal/users/${ID}?mode=anonymize`)
        .expect(401);
      expect(store).toEqual(seeded());
    });

    it("a hard delete is left to the database's cascade and touches none of these tables here", async () => {
      await request(app.getHttpServer() as App)
        .delete(`/internal/users/${ID}`)
        .set('x-service-key', KEY)
        .expect(200);
      expect(order).toEqual([]);
    });
  });
});
