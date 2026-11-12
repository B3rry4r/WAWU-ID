import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BadRequestException } from '@nestjs/common';
import { MailNoticeService } from './mail-notice.service';
import { MailService } from './mail.service';

/**
 * VOICES-MAIL (V-44): POST /internal/mail/notice with app "voices" (or for a
 * person who signed up through VOICES) sends the VOICES versions of the two
 * deletion notices, from the VOICES sender when VOICES_MAIL_FROM is set. Every
 * other kind, for a person who is not asking as VOICES, is the notice it was.
 */
describe('VOICES deletion notices', () => {
  type Sent = { from: string; subject: string; html: string; text: string };
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
  beforeEach(() => (seen = []));

  const ID = '0b1f3c1e-5b53-4a53-9c58-1c3d1d8c1111';
  function build(
    signupApp: string | null,
    extra: Record<string, string> = {},
    status = 'pending_deletion',
  ) {
    const mail = new MailService({
      get: (k: string) => ({ RESEND_API_KEY: 're_local', ...extra })[k],
    } as never);
    const prisma = {
      wawuUser: {
        findUnique: jest.fn().mockResolvedValue({
          id: ID,
          email: 'ada@example.test',
          firstName: 'Ada',
          emailVerified: true,
          phoneVerifiedAt: null,
          status,
          deletedAt: null,
          signupApp,
        }),
      },
      mailNotice: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    return new MailNoticeService(prisma as never, mail);
  }
  const dto = (
    kind: string,
    data: Record<string, unknown>,
    app?: 'voices',
  ) => ({
    wawuId: ID,
    kind,
    data,
    idempotencyKey: `key-${kind}-12345678`,
    ...(app ? { app } : {}),
  });

  it('sends the VOICES "going to be deleted" mail on a 14 day, Undo-only footing', async () => {
    const out = await build(null, {
      VOICES_MAIL_FROM: 'Voices <hello@example.test>',
    }).send(
      dto(
        'account_deletion_started',
        { deleteOn: '2026-11-26T09:30:00.000Z' },
        'voices',
      ),
    );
    expect(out).toEqual({ sent: true });
    expect(seen[0].subject).toBe(
      'We have received your request to delete your Voices account',
    );
    expect(seen[0].from).toBe('Voices <hello@example.test>');
    expect(seen[0].text).toContain('Undo');
  });

  it('sends the Who Made This? "deleted" mail to a person who signed up through VOICES when no app is named (12 Nov ruling)', async () => {
    await build('voices').send(dto('account_deleted', {}));
    expect(seen[0].subject).toBe('Your account has been deleted');
    expect(seen[0].html).not.toMatch(/usevoices\.com|Voices/);
    expect(seen[0].from).toBe('Who Made This? <noreply@wawuafrica.com>');
  });

  it('keeps the Who Made This? notice for everyone else, and for a money notice to a VOICES person', async () => {
    await build(null).send(dto('account_deleted', {}));
    expect(seen[0].subject).toBe('Your account has been deleted');
    seen = [];
    await build('voices', {}, 'active').send(
      dto('pin_changed', { at: '2026-11-14T18:05:00.000Z' }),
    );
    expect(seen[0].subject).toBe('Your transaction PIN was changed');
  });

  it('refuses app "voices" on a kind that has no VOICES version', async () => {
    await expect(
      build(null).send(
        dto('pin_changed', { at: '2026-11-14T18:05:00.000Z' }, 'voices'),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(seen).toHaveLength(0);
  });
});
