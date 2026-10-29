import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * BRAND-MAIL (R-76): every email says "Who Made This?" where it names the
 * product. The mail service runs against a local stand-in for Resend (the SDK
 * reads RESEND_BASE_URL), so nothing leaves this machine.
 *
 * The one place the old name stays is the welcome mail's signature line,
 * "CEO, WAWUAfrica": it names the company the person leads, not the product.
 */
describe('emails say Who Made This?', () => {
  type Sent = { from: string; subject: string; html: string };
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

  const sendEach = async (m: MailService) => {
    const url = 'https://wawuafrica.com/x';
    await m.sendOtpCode('a@example.test', '482915', 'verify your email', true);
    await m.sendOtpCode(
      'a@example.test',
      '482915',
      'reset your transaction PIN',
      true,
    );
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
  };

  it('sends from "Who Made This?" on the same address, and names no other product', async () => {
    await sendEach(mail());
    expect(seen).toHaveLength(12);
    for (const s of seen) {
      expect(s.from).toBe('Who Made This? <noreply@wawuafrica.com>');
      const visible = `${s.subject}\n${s.html}`.replace('CEO, WAWUAfrica', '');
      expect(visible).not.toMatch(/WAWU ?Africa/);
      expect(s.html).toContain('Who Made This?');
      expect(s.html).not.toContain('—');
    }
  });

  it('puts the name in the subjects people see', async () => {
    await sendEach(mail());
    const subjects = seen.map((s) => s.subject);
    expect(subjects).toContain('Your Who Made This? verification code');
    expect(subjects).toContain('Your Who Made This? data is ready to download');
    expect(subjects).toContain(
      'Your Who Made This? account closes in 24 hours',
    );
    expect(subjects).toContain('You are In. Welcome to Who Made This?');
  });

  it('keeps the links on the wawuafrica.com domain', async () => {
    await sendEach(mail());
    const html = seen.map((s) => s.html).join('\n');
    // EMAIL-01 round 1: the header picture is WAWU ID's own, on the same domain.
    expect(html).toContain('https://id.wawuafrica.com/assets/email-header.png');
    expect(html).not.toMatch(/whomadethis/i);
  });
});
