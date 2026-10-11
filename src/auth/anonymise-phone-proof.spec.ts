import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthService } from './auth.service';
import { InternalController } from './internal.controller';
import { erasureLockIds, erasureLockKeys } from './erased-identifiers';
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
 *
 * Round 6 (D12, N31): the account's own row is read AFTER the sign-up code row
 * is deleted and under the account's lock, so a confirm that landed a moment
 * earlier is not missed; who else holds the number is asked under an advisory
 * lock shared by every account that holds it; and the hard delete takes the
 * code row before the account.
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
  /** The advisory-lock ids taken, in order (`pg_advisory_xact_lock`). */
  const advisory: string[] = [];
  /** Runs once the sign-up code rows have been deleted: a spec's way to let a confirm commit just before. */
  let afterCodeRowDelete: (() => void) | null = null;
  const table = (name: keyof typeof store) => ({
    findMany: ({ where }: { where: Where }) =>
      Promise.resolve(store[name].filter((r) => matches(r, where))),
    deleteMany: ({ where }: { where: Where }) => {
      order.push(`${name}.deleteMany`);
      const before = store[name].length;
      store[name] = store[name].filter((r) => !matches(r, where));
      if (name === 'phoneVerification') afterCodeRowDelete?.();
      return Promise.resolve({ count: before - store[name].length });
    },
  });

  let app: INestApplication;
  let row: Row;
  const gone: string[] = [];
  const tokenWhere: Where[] = [];
  let vanishAtUpdate = false;
  let vanishAtLock = false;

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
    vanishAtLock = false;
    afterCodeRowDelete = null;
    advisory.length = 0;
    order.length = 0;
    accounts = [];
    for (const [name, seed] of Object.entries(seeded())) {
      store[name as keyof typeof store] = seed;
    }
    const tx = {
      wawuUser: {
        findMany: ({
          where,
        }: {
          where: {
            id: string | { not: string };
            OR?: Array<{
              phone?: { in: string[] };
              email?: { equals: string; mode: string };
            }>;
          };
        }) => {
          // the hard delete looks its account up by id (JOIN-03 round 6, N31)
          if (typeof where.id === 'string') {
            order.push('wawuUser.find');
            return Promise.resolve(
              where.id === row?.id ? [{ id: row.id }] : [],
            );
          }
          // the other accounts that hold one of the numbers or addresses asked for
          order.push('wawuUser.findMany');
          const notId = where.id.not;
          return Promise.resolve(
            accounts
              .filter((a) => a.id !== notId)
              .filter((a) =>
                (where.OR ?? []).some(
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
        // the hard delete's account delete, after its code row
        deleteMany: ({ where }: { where: { AND: Array<{ id?: string }> } }) => {
          order.push('wawuUser.hardDelete');
          const id = where.AND[0]?.id;
          if (id !== row?.id) return Promise.resolve({ count: 0 });
          row = undefined as never;
          return Promise.resolve({ count: 1 });
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
      // The account's own row, read under its lock (JOIN-03 round 6, D12):
      // SELECT email, phone, phone_verified_for FROM wawu_users WHERE id = $1::uuid FOR NO KEY UPDATE
      $queryRaw: (strings: TemplateStringsArray, id: string) => {
        order.push('wawuUser.lock');
        expect(strings.join('?')).toMatch(
          /FROM wawu_users WHERE id = \?::uuid FOR NO KEY UPDATE$/,
        );
        if (vanishAtLock || id !== row?.id) return Promise.resolve([]);
        return Promise.resolve([
          {
            email: row.email,
            phone: row.phone,
            phone_verified_for: row.phoneVerifiedFor,
          },
        ]);
      },
      $executeRaw: (strings: TemplateStringsArray, arg: string | string[]) => {
        const text = strings.join('?');
        // SELECT pg_advisory_xact_lock($1::bigint)
        if (text.includes('pg_advisory_xact_lock')) {
          order.push('advisoryLock');
          advisory.push(arg as string);
          return Promise.resolve(0);
        }
        // DELETE FROM otp_sessions WHERE regexp_replace(phone, '[^0-9]', '', 'g') = ANY($1::text[])
        order.push('otpSession.deleteByDigits');
        expect(text).toContain('regexp_replace(phone');
        const digits = arg as string[];
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

    it("a hard delete is left to the database's cascade and touches none of these tables here, except the sign-up code row it takes ahead of the account (N31)", async () => {
      await request(app.getHttpServer() as App)
        .delete(`/internal/users/${ID}`)
        .set('x-service-key', KEY)
        .expect(200);
      expect(order).toEqual([
        'wawuUser.find',
        'phoneVerification.deleteMany',
        'wawuUser.hardDelete',
      ]);
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

    it('answers 404 the same way when the account is already gone at the lock, and removes nothing else', async () => {
      vanishAtLock = true;
      await anonymise().expect(404);
      expect(store).toEqual(seeded());
      expect(row.phone).toBe(REAL);
      expect(order).not.toContain('wawuUser.update');
      expect(order).not.toContain('rateCounter.deleteMany');
    });
  });

  // ── JOIN-03 round 6, D12: what is the account's own is decided under its locks

  describe("decides what is the account's own from a read taken under its locks (D12)", () => {
    it('deletes the sign-up code row, then reads the locked account, then takes the number locks, then asks who else holds it, then deletes', async () => {
      await anonymise().expect(200);
      const step = (name: string) => order.indexOf(name);
      expect(order[0]).toBe('phoneVerification.deleteMany');
      expect(step('wawuUser.lock')).toBe(1);
      expect(step('advisoryLock')).toBeGreaterThan(step('wawuUser.lock'));
      expect(step('wawuUser.findMany')).toBeGreaterThan(step('advisoryLock'));
      expect(step('rateCounter.deleteMany')).toBeGreaterThan(
        step('wawuUser.findMany'),
      );
      expect(step('wawuUser.update')).toBeGreaterThan(
        step('rateCounter.deleteMany'),
      );
    });

    it("reads the account's number AFTER the code row is gone: a confirm that gave it the number a moment before is not missed (a)", async () => {
      // a sign-up made without its number (another account holds it): the phone is the marker, the number is
      // only in the code row, and the counters keyed on it are the holder's until the code proves it
      row.phone = `released:${ID}`;
      row.phoneVerifiedFor = null;
      row.phoneVerifiedAt = null;
      // the confirm commits between this request's start and its code-row delete: the account holds and has proved the number
      afterCodeRowDelete = () => {
        row.phone = REAL;
        row.phoneVerifiedFor = REAL;
        row.phoneVerifiedAt = new Date('2026-10-11T10:00:00Z');
      };
      await anonymise().expect(200);
      expect(store.rateCounter.filter((r) => r.key === REAL)).toHaveLength(0);
      expect(
        store.phoneGuessBudget.filter((r) => r.phone === REAL),
      ).toHaveLength(0);
      expect(store.otpSession.filter((r) => r.phone === REAL)).toHaveLength(0);
      expect(row.phone).toBe(`deleted:${ID}`);
    });

    it('takes one lock per number or address, the same ids for the same number in any spelling and any case', async () => {
      await anonymise().expect(200);
      // phone and proved number are one key; the address is another
      expect(advisory).toHaveLength(2);
      expect(advisory).toEqual(
        erasureLockIds([`phone:${REAL}`, `email:${GONE_ADDRESS}`]),
      );
      expect(erasureLockKeys({ phones: ['08031234567'], emails: [] })).toEqual(
        erasureLockKeys({ phones: [REAL], emails: [] }),
      );
      expect(
        erasureLockKeys({ phones: [], emails: [' ADA@Example.test '] }),
      ).toEqual(erasureLockKeys({ phones: [], emails: [GONE_ADDRESS] }));
    });

    it('takes the locks in ascending order, whatever order the number and the address are listed in', async () => {
      row.phone = '+2349011112222';
      await anonymise().expect(200);
      const ids = advisory.map((id) => BigInt(id));
      expect(ids.length).toBeGreaterThanOrEqual(3);
      expect(ids).toEqual(
        [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    });

    it('takes no lock when the account held no number and no address', async () => {
      row.phone = `deleted:${ID}`;
      row.phoneVerifiedFor = null;
      row.email = null;
      await anonymise().expect(200);
      expect(advisory).toEqual([]);
    });

    it('still keeps the rows of a number another account holds (D11 under the lock)', async () => {
      accounts = [{ id: 'twin', phone: '234' + REAL.slice(4), email: null }];
      await anonymise().expect(200);
      expect(store.rateCounter.filter((r) => r.key === REAL)).toHaveLength(2);
      expect(advisory.length).toBeGreaterThan(0);
    });
  });
});
