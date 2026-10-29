import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { NOTICE_SAMPLES } from '../testing/notice-samples';
import { htmlToText } from './mail-text';
import { MailService } from './mail.service';
import { NOTICE_KINDS, parseNotice } from './notice/notice-kinds';
import { noticeContent } from './notice/notice-words';

/**
 * EMAIL-01: the shared layout. Every mail has a plain-text part, a facts box
 * draws label and value rows, and no mail says "by WAWU" or holds an em-dash.
 * The mailer runs against a local stand-in for Resend (the SDK reads
 * RESEND_BASE_URL), so nothing leaves this machine.
 */
describe('the mail layout', () => {
  type Sent = {
    from: string;
    subject: string;
    html: string;
    text?: string;
  };
  let server: Server;
  let seen: Sent[];
  const before = process.env.RESEND_BASE_URL;

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
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  const mail = () =>
    new MailService({
      get: (name: string) =>
        name === 'RESEND_API_KEY' ? 're_local' : undefined,
    } as never);
  const offline = () => new MailService({ get: () => undefined } as never);

  const url = 'https://wawuafrica.com/forgot-password';
  const sendEveryMail = async (m: MailService) => {
    await m.sendOtpCode('a@example.test', '482915', 'verify your email', true);
    await m.sendDataExportLink('a@example.test', 'Ada', url, new Date());
    await m.sendUnpaidDeletionWarning('a@example.test', 'Ada', 24, url);
    await m.sendWelcome('a@example.test', 'Ada');
    await m.sendPasswordReset('a@example.test', url, 'Ada');
    await m.sendPasswordCreation('a@example.test', url, 'Ada');
    await m.sendEmailVerification('a@example.test', url, 'Ada');
    await m.sendProfileIncomplete('a@example.test', url, 'Ada');
    await m.sendLoginAlert('a@example.test', url, 'Ada');
    await m.sendAccountApproved('a@example.test', 'Ada');
    await m.sendDittoDistributionInvite('a@example.test', 'Ada', url, 10);
    await m.sendPasswordChanged('a@example.test', url, 'Ada');
  };

  it('sends a plain-text part with every mail, in step with the html', async () => {
    await sendEveryMail(mail());
    expect(seen).toHaveLength(12);
    for (const s of seen) {
      expect(typeof s.text).toBe('string');
      const text = s.text as string;
      expect(text.length).toBeGreaterThan(40);
      expect(text).not.toMatch(/<[a-z!/]/i);
      expect(text).not.toMatch(/&(amp|lt|gt|quot|nbsp|copy|#\d+);/);
      expect(text).toContain('The Who Made This? Team');
      expect(text).toContain('Who Made This?');
    }
  });

  it('keeps every button as a line with its address, and the code as a line of its own', async () => {
    await sendEveryMail(mail());
    const reset = seen.find(
      (s) => s.subject === 'It Happens To The Best Of Us',
    );
    expect(reset?.text).toContain(`Reset Password: ${url}`);
    const code = seen.find(
      (s) => s.subject === 'Your Who Made This? verification code',
    );
    expect(code?.text?.split('\n')).toContain('482915');
  });

  it('names the product everywhere and holds no em-dash, in the html or the text', async () => {
    await sendEveryMail(mail());
    for (const s of seen) {
      const visible = `${s.subject}\n${s.html}\n${s.text}`.replaceAll(
        'CEO, WAWUAfrica',
        '',
      );
      expect(visible).not.toMatch(/by WAWU/i);
      expect(visible).not.toMatch(/WAWU ?Africa/);
      expect(visible).not.toContain('—');
      expect(s.html).toContain('Who Made This?');
      expect(s.from).toBe('Who Made This? <noreply@wawuafrica.com>');
    }
  });

  it('rewords the sign-in alert: every sign-in, no device and no place', async () => {
    await mail().sendLoginAlert('a@example.test', url, 'Ada');
    const [s] = seen;
    expect(s.subject).toBe('New sign-in to your account');
    const all = `${s.subject}\n${s.text}`;
    expect(all).toMatch(/signed in/i);
    expect(all).not.toMatch(/device|location|place|browser|IP address/i);
    expect(s.text).toContain(`Secure my account: ${url}`);
    expect(s.text).toMatch(/When: .*\(Lagos time\)/);
  });

  it('sends the new password-changed mail with the time and a way to secure the account', async () => {
    await mail().sendPasswordChanged(
      'a@example.test',
      url,
      'Ada',
      new Date('2026-11-14T18:05:00Z'),
    );
    const [s] = seen;
    expect(s.subject).toBe('Your password was changed');
    expect(s.text).toContain('When: Sat 14 Nov 2026, 7:05 PM (Lagos time)');
    expect(s.text).toContain(`Reset my password: ${url}`);
    expect(s.text).toMatch(/If you did not/i);
  });

  it('says "You\'re verified" where it used to say the account was approved', async () => {
    await mail().sendAccountApproved('a@example.test', 'Ada');
    const [s] = seen;
    expect(s.subject).toBe("You're verified");
    const all = `${s.subject}\n${s.text}`;
    expect(all).toContain("You're verified");
    expect(all).not.toMatch(/approved|\becosystem\b/i);
  });

  it('rewords the welcome, keeps its sign-off, and sends no button', async () => {
    await mail().sendWelcome('a@example.test', 'Ada');
    const [s] = seen;
    expect(s.subject).toBe('You are In. Welcome to Who Made This?');
    expect(s.text).toContain('Welcome to Who Made This?');
    expect(s.text).toContain('Emmanuel Lennox');
    expect(s.text).toContain('CEO, WAWUAfrica');
    expect(s.html).not.toContain('<a ');
  });

  describe('a facts box', () => {
    it.each(NOTICE_KINDS.map((k) => [k]))(
      'draws the rows of %s in the html and the text',
      (kind) => {
        const content = noticeContent(parseNotice(kind, NOTICE_SAMPLES[kind]));
        const { html, text } = offline().renderNotice(content, 'Ada');
        for (const f of content.facts) {
          const label = f.label.replace(/&/g, '&amp;');
          expect(html).toContain(label);
          expect(text).toContain(`${f.label}: ${f.value}`);
        }
        expect(html).toContain(content.headline.replace(/&/g, '&amp;'));
        expect(text).toContain(content.headline);
        expect(text).toContain('Hello Ada,');
        // Dark layout, header image, sign-off and footer stay as they were.
        expect(html).toContain('color-scheme');
        expect(html).toContain('email-header.png');
        expect(html).toContain('The Who Made This? Team');
        expect(html).toContain('We Build Ecosystems. Not Programs.');
        // At most one button; the notices have none (no app screen link exists).
        expect((html.match(/<a /g) ?? []).length).toBeLessThanOrEqual(1);
        expect(html).not.toContain('—');
        expect(text).not.toContain('—');
        expect(html).not.toMatch(/by WAWU/i);
      },
    );

    it('escapes what a person typed into a title', () => {
      const content = noticeContent(
        parseNotice('sale_made', {
          ...NOTICE_SAMPLES.sale_made,
          itemTitle: '<script>alert(1)</script> & "x"',
        }),
      );
      const { html, text } = offline().renderNotice(content, null);
      expect(html).not.toContain('<script>');
      expect(html).toContain(
        '&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;',
      );
      expect(text).toContain('<script>alert(1)</script> & "x"');
    });

    it('leaves the greeting out when the person has no first name', () => {
      const content = noticeContent(
        parseNotice('money_in', NOTICE_SAMPLES.money_in),
      );
      const { text } = offline().renderNotice(content, null);
      expect(text).not.toMatch(/Hello/);
    });
  });
});

describe('htmlToText', () => {
  it('turns blocks into lines, links into "label: address", fact rows into "label: value"', () => {
    const html = `<!doctype html><html><head><title>T</title><style>p{}</style></head><body>
      <span style="display:none;max-height:0">Hidden preview</span>
      <img src="x.png" alt="Who Made This?" />
      <h1>Big &amp; bold</h1>
      <p>One<br />two &lt;3</p>
      <table><tr data-fact="1"><td>Amount</td><td>₦5,000.00</td></tr></table>
      <ul><li>First</li><li>Second</li></ul>
      <a href="https://wawuafrica.com/x?a=1&amp;b=2">Open it</a>
      <p>&copy; 2026</p></body></html>`;
    expect(htmlToText(html)).toBe(
      [
        'Big & bold',
        '',
        'One',
        'two <3',
        '',
        'Amount: ₦5,000.00',
        '',
        '- First',
        '- Second',
        '',
        'Open it: https://wawuafrica.com/x?a=1&b=2',
        '',
        '© 2026',
      ].join('\n'),
    );
  });
});
