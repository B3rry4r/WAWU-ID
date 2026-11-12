import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { NOTICE_SAMPLES } from '../testing/notice-samples';
import { MailService } from './mail.service';
import type { MoneyCheckReportMail } from './money-check-report';
import { NOTICE_KINDS, parseNotice } from './notice/notice-kinds';
import { noticeContent } from './notice/notice-words';

/**
 * VOICES-MAIL (V-44): every Who Made This? mail is byte-identical to what it
 * was before VOICES' mails were added. The sha-256 of each mail's From,
 * subject, html and text was taken from the code of commit babfccf (before any
 * VOICES change) and is kept in golden/wmt-mails.json. This spec renders each
 * existing mail now, through the real mailer against a local stand-in for
 * Resend, and compares. A mail whose bytes change fails here; the fixture is
 * never regenerated to make it pass (WMT_GOLDEN_WRITE=1 exists only for the
 * first capture, on the unchanged code).
 */
describe('Who Made This? mails are unchanged', () => {
  type Sent = {
    from: string;
    to: string;
    subject: string;
    html: string;
    text?: string;
  };
  const FIXTURE = join(__dirname, 'golden', 'wmt-mails.json');
  let server: Server;
  let seen: Sent[];
  const before = process.env.RESEND_BASE_URL;
  const ALL_BUT_DATE = [
    'hrtime',
    'nextTick',
    'performance',
    'queueMicrotask',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'requestIdleCallback',
    'cancelIdleCallback',
    'setImmediate',
    'clearImmediate',
    'setInterval',
    'clearInterval',
    'setTimeout',
    'clearTimeout',
  ] as const;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        seen.push(JSON.parse(raw) as Sent);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'mail_1' }));
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    process.env.RESEND_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    if (before === undefined) delete process.env.RESEND_BASE_URL;
    else process.env.RESEND_BASE_URL = before;
    await new Promise((done) => server.close(done));
  });
  beforeEach(() => {
    seen = [];
    jest.useFakeTimers({
      now: new Date('2026-11-12T10:00:00.000Z'),
      doNotFake: [...ALL_BUT_DATE],
    });
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const digest = (s: Sent): string =>
    createHash('sha256')
      .update(JSON.stringify([s.from, s.to, s.subject, s.html, s.text ?? null]))
      .digest('hex');

  const REPORT: MoneyCheckReportMail = {
    night: '2026-11-11',
    provider: 'fintava',
    verdict: 'differences',
    ranAt: '2026-11-12T01:00:00.000Z',
    walletsTotal: 12,
    walletsChecked: 11,
    mismatchCount: 1,
    lookCount: 1,
    checks: [
      {
        id: 'balances',
        state: 'differences',
        checked: 11,
        found: 1,
        note: null,
      },
      {
        id: 'holds',
        state: 'needs_a_look',
        checked: 4,
        found: 1,
        note: 'One hold is older than usual.',
      },
    ],
    held: {
      openCount: 4,
      openKobo: '2500000',
      requiredKobo: '2500000',
      merchantAvailableKobo: '2400000',
    },
    items: [
      {
        check: 'balances',
        severity: 'mismatch',
        kind: 'balance',
        ref: 'w_1',
        detail: 'Ledger and provider differ',
        amountKobo: '100000',
        otherKobo: '90000',
      },
      {
        check: 'holds',
        severity: 'look',
        kind: 'hold',
        ref: 'h_9',
        detail: 'Hold is old',
      },
    ],
    itemsOmitted: 2,
    notices: { late_webhook: { count: 3, amountKobo: '5000' } },
  };

  async function renderAll(): Promise<Record<string, string>> {
    const m = new MailService({
      get: (name: string) =>
        name === 'RESEND_API_KEY' ? 're_local' : undefined,
    } as never);
    const url = 'https://wawuafrica.com/forgot-password';
    const at = new Date('2026-11-10T09:30:00.000Z');
    const calls: Array<[string, () => Promise<void>]> = [
      ['otp default', () => m.sendOtpCode('a@example.test', '482915')],
      [
        'otp phone change',
        () =>
          m.sendOtpCode(
            'a@example.test',
            '482915',
            'verify your phone number change',
          ),
      ],
      [
        'otp strict 5 min',
        () =>
          m.sendOtpCode(
            'a@example.test',
            '482915',
            'verify your email address',
            true,
            { expiresInMinutes: 5, logRecipient: false },
          ),
      ],
      [
        'export',
        () =>
          m.sendDataExportLink(
            'a@example.test',
            'Ada',
            url,
            new Date('2026-11-15T09:30:00.000Z'),
          ),
      ],
      [
        'unpaid warning',
        () => m.sendUnpaidDeletionWarning('a@example.test', 'Ada', 24, url),
      ],
      ['welcome', () => m.sendWelcome('a@example.test', 'Ada')],
      ['welcome no name', () => m.sendWelcome('a@example.test')],
      ['reset', () => m.sendPasswordReset('a@example.test', url, 'Ada')],
      ['reset no name', () => m.sendPasswordReset('a@example.test', url)],
      ['creation', () => m.sendPasswordCreation('a@example.test', url, 'Ada')],
      [
        'email verification',
        () => m.sendEmailVerification('a@example.test', url, 'Ada'),
      ],
      [
        'profile incomplete',
        () => m.sendProfileIncomplete('a@example.test', url, 'Ada'),
      ],
      [
        'sign-in alert',
        () => m.sendLoginAlert('a@example.test', url, 'Ada', at),
      ],
      [
        'password changed',
        () => m.sendPasswordChanged('a@example.test', url, 'Ada', at),
      ],
      ['verified', () => m.sendAccountApproved('a@example.test', 'Ada')],
      [
        'ditto',
        () => m.sendDittoDistributionInvite('a@example.test', 'Ada', url, 10),
      ],
      [
        'money check report',
        () => m.sendMoneyCheckReport('a@example.test', 'Ada', REPORT),
      ],
      [
        'relayed',
        async () => {
          await m.sendRelayed({
            to: 'a@example.test',
            subject: 'Campaign subject',
            html: '<p>Hello</p>',
            text: 'Hello',
            headers: { 'List-Unsubscribe': '<https://wawuafrica.com/u>' },
            tag: 'camp_1',
            idempotencyKey: 'idem-1',
            attachments: [
              {
                filename: 'a.txt',
                content: Buffer.from('hi').toString('base64'),
                contentType: 'text/plain',
              },
            ],
          });
        },
      ],
    ];
    const out: Record<string, string> = {};
    for (const [name, run] of calls) {
      seen = [];
      await run();
      expect(seen).toHaveLength(1);
      out[name] = digest(seen[0]);
    }
    for (const kind of NOTICE_KINDS) {
      const { html, text } = m.renderNotice(
        noticeContent(parseNotice(kind, NOTICE_SAMPLES[kind])),
        'Ada',
      );
      out[`notice ${kind}`] = createHash('sha256')
        .update(JSON.stringify([html, text]))
        .digest('hex');
    }
    return out;
  }

  it('renders every existing mail to the same bytes as before', async () => {
    const now = await renderAll();
    if (process.env.WMT_GOLDEN_WRITE === '1' && !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`);
    }
    const golden = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<
      string,
      string
    >;
    expect(Object.keys(now).sort()).toEqual(Object.keys(golden).sort());
    for (const name of Object.keys(golden)) {
      expect({ name, sha: now[name] }).toEqual({ name, sha: golden[name] });
    }
  });
});
