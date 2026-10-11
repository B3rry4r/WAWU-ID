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
 *
 * Round 5 (D8, D10, D11, N24): only the account's OWN number and address are
 * cleared, and only while no other account holds them; an OTP row is matched on
 * its digits whatever spelling it was stored in; the sessions go in the same
 * transaction; and an account a newer sign-up already removed answers 404.
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
  const CLAIMED = 'claimer@example.test';
  const TYPED = '+2348051112222';

  type Stored = Record<string, unknown>;
  type Where = Record<string, unknown>;
  const store = {
    phoneVerification: [] as Stored[],
    phoneChangeRequest: [] as Stored[],
    rateCounter: [] as Stored[],
    phoneGuessBudget: [] as Stored[],
    otpSession: [] as Stored[],
  };
  /** Other accounts' `phone` and `email` columns: who else holds what. A spec adds to it. */
  let accounts: Array<{ id: string; phone: string; email: string | null }> = [];
  /** Every place a number or an address is kept outside the account's own row: the person's, and a stranger's beside each. */
  const seeded = (): typeof store => ({
    phoneVerification: [
      { userId: ID, phone: REAL, claimEmail: CLAIMED },
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
      // the address a sign-up was only CLAIMING, and the number a phone change only TYPED: not the person's own
      { scope: 'signup-mail-gap', key: CLAIMED },
      { scope: 'sms-phone-day', key: TYPED },
      { scope: 'sms-phone-gap', key: OTHER },
      { scope: 'signup-mail-gap', key: 'bob@example.test' },
      { scope: 'sms-ip', key: '203.0.113.7' },
    ],
    phoneGuessBudget: [
      { phone: REAL },
      { phone: `signup-email:${GONE_ADDRESS}` },
      { phone: `signup-email:${CLAIMED}` },
      { phone: TYPED },
      { phone: OTHER },
      { phone: 'signup-email:bob@example.test' },
    ],
    otpSession: [
      { phone: REAL },
      { phone: '08031234567' },
      // spelled the way the OTP route stores what it is given (N24)
      { phone: '0803 123 4567' },
      { phone: '+234-803-123-4567' },
      { phone: '(0803) 123 4567' },
      { phone: '00234 803 123 4567' },
      { phone: '  +234 803 123 4567  ' },
      // a number the person only typed for a phone change, and a stranger's in two spellings
      { phone: '0805 111 2222' },
      { phone: OTHER },
      { phone: '0805 555 0000' },
    ],
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
  const tokenWhere: Where[] = [];
  let vanishAtUpdate = false;

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
    tokenWhere.length = 0;
    vanishAtUpdate = false;
    order.length = 0;
    accounts = [];
    for (const [name, seed] of Object.entries(seeded())) {
      store[name as keyof typeof store] = seed;
    }
    const tx = {
      wawuUser: {
        findUnique: ({ where }: { where: { id: string } }) =>
          Promise.resolve(where.id === row?.id ? { ...row } : null),
        // the other accounts that hold one of the numbers or addresses asked for
        findMany: ({
          where,
        }: {
          where: {
            id: { not: string };
            OR: Array<{
              phone?: { in: string[] };
              email?: { equals: string; mode: string };
            }>;
          };
        }) => {
          order.push('wawuUser.findMany');
          return Promise.resolve(
            accounts
              .filter((a) => a.id !== where.id.not)
              .filter((a) =>
                where.OR.some(
                  (w) =>
                    (w.phone && w.phone.in.includes(a.phone)) ||
                    (w.email &&
                      a.email !== null &&
                      a.email.toLowerCase() === w.email.equals.toLowerCase()),
                ),
              )
              .map((a) => ({ phone: a.phone, email: a.email })),
          );
        },
        updateMany: ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<Row>;
        }) => {
          order.push('wawuUser.update');
          if (vanishAtUpdate || where.id !== row?.id) {
            return Promise.resolve({ count: 0 });
          }
          Object.assign(row, data);
          return Promise.resolve({ count: 1 });
        },
      },
      // DELETE FROM otp_sessions WHERE regexp_replace(phone, '[^0-9]', '', 'g') = ANY($1::text[])
      $executeRaw: (strings: TemplateStringsArray, digits: string[]) => {
        order.push('otpSession.deleteByDigits');
        expect(strings.join('?')).toContain('regexp_replace(phone');
        const before = store.otpSession.length;
        store.otpSession = store.otpSession.filter(
          (r) => !digits.includes((r.phone as string).replace(/\D/g, '')),
        );
        return Promise.resolve(before - store.otpSession.length);
      },
      refreshToken: {
        deleteMany: ({ where }: { where: Where }) => (
          order.push('refreshToken.deleteMany'),
          gone.push('refresh'),
          tokenWhere.push(where),
          Promise.resolve({ count: 1 })
        ),
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
          Promise.resolve(where.id === row?.id ? row : null),
        delete: () => {
          row = undefined as never;
          return Promise.resolve({});
        },
      },
      // a transaction that fails is rolled back: nothing it deleted stays deleted
      $transaction: async (run: (t: typeof tx) => Promise<unknown>) => {
        const snapshot = JSON.stringify(store);
        const rowBefore = row ? { ...row } : row;
        try {
          return await run(tx);
        } catch (err) {
          Object.assign(store, JSON.parse(snapshot) as typeof store);
          if (row) Object.assign(row, rowBefore);
          throw err;
        }
      },
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
      // address; a stranger's number, a stranger's address and an IP stay (and see D11 below for the two that are not
      // the person's own).
      expect(store.rateCounter).toEqual([
        { scope: 'signup-mail-gap', key: CLAIMED },
        { scope: 'sms-phone-day', key: TYPED },
        { scope: 'sms-phone-gap', key: OTHER },
        { scope: 'signup-mail-gap', key: 'bob@example.test' },
        { scope: 'sms-ip', key: '203.0.113.7' },
      ]);
      // phone_guess_budgets: the number's, and the mailed sign-up's under its prefix.
      expect(store.phoneGuessBudget.map((r) => r.phone)).toEqual([
        `signup-email:${CLAIMED}`,
        TYPED,
        OTHER,
        'signup-email:bob@example.test',
      ]);
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

    it('leaves no copy of the number the person held, or of the address, in any table or in the row', async () => {
      await anonymise().expect(200);
      const everything = JSON.stringify({ store, row });
      for (const needle of ['8031234567', GONE_ADDRESS]) {
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
      // and nothing the account owns is touched before the code row
      expect(order[0]).toBe('phoneVerification.deleteMany');
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

  // ── JOIN-03 round 5, N24: an OTP row is matched on its digits ───────────────

  describe('removes an OTP session of the number however it was written (N24)', () => {
    it('removes every spelling the OTP route can have stored, and no other number', async () => {
      await anonymise().expect(200);
      expect(store.otpSession.map((r) => r.phone)).toEqual([
        // the typed number of a phone change is not the person's own, and these two are a stranger's
        '0805 111 2222',
        OTHER,
        '0805 555 0000',
      ]);
      expect(order).toContain('otpSession.deleteByDigits');
    });

    it('matches the number the account PROVED as well as the one it holds now', async () => {
      row.phone = '+2349011112222';
      store.otpSession.push(
        { phone: '0901 111 2222' },
        { phone: '+234 (0)801 111 3333' },
      );
      await anonymise().expect(200);
      const left = store.otpSession.map((r) => r.phone);
      // proved 803... (spelled five ways) and the 901... it holds now both go
      expect(left).not.toContain('0901 111 2222');
      expect(left.join('')).not.toContain('(0803)');
      // a number that is neither stays
      expect(left).toContain('+234 (0)801 111 3333');
    });

    it('does not run the digit match when the person held no number', async () => {
      row.phone = `deleted:${ID}`;
      row.phoneVerifiedFor = null;
      await anonymise().expect(200);
      expect(order).not.toContain('otpSession.deleteByDigits');
    });
  });

  // ── JOIN-03 round 5, D11: only the account's own rows ───────────────────────

  describe("removes only the rows that are the deleted account's own (D11)", () => {
    it('keeps the counters, the budget and the code in flight on a number another account holds (a live twin, in another spelling)', async () => {
      accounts = [{ id: 'twin', phone: '08031234567', email: null }];
      await anonymise().expect(200);
      const everything = JSON.stringify(store);
      for (const kept of [
        'sms-phone-gap',
        '"phone":"+2348031234567"',
        '"phone":"08031234567"',
        '"phone":"0803 123 4567"',
      ]) {
        expect(everything).toContain(kept);
      }
      expect(store.rateCounter.filter((r) => r.key === REAL)).toHaveLength(2);
      expect(
        store.rateCounter.filter((r) => r.key === '08031234567'),
      ).toHaveLength(1);
      expect(
        store.phoneGuessBudget.filter((r) => r.phone === REAL),
      ).toHaveLength(1);
      expect(store.otpSession.filter((r) => r.phone === REAL)).toHaveLength(1);
      expect(store.otpSession).toHaveLength(10);
      // the address is still the person's own
      expect(
        store.rateCounter.filter((r) => r.key === GONE_ADDRESS),
      ).toHaveLength(0);
      // and the account is anonymised all the same
      expect(row.phone).toBe(`deleted:${ID}`);
    });

    it('keeps the mail counter and the budget of an address another account holds, in any case', async () => {
      accounts = [{ id: 'holder', phone: OTHER, email: 'Ada@Example.test' }];
      await anonymise().expect(200);
      expect(
        store.rateCounter.filter((r) => r.key === GONE_ADDRESS),
      ).toHaveLength(1);
      expect(
        store.phoneGuessBudget.filter(
          (r) => r.phone === `signup-email:${GONE_ADDRESS}`,
        ),
      ).toHaveLength(1);
      // the number was the person's own
      expect(store.rateCounter.filter((r) => r.key === REAL)).toHaveLength(0);
    });

    it('does not clear a number the sign-up only typed (it was made without the number: another account holds it)', async () => {
      // a pending sign-up whose phone is the G-16 marker and whose code row names the number it typed
      row.phone = `released:${ID}`;
      row.phoneVerifiedFor = null;
      row.phoneVerifiedAt = null;
      accounts = [{ id: 'holder', phone: REAL, email: null }];
      await anonymise().expect(200);
      expect(store.rateCounter.filter((r) => r.key === REAL)).toHaveLength(2);
      expect(
        store.phoneGuessBudget.filter((r) => r.phone === REAL),
      ).toHaveLength(1);
      expect(store.otpSession.filter((r) => r.phone === REAL)).toHaveLength(1);
      expect(store.otpSession).toHaveLength(10);
      // its own code row still goes
      expect(store.phoneVerification.some((r) => r.userId === ID)).toBe(false);
    });

    it('does not clear an address the sign-up only claimed, or a number a phone change only typed', async () => {
      await anonymise().expect(200);
      expect(store.rateCounter.map((r) => r.key)).toEqual(
        expect.arrayContaining([CLAIMED, TYPED]),
      );
      expect(store.phoneGuessBudget.map((r) => r.phone)).toEqual(
        expect.arrayContaining([`signup-email:${CLAIMED}`, TYPED]),
      );
      expect(store.otpSession.map((r) => r.phone)).toContain('0805 111 2222');
    });

    it('clears a number nobody else holds even when another sign-up only typed it (no holder to protect)', async () => {
      accounts = [{ id: 'typer', phone: `released:typer`, email: null }];
      await anonymise().expect(200);
      expect(store.rateCounter.filter((r) => r.key === REAL)).toHaveLength(0);
    });

    it('reads who else holds them inside the transaction, before anything is removed', async () => {
      await anonymise().expect(200);
      expect(order.indexOf('wawuUser.findMany')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('wawuUser.findMany')).toBeLessThan(
        order.indexOf('rateCounter.deleteMany'),
      );
    });
  });

  // ── JOIN-03 round 5, D10: the sessions go in the same transaction ───────────

  describe('revokes every session in its own transaction (D10)', () => {
    it("deletes all of the account's refresh tokens (by account, no token id) and its reset tokens, after the account update", async () => {
      await anonymise().expect(200);
      expect(tokenWhere).toEqual([{ userId: ID }]);
      expect(order.indexOf('refreshToken.deleteMany')).toBeGreaterThan(
        order.indexOf('wawuUser.update'),
      );
    });

    it('revokes nothing when the request is refused', async () => {
      await request(app.getHttpServer() as App)
        .delete(`/internal/users/${ID}?mode=anonymize`)
        .expect(401);
      expect(tokenWhere).toEqual([]);
    });
  });

  // ── JOIN-03 round 5, D8: a newer sign-up took the account first ─────────────

  describe('an account a newer sign-up already removed (D8)', () => {
    it('answers 404 and rolls back what it had deleted, instead of failing with a 500', async () => {
      // the newer sign-up took the code row first and removed the pending account with it, between this
      // request's existence check and its update
      vanishAtUpdate = true;
      const res = await anonymise().expect(404);
      expect(res.body).toMatchObject({ statusCode: 404 });
      // everything the transaction had deleted before the update is back, and so is the row
      expect(store).toEqual(seeded());
      expect(row.phone).toBe(REAL);
      expect(row.status).toBe('active');
      expect(gone).toEqual([]);
    });
  });
});
