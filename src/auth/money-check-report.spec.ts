import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { HttpExceptionFilter } from '../common/http-exception.filter';
import { MailService } from '../mail/mail.service';
import {
  labelOf,
  nairaOf,
  noticeSentence,
  parseMoneyCheckReport,
} from '../mail/money-check-report';
import { AuthService } from './auth.service';
import { InternalController } from './internal.controller';

/**
 * POST /internal/users/:userId/money-check-report (MONEY-16 round 2, VF-9,
 * BACKEND_GAPS G-690): the nightly money check's report, mailed to the one
 * account the Hub names. The mail goes out through the real MailService to a
 * local stand-in for Resend (the SDK reads RESEND_BASE_URL), so the mail is
 * seen as the transport receives it and nothing leaves this machine.
 */
describe('POST /internal/users/:userId/money-check-report', () => {
  const KEY = 'spec-service-key';
  const OWNER = '00000000-0000-4000-8000-00000000a001';
  const UNVERIFIED = '00000000-0000-4000-8000-00000000a002';
  const GONE = '00000000-0000-4000-8000-00000000a003';

  type Account = {
    id: string;
    email: string | null;
    firstName: string | null;
    emailVerified: boolean;
  };
  const accounts: Account[] = [
    {
      id: OWNER,
      email: 'owner@example.test',
      firstName: 'Ada',
      emailVerified: true,
    },
    {
      id: UNVERIFIED,
      email: 'typed@example.test',
      firstName: 'Bola',
      emailVerified: false,
    },
    { id: GONE, email: null, firstName: null, emailVerified: true },
  ];

  let resend: Server;
  let sent: Array<{ to: string; subject: string; html: string }>;
  let answer: { status: number; body: unknown };
  const beforeUrl = process.env.RESEND_BASE_URL;
  let app: INestApplication;
  let lookedUp: string[];

  /** The body the Hub sends, field for field (backend `MoneyCheckMail`). */
  const hubBody = (over: Record<string, unknown> = {}) => ({
    night: '2026-10-12',
    provider: 'fintava',
    verdict: 'differences',
    ranAt: '2026-10-12T01:41:09.512Z',
    walletsTotal: 9,
    walletsChecked: 8,
    mismatchCount: 2,
    lookCount: 1,
    checks: [
      {
        id: 'movements',
        state: 'differences',
        checked: 40,
        found: 1,
        note: null,
      },
      {
        id: 'balances',
        state: 'incomplete',
        checked: 8,
        found: 0,
        note: '1 wallets could not be read and 0 kept moving while they were read.',
      },
      { id: 'holds', state: 'needs_a_look', checked: 3, found: 1, note: null },
    ],
    held: {
      openCount: 3,
      openKobo: '25000000',
      requiredKobo: '25000000',
      merchantAvailableKobo: '24999999',
    },
    items: [
      {
        check: 'movements',
        severity: 'mismatch',
        kind: 'provider_only',
        ref: '4a9c7f0e-23d1-4b8e-9d52-1f6a5c0e7b11',
        detail:
          'The provider shows this debit completed and the ledger has no row for it.',
        amountKobo: '400000',
      },
      {
        check: 'held_money',
        severity: 'mismatch',
        kind: 'held_money_short',
        ref: 'wawu-account',
        detail:
          "WAWU's account holds 1 kobo less than the 3 open holds need. Held money is not where it should be.",
        amountKobo: '25000000',
        otherKobo: '24999999',
      },
      {
        check: 'holds',
        severity: 'look',
        kind: 'hold_in_review',
        ref: 'm16-abc.123:7',
        detail:
          'This hold is in review: a person has to decide how its money moves.',
        amountKobo: '1000000',
      },
    ],
    itemsOmitted: 0,
    notices: {
      wallets_opened_during_run: { count: 1 },
      holds_waiting_for_payee_wallet: { count: 2, amountKobo: '850000' },
    },
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
      `/internal/users/${userId}/money-check-report`,
    );
    if (key !== null) r.set('x-service-key', key);
    return r.set('content-type', 'application/json').send(JSON.stringify(body));
  };

  // ── the mail ──────────────────────────────────────────────────────────────

  describe('a report from the Hub', () => {
    it("is mailed once to that account's own verified address, and the answer says so", async () => {
      const res = await post(OWNER, hubBody()).expect(200);
      expect(res.body).toEqual({ data: { emailed: true } });
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe('owner@example.test');
      expect(sent[0].subject).toBe(
        'WAWU money check 2026-10-12: differences found',
      );
    });

    it('says the night, the counts, each check, the held money and every item with its reference, in plain words', async () => {
      await post(OWNER, hubBody()).expect(200);
      const html = sent[0].html;
      expect(html).toContain('Hello Ada,');
      expect(html).toContain('Night of 2026-10-12');
      expect(html).toContain('>8 of 9</strong> wallets were checked.');
      expect(html).toContain('Wallet debits');
      expect(html).toContain('Differences found');
      expect(html).toContain('Not all of it could be checked');
      expect(html).toContain('3 open holds worth NGN 250,000.00');
      expect(html).toContain('NGN 249,999.99');
      expect(html).toContain('4a9c7f0e-23d1-4b8e-9d52-1f6a5c0e7b11');
      expect(html).toContain('Reference wawu-account');
      expect(html).toContain('NGN 4,000.00');
      expect(html).toContain('against NGN 249,999.99');
      expect(html).toContain('1 wallet was opened while the check ran.');
      expect(html).toContain(
        '2 holds wait for a creator to open a wallet, NGN 8,500.00 in all.',
      );
    });

    it('has no em-dash anywhere in the mail', async () => {
      await post(OWNER, hubBody()).expect(200);
      expect(sent[0].html).not.toContain(String.fromCharCode(0x2014));
      expect(sent[0].subject).not.toContain(String.fromCharCode(0x2014));
    });

    it('a clean night is mailed too, and says it is all clear', async () => {
      await post(
        OWNER,
        hubBody({
          verdict: 'clean',
          mismatchCount: 0,
          lookCount: 0,
          walletsChecked: 9,
          checks: [
            { id: 'movements', state: 'ok', checked: 40, found: 0, note: null },
          ],
          items: [],
          notices: {},
        }),
      ).expect(200);
      expect(sent[0].subject).toBe('WAWU money check 2026-10-12: all clear');
      expect(sent[0].html).toContain(
        'Everything matched. Nothing differs and nothing needs a look.',
      );
      expect(sent[0].html).toContain('>9 of 9</strong> wallets were checked.');
    });

    it('says how many items are only in the stored report when the mail was cut', async () => {
      await post(OWNER, hubBody({ itemsOmitted: 552 })).expect(200);
      expect(sent[0].html).toContain(
        '552 more are in the stored report on the Hub.',
      );
    });

    it("accepts a provider's own long numeric id as a reference (a movement only the provider has)", async () => {
      const body = hubBody();
      body.items[0].ref = '110022113344556677889900112233';
      await post(OWNER, body).expect(200);
      expect(sent[0].html).toContain('110022113344556677889900112233');
    });

    it('takes a negative amount: a wallet can be short of what the ledger says it has', async () => {
      const body = hubBody();
      body.items[0].amountKobo = '-5000';
      body.items[0].otherKobo = '-100';
      await post(OWNER, body).expect(200);
      expect(sent[0].html).toContain('NGN -50.00 against NGN -1.00');
    });

    it('says the same note of every check once, and a different note on its own check', async () => {
      const note =
        'The run did not finish. The run stopped before it finished and was not made again. (run_died).';
      const same = hubBody();
      same.checks = same.checks.map((c) => ({ ...c, note }));
      await post(OWNER, same).expect(200);
      expect(sent[0].html.split(note).length - 1).toBe(1);
      sent = [];
      const differ = hubBody();
      differ.checks[0].note = 'Only the first.';
      await post(OWNER, differ).expect(200);
      expect(sent[0].html.split('Only the first.').length - 1).toBe(1);
      expect(sent[0].html).toContain(
        '1 wallets could not be read and 0 kept moving while they were read.',
      );
    });

    it('writes the notices the Hub sends in plain words', async () => {
      await post(
        OWNER,
        hubBody({
          notices: {
            too_new_to_judge: { count: 2 },
            provider_charges_to_wawu: { count: 1, amountKobo: '500' },
            provider_pending_not_in_ledger: { count: 3, amountKobo: '1500' },
            provider_failed_not_in_ledger: { count: 1, amountKobo: '100' },
            payments_differ_from_quote: { count: 1 },
          },
        }),
      ).expect(200);
      const html = sent[0].html;
      expect(html).toContain(
        '2 movements were too new to judge. They are checked tomorrow.',
      );
      expect(html).toContain(
        '1 charge the provider made to WAWU itself, NGN 5.00 in all.',
      );
      expect(html).toContain(
        '3 pending records at the provider that the ledger does not have, NGN 15.00 in all. No money moved.',
      );
      expect(html).toContain(
        '1 failed record at the provider that the ledger does not have, NGN 1.00 in all. No money moved.',
      );
      expect(html).toContain(
        '1 completed payment came to a different total than the quote.',
      );
    });

    it('names a notice it has no sentence for by its name and count', async () => {
      await post(
        OWNER,
        hubBody({ notices: { a_new_notice_2: { count: 4 } } }),
      ).expect(200);
      expect(sent[0].html).toContain('A new notice 2: 4.');
    });
  });

  // ── who may ask ───────────────────────────────────────────────────────────

  describe('the service key', () => {
    it('is required: no key, a wrong key and a key of another length are all a 401, and nothing is looked up or mailed', async () => {
      await post(OWNER, hubBody(), null).expect(401);
      await post(OWNER, hubBody(), 'not-the-key').expect(401);
      await post(OWNER, hubBody(), `${KEY}x`).expect(401);
      expect(lookedUp).toEqual([]);
      expect(sent).toEqual([]);
    });
  });

  // ── what it will not take ─────────────────────────────────────────────────

  describe('a body that carries anything but counts, references and amounts', () => {
    const refused = async (body: unknown) => {
      const res = await post(OWNER, body).expect(400);
      expect(sent).toEqual([]);
      // The refusal is a plain sentence with no em-dash.
      expect(JSON.stringify(res.body)).not.toContain(
        String.fromCharCode(0x2014),
      );
      return res.body as { message: string };
    };

    it('refuses a field it does not name, at the top and at every depth', async () => {
      expect(
        (await refused(hubBody({ to: 'someone@example.test' }))).message,
      ).toMatch(/field this route does not take: to\./);
      expect((await refused(hubBody({ html: '<p>hi</p>' }))).message).toMatch(
        /html/,
      );
      expect((await refused(hubBody({ subject: 'Hello' }))).message).toMatch(
        /subject/,
      );
      const item = hubBody();
      (item.items[0] as Record<string, unknown>).name = 'Ada Obi';
      expect((await refused(item)).message).toMatch(/items\[0\]/);
      const check = hubBody();
      (check.checks[0] as Record<string, unknown>).owner = 'x';
      expect((await refused(check)).message).toMatch(/checks\[0\]/);
      const held = hubBody();
      (held.held as Record<string, unknown>).accountNumber = '1';
      expect((await refused(held)).message).toMatch(/held/);
      await refused(
        hubBody({ notices: { a_notice: { count: 1, name: 'x' } } }),
      );
    });

    it('refuses a missing field, a wrong kind of value, and a value outside a closed list', async () => {
      const missing = hubBody();
      delete (missing as Record<string, unknown>).held;
      await refused(missing);
      await refused(hubBody({ verdict: 'fine' }));
      await refused(hubBody({ walletsTotal: '9' }));
      await refused(hubBody({ walletsTotal: -1 }));
      await refused(hubBody({ lookCount: 1.5 }));
      await refused(hubBody({ night: 'yesterday' }));
      await refused(hubBody({ ranAt: 'now' }));
      await refused(hubBody({ provider: 'Fin Tava' }));
      await refused(hubBody({ checks: [{ id: 'x', state: 'great' }] }));
      await refused([hubBody()]);
      await refused('a report');
      await refused(null);
    });

    it('refuses a sentence with a link, an address, an em-dash or a phone number in it', async () => {
      for (const text of [
        'See https://example.test/pay for more.',
        'Mail the person at ada@example.test please.',
        `The provider ${String.fromCharCode(0x2014)} said no.`,
        'Call +2348031234567 about it.',
        'Look at <b>this</b>.',
        '',
      ]) {
        const b = hubBody();
        b.items[0].detail = text;
        await refused(b);
        const c = hubBody();
        c.checks[1].note = text;
        await refused(c);
      }
    });

    it('refuses a reference that is a phone, account, BVN or ID number, and one with odd characters', async () => {
      for (const ref of [
        '08031234567',
        '0123456789',
        '2348031234567',
        '0803-123-4567',
        'a b',
        'ada@example.test',
        '+2348031234567',
        '',
        'x'.repeat(81),
      ]) {
        const b = hubBody();
        b.items[0].ref = ref;
        await refused(b);
      }
    });

    it('refuses an amount that is not digits, and more than a hundred items', async () => {
      const b = hubBody();
      b.items[0].amountKobo = '12.50';
      await refused(b);
      const c = hubBody();
      c.items = Array.from({ length: 101 }, () => ({ ...hubBody().items[0] }));
      await refused(c);
    });

    it('takes exactly a hundred items', async () => {
      const b = hubBody();
      b.items = Array.from({ length: 100 }, (_, i) => ({
        ...hubBody().items[0],
        ref: `row-${i}`,
      }));
      await post(OWNER, b).expect(200);
      expect(sent[0].html).toContain('Reference row-99');
    });
  });

  // ── who it is for ─────────────────────────────────────────────────────────

  describe('the account', () => {
    it('is a 404 for an account that does not exist, and mails nothing', async () => {
      await post('00000000-0000-4000-8000-00000000ffff', hubBody()).expect(404);
      expect(sent).toEqual([]);
    });

    it('is a 409 for an address nobody has proven, and mails nothing', async () => {
      const res = await post(UNVERIFIED, hubBody()).expect(409);
      expect((res.body as { message: string }).message).toBe(
        'This account has no verified email address to send the report to.',
      );
      expect(sent).toEqual([]);
    });

    it('is a 409 for an account with no address (an anonymised one), and mails nothing', async () => {
      await post(GONE, hubBody()).expect(409);
      expect(sent).toEqual([]);
    });

    it('checks the body before it looks the account up', async () => {
      await post(OWNER, hubBody({ verdict: 'fine' })).expect(400);
      expect(lookedUp).toEqual([]);
    });
  });

  // ── the mailer ────────────────────────────────────────────────────────────

  describe('when the mail could not be handed on', () => {
    it('is a 503, not a 200, when the transport refuses it', async () => {
      answer = {
        status: 422,
        body: { name: 'validation_error', message: 'bad', statusCode: 422 },
      };
      const res = await post(OWNER, hubBody()).expect(503);
      expect((res.body as { message: string }).message).toBe(
        'The report could not be handed to the mailer. Try again.',
      );
      expect(sent).toEqual([]);
    });

    it('is a 503 when no transport is configured at all', async () => {
      await app.close();
      await boot(false);
      await post(OWNER, hubBody()).expect(503);
    });
  });
});

