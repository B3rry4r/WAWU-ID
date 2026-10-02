import { createServer, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';
import { FintavaSmsProvider } from './fintava-sms.provider';
import { SmsSendError } from './sms.provider';

/**
 * The provider is written to Fintava's published `POST /sms/send`. Here it
 * talks to a receiver on this machine that answers the way that page says
 * (200 on success), so no request leaves the computer and nothing is sent.
 */
describe('FintavaSmsProvider', () => {
  let server: Server;
  let base: string;
  let seen: { method?: string; url?: string; auth?: string; body?: unknown };
  let status = 200;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        seen = {
          method: req.method,
          url: req.url,
          auth: req.headers.authorization,
          body: JSON.parse(raw) as unknown,
        };
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(status === 200 ? {} : { status, message: ['no'] }),
        );
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dev`;
  });
  afterAll(() => new Promise((done) => server.close(done)));
  beforeEach(() => {
    status = 200;
    seen = {};
  });

  const provider = (env: Record<string, string>) =>
    new FintavaSmsProvider({ get: (k: string) => env[k] } as never);

  it('is unconfigured without both settings', () => {
    expect(provider({}).isConfigured()).toBe(false);
    expect(provider({ FINTAVA_API_KEY: 'k' }).isConfigured()).toBe(false);
    expect(provider({ FINTAVA_BASE_URL: base }).isConfigured()).toBe(false);
    expect(
      provider({ FINTAVA_BASE_URL: base, FINTAVA_API_KEY: 'k' }).isConfigured(),
    ).toBe(true);
  });

  it('posts { to, sms } to /sms/send with the bearer key', async () => {
    await provider({
      FINTAVA_BASE_URL: `${base}/`,
      FINTAVA_API_KEY: 'test-key',
    }).send('+2348031234412', 'Your WAWU code is 123456.');
    expect(seen).toEqual({
      method: 'POST',
      url: '/api/dev/sms/send',
      auth: 'Bearer test-key',
      body: { to: '+2348031234412', sms: 'Your WAWU code is 123456.' },
    });
  });

  it('rejects with SmsSendError when Fintava refuses', async () => {
    status = 403;
    await expect(
      provider({ FINTAVA_BASE_URL: base, FINTAVA_API_KEY: 'k' }).send(
        '+2348031234412',
        'x',
      ),
    ).rejects.toMatchObject({ name: 'SmsSendError', status: 403 });
  });

  it('rejects with SmsSendError when nothing is listening', async () => {
    await expect(
      provider({
        FINTAVA_BASE_URL: 'http://127.0.0.1:1',
        FINTAVA_API_KEY: 'k',
      }).send('+2348031234412', 'x'),
    ).rejects.toBeInstanceOf(SmsSendError);
  });

  it('refuses to send when it is not configured', async () => {
    await expect(
      provider({}).send('+2348031234412', 'x'),
    ).rejects.toBeInstanceOf(SmsSendError);
  });
});
