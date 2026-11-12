import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication, Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';
import { MailModule } from '../mail/mail.module';
import { MailService } from '../mail/mail.service';
import { mailAppFor } from '../mail/voices/mail-app';
import { AuthService } from './auth.service';

/**
 * VOICES-MAIL (V-44, Ma1): account mails for a VOICES request (or a VOICES
 * person) come in VOICES' look, words and links; everyone else's are as they
 * were (wmt-golden.spec.ts holds the bytes). The real mailer runs against a
 * local stand-in for Resend; nothing leaves this machine.
 */
type Sent = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
};

describe('VOICES account mails', () => {
  let server: Server;
  let seen: Sent[];
  const before = process.env.RESEND_BASE_URL;
  const WMT_FROM = 'Who Made This? <noreply@wawuafrica.com>';

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

  const settings = (extra: Record<string, string> = {}) => ({
    get: (k: string) =>
      ({
        RESEND_API_KEY: 're_local',
        FRONTEND_URL: 'https://wmt.example.test',
        ...extra,
      })[k],
  });
  const mailer = (extra: Record<string, string> = {}) =>
    new MailService(settings(extra) as never);

  const user = (over: Record<string, unknown> = {}) => ({
    id: 'u1',
    email: 'ada@example.test',
    firstName: 'Ada',
    phone: '+2348031234412',
    emailVerified: false,
    phoneVerifiedAt: null,
    status: 'active',
    deletedAt: null,
    passwordHash: 'x',
    signupApp: null,
    phoneVerification: null,
    signupProgress: null,
    ...over,
  });

  function authFor(row: Record<string, unknown>, mail: MailService) {
    const ref: { tx?: unknown } = {};
    const prisma = {
      wawuUser: {
        findUnique: jest.fn().mockResolvedValue(row),
        findFirst: jest.fn().mockResolvedValue(row),
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ ...row, ...data }),
          ),
        update: jest.fn().mockResolvedValue({ ...row, emailVerified: true }),
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({}),
      },
      emailVerificationCode: {
        deleteMany: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn(),
        delete: jest.fn().mockResolvedValue({}),
      },
      passwordResetToken: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({}),
      },
      refreshToken: { deleteMany: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn((ops: unknown) =>
        typeof ops === 'function'
          ? (ops as (tx: unknown) => unknown)(ref.tx)
          : Promise.all(ops as Promise<unknown>[]),
      ),
    };
    ref.tx = prisma;
    const tokens = {
      issueTokens: jest
        .fn()
        .mockResolvedValue({ accessToken: 'a', refreshToken: 'r' }),
    };
    const auth = new AuthService(
      prisma as never,
      tokens as never,
      { verify: jest.fn().mockResolvedValue(true) } as never,
      mail,
      settings() as never,
    );
    return { auth, prisma };
  }

  const createdApp = (create: jest.Mock): unknown =>
    (create.mock.calls[0] as Array<{ data: { signupApp: unknown } }>)[0].data
      .signupApp;
  const settle = () => new Promise((r) => setTimeout(r, 30));
  // The logos are served by WAWU ID itself (owner's ruling, 12 Nov), so their address is allowed.
  const visible = (s: Sent) =>
    `${s.subject}\n${s.html.replace(/src="[^"]*"/g, '')}\n${s.text}`;
  const assertVoicesOnly = (s: Sent) => {
    expect(s.html).toContain('usevoices.com');
    expect(visible(s)).not.toMatch(
      /Who Made This|wawuafrica|WAWUAfrica|support@usevoices/i,
    );
    expect(visible(s)).not.toContain('—');
    expect(visible(s)).not.toMatch(/\{\{|undefined|\[REGISTERED/);
    expect(s.text.length).toBeGreaterThan(40);
    expect(s.text).not.toMatch(/<[a-z!/]/i);
  };

  it('sends the VOICES code mail for a VOICES request: the 6 digits, 5 minutes, no link to click', async () => {
    const { auth } = authFor(user(), mailer());
    await auth.emailVerifyStart('ada@example.test', 'voices');
    expect(seen).toHaveLength(1);
    const m = seen[0];
    expect(m.subject).toBe('Confirm your email for Voices');
    const code =
      /letter-spacing:10px;color:#002B1A;" class="codetx">(\d{6})</.exec(
        m.html,
      )?.[1];
    expect(code).toMatch(/^\d{6}$/);
    expect(m.text.split('\n')).toContain(code);
    expect(m.html).toContain('expires in 5 minutes');
    expect(m.html).toContain('Hi Ada, use this code to confirm');
    // the only links are the logo home, the support address-free footer and the legal pages
    const hrefs = [...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
    expect(hrefs.filter((h) => /reset|confirm|verify|token/.test(h))).toEqual(
      [],
    );
    expect(m.from).toBe(WMT_FROM);
    assertVoicesOnly(m);
  });

  it('keeps the current sender unless VOICES_MAIL_FROM is set, then switches with no code change', async () => {
    await authFor(
      user(),
      mailer({ VOICES_MAIL_FROM: 'Voices <hello@example.test>' }),
    ).auth.emailVerifyStart('ada@example.test', 'voices');
    expect(seen[0].from).toBe('Voices <hello@example.test>');
    seen = [];
    await authFor(
      user(),
      mailer({ VOICES_MAIL_FROM: 'Voices <hello@example.test>' }),
    ).auth.emailVerifyStart('ada@example.test');
    expect(seen[0].from).toBe(WMT_FROM);
    expect(seen[0].subject).toBe('Your Who Made This? verification code');
  });

  it('sends the Who Made This? code mail when no app is named and the person did not sign up through VOICES', async () => {
    await authFor(user(), mailer()).auth.emailVerifyStart('ada@example.test');
    expect(seen[0].subject).toBe('Your Who Made This? verification code');
    expect(seen[0].html).toContain('This code expires in 10 minutes');
  });

  it('treats a person who signed up through VOICES as a VOICES person where the request names no app', async () => {
    await authFor(
      user({ signupApp: 'voices' }),
      mailer(),
    ).auth.emailVerifyStart('ada@example.test');
    expect(seen[0].subject).toBe('Confirm your email for Voices');
    expect(mailAppFor(undefined, 'voices')).toBe('voices');
    expect(mailAppFor('voices', null)).toBe('voices');
    expect(mailAppFor(undefined, null)).toBeUndefined();
    expect(mailAppFor('other', 'voices')).toBeUndefined();
  });

  it('remembers the sign-up app on register, and only for voices', async () => {
    const dto = {
      email: 'New@Example.test',
      phone: '+2348030000001',
      country: 'Nigeria',
      password: 'a-long-password',
      fullName: 'Ada Obi',
    };
    const a = authFor(null as never, mailer());
    a.prisma.wawuUser.findFirst.mockResolvedValue(null);
    await a.auth.register({ ...dto, app: 'voices' } as never);
    expect(createdApp(a.prisma.wawuUser.create)).toBe('voices');
    const b = authFor(null as never, mailer());
    b.prisma.wawuUser.findFirst.mockResolvedValue(null);
    await b.auth.register(dto);
    expect(createdApp(b.prisma.wawuUser.create)).toBeNull();
  });

  it('mails a VOICES reset link that opens usevoices.com, and a Who Made This? one that opens its own site', async () => {
    const row = user({ emailVerified: true });
    await authFor(row, mailer()).auth.forgotPassword(
      'ada@example.test',
      'email',
      'voices',
    );
    const v = seen[0];
    expect(v.subject).toBe('Reset your Voices password');
    const link =
      /href="(https:\/\/usevoices\.com\/reset-password\?token=[0-9a-f]{64}&amp;email=ada%40example\.test)"/.exec(
        v.html,
      )?.[1];
    expect(link).toBeDefined();
    expect(v.text).toContain('https://usevoices.com/reset-password?token=');
    expect(v.html).toContain(
      'This link works for 1 hour and can only be used once',
    );
    assertVoicesOnly(v);
    seen = [];
    await authFor(row, mailer()).auth.forgotPassword(
      'ada@example.test',
      'email',
    );
    expect(seen[0].html).toContain(
      'https://wmt.example.test/reset-password?token=',
    );
    expect(seen[0].html).not.toContain('usevoices.com');
  });

  it('sends the VOICES password-changed mail after a reset, naming no device or place', async () => {
    const row = user({ emailVerified: true });
    const { auth, prisma } = authFor(row, mailer());
    const raw = 'a-reset-token';
    prisma.passwordResetToken.findMany.mockResolvedValue([
      {
        tokenHash: await argon2.hash(raw),
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    await auth.resetPassword({
      token: raw,
      email: 'ada@example.test',
      password: 'a-new-password-1',
      app: 'voices',
    });
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0].subject).toBe('Your Voices password was changed');
    expect(seen[0].html).toContain('https://usevoices.com/forgot-password');
    expect(seen[0].html).not.toMatch(/>Device<|Approximate place/);
    assertVoicesOnly(seen[0]);
  });

  it('sends the VOICES welcome once the code proves the email, and the VOICES sign-in alert', async () => {
    const row = user({ signupApp: 'voices' });
    const { auth, prisma } = authFor(row, mailer());
    prisma.emailVerificationCode.findFirst.mockResolvedValue({
      id: 'c1',
      codeHash: await argon2.hash('123456'),
    });
    await auth.emailVerifyConfirm('ada@example.test', '123456');
    await settle();
    expect(seen[0].subject).toBe('Welcome to Voices, Ada');
    assertVoicesOnly(seen[0]);
    expect(seen[0].html).toContain('You are in, Ada.');
    const m = mailer();
    seen = [];
    await m.sendLoginAlert(
      'ada@example.test',
      'x',
      'Ada',
      new Date('2026-11-10T09:30:00Z'),
      'voices',
    );
    expect(seen[0].subject).toBe('New sign-in to your Voices account');
    expect(seen[0].html).not.toMatch(
      />Device<|Approximate place|new device|not seen before/i,
    );
    assertVoicesOnly(seen[0]);
  });

  it('renders the two VOICES deletion notices with the 14 day, Undo-only words', () => {
    const m = mailer();
    const a = m.renderVoicesNotice(
      'account_deletion_started',
      { deleteOn: '2026-11-26T09:30:00.000Z' },
      'Ada',
    );
    expect(a.subject).toBe(
      'We have received your request to delete your Voices account',
    );
    expect(a.html).toContain('tap Undo before');
    expect(a.html).toContain('Signing in again does not cancel it');
    expect(a.html).toContain('https://usevoices.com/profile');
    const b = m.renderVoicesNotice('account_deleted', {});
    expect(b.subject).toBe('Your Voices account has been deleted');
    for (const x of [a, b]) {
      const s = { from: '', to: '', ...x };
      assertVoicesOnly(s);
    }
  });

  it('serves the four VOICES logos beside the header picture, and nothing else', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        MailModule,
      ],
    }).compile();
    const app: INestApplication = moduleRef.createNestApplication();
    await app.init();
    const get = (path: string) =>
      request(app.getHttpServer() as Parameters<typeof request>[0]).get(path);
    const res = await get('/assets/voices/logo-wordmark-white.png');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(
      Buffer.from(res.body as Buffer).equals(
        readFileSync(
          join(
            __dirname,
            '..',
            'mail',
            'assets',
            'voices',
            'logo-wordmark-white.png',
          ),
        ),
      ),
    ).toBe(true);
    expect((await get('/assets/voices/secret.png')).status).toBe(404);
    expect((await get('/assets/voices/..%2Femail-header.png')).status).toBe(
      404,
    );
    await app.close();
  });
});