describe('the words of the money check mail', () => {
  it('writes kobo as naira without floating point', () => {
    expect(nairaOf('0')).toBe('NGN 0.00');
    expect(nairaOf('5')).toBe('NGN 0.05');
    expect(nairaOf('123456')).toBe('NGN 1,234.56');
    expect(nairaOf('100000000')).toBe('NGN 1,000,000.00');
    expect(nairaOf('999999999999999999')).toBe('NGN 9,999,999,999,999,999.99');
    expect(nairaOf('-1234')).toBe('NGN -12.34');
    expect(nairaOf('-5')).toBe('NGN -0.05');
  });

  it('reads a check by a plain name, and an unknown id by its words', () => {
    expect(labelOf('merchant_charges')).toBe("WAWU's charge on each send");
    expect(labelOf('some_new_check')).toBe('Some new check');
  });

  it('says a wallet opened during the run is checked tomorrow', () => {
    expect(noticeSentence('wallets_opened_during_run', { count: 3 })).toBe(
      '3 wallets were opened while the check ran. They are checked tomorrow.',
    );
  });

  it('accepts the Hub body and gives back only the fields it names', () => {
    const r = parseMoneyCheckReport({
      night: '2026-10-12',
      provider: 'fintava',
      verdict: 'clean',
      ranAt: '2026-10-12T01:41:09Z',
      walletsTotal: 1,
      walletsChecked: 1,
      mismatchCount: 0,
      lookCount: 0,
      checks: [],
      held: {
        openCount: 0,
        openKobo: '0',
        requiredKobo: '0',
        merchantAvailableKobo: null,
      },
      items: [],
      itemsOmitted: 0,
      notices: {},
    });
    expect(Object.keys(r).sort()).toEqual(
      [
        'checks',
        'held',
        'itemsOmitted',
        'items',
        'lookCount',
        'mismatchCount',
        'night',
        'notices',
        'provider',
        'ranAt',
        'verdict',
        'walletsChecked',
        'walletsTotal',
      ].sort(),
    );
  });
});
