import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { MailSendError, MailService } from './mail.service';

/**
 * The mail service against a local stand-in for Resend (the SDK reads
 * RESEND_BASE_URL), so nothing leaves this machine and no real mail is sent.
 */
describe('MailService.sendOtpCode', () => {
  let server: Server;
  let seen: Array<{ url: string; body: { to: string; html: string } }>;
  let answer: { status: number; body: unknown };
  const before = process.env.RESEND_BASE_URL;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        seen.push({
          url: req.url ?? '',
          body: JSON.parse(raw) as { to: string; html: string },
        });
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.body));
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
    answer = { status: 200, body: { id: 'mail_1' } };
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  const configured = () =>
    new MailService({
      get: (name: string) =>
        name === 'RESEND_API_KEY' ? 're_local' : undefined,
    } as never);
  const unconfigured = () => new MailService({ get: () => undefined } as never);

  it('hands the code to the transport, in the mail body, to the address given', async () => {
    await configured().sendOtpCode(
      'ada@example.test',
      '482915',
      'verify your email address',
      true,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('/emails');
    expect(seen[0].body.to).toBe('ada@example.test');
    expect(seen[0].body.html).toContain('482915');
    expect(seen[0].body.html).toContain('verify your email address');
  });

  it('says whether a transport is configured', () => {
    expect(configured().isConfigured()).toBe(true);
    expect(unconfigured().isConfigured()).toBe(false);
  });

  it('strict: throws when Resend answers an error, and when it cannot be reached', async () => {
    answer = {
      status: 422,
      body: { name: 'validation_error', message: 'bad', statusCode: 422 },
    };
    await expect(
      configured().sendOtpCode('ada@example.test', '482915', undefined, true),
    ).rejects.toBeInstanceOf(MailSendError);

    const before = process.env.RESEND_BASE_URL;
    process.env.RESEND_BASE_URL = 'http://127.0.0.1:1';
    try {
      await expect(
        new MailService({
          get: (n: string) => (n === 'RESEND_API_KEY' ? 're_local' : undefined),
        } as never).sendOtpCode('ada@example.test', '482915', undefined, true),
      ).rejects.toBeInstanceOf(MailSendError);
    } finally {
      process.env.RESEND_BASE_URL = before;
    }
  });

  it('strict: throws instead of skipping when no transport is configured', async () => {
    await expect(
      unconfigured().sendOtpCode('ada@example.test', '482915', undefined, true),
    ).rejects.toBeInstanceOf(MailSendError);
  });

  it('strict: the error says nothing about the code or the address', async () => {
    answer = {
      status: 500,
      body: { name: 'application_error', message: 'down', statusCode: 500 },
    };
    const err = (await configured()
      .sendOtpCode('ada@example.test', '482915', undefined, true)
      .then(
        () => undefined,
        (e: unknown) => e,
      )) as Error;
    expect(err).toBeInstanceOf(MailSendError);
    expect(err.message).not.toMatch(/482915|ada@/);
  });

  it('not strict (every existing caller): a failure is logged and swallowed, as before', async () => {
    answer = {
      status: 500,
      body: { name: 'application_error', message: 'down', statusCode: 500 },
    };
    await expect(
      configured().sendOtpCode('ada@example.test', '482915'),
    ).resolves.toBeUndefined();
    await expect(
      unconfigured().sendOtpCode('ada@example.test', '482915'),
    ).resolves.toBeUndefined();
  });
});
