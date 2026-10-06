// AUTH-07 live-seam check: the mobile sign-up with an EMAIL code (and, behind the
// same setting, the old text), on the real wawu-id, built and started on this
// machine, against a LOCAL Postgres. Nothing leaves the computer:
//   - Resend is answered by a receiver on 127.0.0.1 (the SDK reads
//     RESEND_BASE_URL), which keeps every mail it is handed. The codes are read
//     from there, never from a log: the service logs no code.
//   - Fintava's `POST /sms/send` is answered by a second receiver that records
//     EVERY call made to it, so "no text is sent at sign-up" is a count of zero.
//
//   createdb a07_id_test
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/a07_id_test?schema=public \
//     npx prisma migrate deploy
//   npm run test:signup-email-local
//
// It makes its own throwaway RS256 keys, refuses any database that is not on
// this machine, and empties the scratch database (its name must contain
// a07_id_test).
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';

const DB =
  process.env.A07_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/a07_id_test?schema=public';
const ID_PORT = Number(process.env.A07_ID_PORT ?? 5101);
const ID = `http://127.0.0.1:${ID_PORT}`;

const isLocal = (url) => /@(localhost|127\.0\.0\.1)[:/]/.test(url);
if (!isLocal(DB) || !/a07_id_test/.test(DB)) {
  console.error(
    'Refusing to run: the database must be on this machine and its name must contain a07_id_test.',
  );
  process.exit(2);
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(
    `${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `  ${detail}`}`,
  );
  if (!cond) failures += 1;
};

// ── Resend stand-in: keeps every mail, can be told to refuse ─────────────────
const mailsHeld = [];
let resendStatus = 200;
const resend = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    mailsHeld.push({
      url: req.url,
      to: body.to,
      subject: body.subject,
      html: body.html,
    });
    res.writeHead(resendStatus, { 'content-type': 'application/json' });
    res.end(
      resendStatus === 200
        ? '{"id":"local_1"}'
        : '{"name":"application_error","message":"down","statusCode":500}',
    );
  });
});
await new Promise((r) => resend.listen(0, '127.0.0.1', r));
const RESEND_URL = `http://127.0.0.1:${resend.address().port}`;
const mailsTo = (address) =>
  mailsHeld.filter((m) => [].concat(m.to).includes(address));
const mailCode = (address) =>
  mailsTo(address)
    .at(-1)
    ?.html.match(/letter-spacing:10px;color:[^;"]+;">(\d{6})</)?.[1];

// ── Fintava stand-in: records EVERY call ─────────────────────────────────────
const fintavaCalls = [];
const fintava = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    fintavaCalls.push({ method: req.method, url: req.url, body: raw });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
await new Promise((r) => fintava.listen(0, '127.0.0.1', r));
const FINTAVA_URL = `http://127.0.0.1:${fintava.address().port}/api/dev`;
const texts = () =>
  fintavaCalls
    .filter((c) => c.url === '/api/dev/sms/send')
    .map((c) => JSON.parse(c.body));
const textCode = (phone) =>
  [...texts()]
    .reverse()
    .find((t) => t.to === phone)
    ?.sms.match(/\b(\d{6})\b/)[1];

const build = spawnSync('npx', ['nest', 'build'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const pool = new pg.Pool({ connectionString: DB.replace(/\?.*/, '') });
const sql = (text, params) => pool.query(text, params);
const log = [];
let server;

async function boot(env = {}) {
  log.length = 0;
  server = spawn('node', ['dist/main.js'], {
    env: {
      ...process.env,
      DATABASE_URL: DB,
      PORT: String(ID_PORT),
      RS256_PRIVATE_KEY: privateKey,
      RS256_PUBLIC_KEY: publicKey,
      JWT_EXPIRES_IN: '15m',
      REFRESH_EXPIRES_IN: '30d',
      INTERNAL_SERVICE_KEY: 'local-internal-key',
      RESEND_API_KEY: 're_local_only',
      RESEND_BASE_URL: RESEND_URL,
      MAIL_FROM: 'Local <local@example.test>',
      FINTAVA_BASE_URL: FINTAVA_URL,
      FINTAVA_API_KEY: 'local-test-key',
      PHONE_CODE_RESEND_SECONDS: '6',
      ...env,
    },
  });
  server.stdout.on('data', (d) => log.push(d.toString()));
  server.stderr.on('data', (d) => log.push(d.toString()));
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${ID}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (i > 80) throw new Error(`wawu-id did not start\n${log.join('')}`);
    await sleep(500);
  }
}
const halt = async () => {
  server.kill();
  await new Promise((r) => server.once('exit', r));
};

let ipCounter = 3000;
const newIp = () =>
  `10.${Math.floor(ipCounter / 65000)}.${Math.floor(ipCounter / 250) % 250}.${ipCounter++ % 250}`;
const call = async (method, path, body, token) => {
  const res = await fetch(`${ID}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-real-ip': newIp(),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const post = (path, body, token) => call('POST', path, body, token);
const get = (path, token) => call('GET', path, undefined, token);
const stamp = Date.now();
const password = 'choose-a-password';
const wrong = (c) => (c === '000000' ? '111111' : '000000');
const codesInLog = (...secrets) =>
  secrets.filter((s) => s && log.join('').includes(s));

try {
  await sql('select 1');
  await sql('truncate wawu_users, rate_counters, phone_guess_budgets cascade');

  // ═══ 1. the default: the code is mailed ════════════════════════════════════
  await boot();
  ok(
    'the service says where codes go',
    log.join('').includes('Sign-up codes go by email.'),
  );

  const email = `ada.${stamp}@example.test`;
  const phone = '+2348035550101';
  let r = await post('/auth/signup', {
    email,
    phone: '0803 555 0101',
    password,
    accountType: 'creator',
  });
  ok(
    'A3: sign-up answers 201 with the secret, channel email, the masked address and no session',
    r.status === 201 &&
      !!r.json.data.attempt &&
      r.json.data.channel === 'email' &&
      r.json.data.maskedEmail === 'a•••@example.test' &&
      r.json.data.emailCodeRequired === false &&
      r.json.data.expiresIn === 600 &&
      !r.json.data.accessToken,
    JSON.stringify(r.json),
  );
  const attempt = r.json.data.attempt;
  const code1 = mailCode(email);
  ok(
    'one mail went to the typed address, with a 6-digit code, through the mail stand-in',
    mailsTo(email).length === 1 && /^\d{6}$/.test(code1 ?? ''),
    JSON.stringify(mailsHeld.map((m) => [m.to, m.subject])),
  );
  ok(
    'no text message was sent (Fintava stand-in saw zero calls)',
    fintavaCalls.length === 0,
    JSON.stringify(fintavaCalls),
  );
  let row = (
    await sql(
      'select email_verified, phone_verified_at, phone from wawu_users where email = $1',
      [email],
    )
  ).rows[0];
  ok(
    'the account holds the typed phone, nothing proven yet',
    row.phone === phone &&
      row.email_verified === false &&
      row.phone_verified_at === null,
  );
  const pending = (
    await sql(
      'select channel, code_hash, attempt_hash from phone_verifications',
    )
  ).rows;
  ok(
    'the pending row says email and stores the code and the secret only as hashes',
    pending.length === 1 &&
      pending[0].channel === 'email' &&
      !JSON.stringify(pending).includes(code1) &&
      !JSON.stringify(pending).includes(attempt),
  );

  r = await post('/auth/login', { identifier: email, password });
  ok(
    'before the code, sign-in gives no session',
    r.status === 403 && !r.json.data && r.json.code === 'EMAIL_NOT_VERIFIED',
    JSON.stringify(r.json),
  );

  r = await post('/auth/signup/resume', { phone: '08035550101', attempt });
  ok(
    'quit after A3, come back: resume answers the code step with the masked address and the time left',
    r.status === 200 &&
      r.json.data.step === 'phone' &&
      r.json.data.channel === 'email' &&
      r.json.data.maskedEmail === 'a•••@example.test' &&
      r.json.data.expiresIn > 0 &&
      r.json.data.expiresIn <= 600 &&
      r.json.data.resendIn <= 6 &&
      r.json.data.accountType === 'creator' &&
      mailsTo(email).length === 1,
    JSON.stringify(r.json),
  );
  r = await post('/auth/signup/resume', { phone, attempt: 'made-up-secret' });
  ok(
    'a made-up secret answers details, the same as no sign-up',
    r.status === 200 &&
      r.json.data.step === 'details' &&
      Object.keys(r.json.data).length === 1,
  );

  r = await post('/auth/phone/verify/start', { phone, attempt });
  ok(
    'the phone-code routes answer 409 SIGNUP_CHANNEL_DISABLED',
    r.status === 409 && r.json.code === 'SIGNUP_CHANNEL_DISABLED',
    JSON.stringify(r.json),
  );
  r = await post('/auth/phone/verify/confirm', { phone, attempt, code: code1 });
  ok(
    '... and the mailed code does nothing there',
    r.status === 409 && r.json.code === 'SIGNUP_CHANNEL_DISABLED',
  );

  r = await post('/auth/signup/email-code/start', { phone, attempt });
  ok(
    'a resend inside the gap waits (429 with retryAfterSeconds)',
    r.status === 429 &&
      r.json.code === 'EMAIL_CODE_RESEND_TOO_SOON' &&
      r.json.retryAfterSeconds > 0,
    JSON.stringify(r.json),
  );
  await sleep(6500);
  r = await post('/auth/signup/email-code/start', { phone, attempt });
  await sleep(400);
  const code2 = mailCode(email);
  ok(
    'after the gap a resend mails a new code and answers the same shape',
    r.status === 200 &&
      r.json.data.channel === 'email' &&
      r.json.data.resendIn === 6 &&
      mailsTo(email).length === 2,
    JSON.stringify(r.json),
  );
  r = await post('/auth/signup/email-code/start', {
    phone,
    attempt: 'made-up-secret',
  });
  ok(
    'a made-up secret gets the same answer shape and no mail',
    r.status === 200 &&
      Object.keys(r.json.data).sort().join() ===
        'channel,expiresIn,phone,resendIn' &&
      mailsTo(email).length === 2,
    JSON.stringify(r.json),
  );

  for (let i = 0; i < 2; i++) {
    r = await post('/auth/signup/email-code/confirm', {
      phone,
      attempt,
      code: wrong(code2),
    });
    ok(
      `A15: wrong code ${i + 1} answers 400 EMAIL_CODE_INVALID "That code isn't right"`,
      r.status === 400 &&
        r.json.code === 'EMAIL_CODE_INVALID' &&
        r.json.message === "That code isn't right",
      JSON.stringify(r.json),
    );
  }
  r = await post('/auth/signup/email-code/confirm', {
    phone,
    attempt,
    code: code1,
  });
  ok(
    'the first code stopped working when the second was mailed',
    code1 === code2 ||
      (r.status === 400 && r.json.code === 'EMAIL_CODE_INVALID'),
    JSON.stringify(r.json),
  );

  r = await post('/auth/signup/email-code/confirm', {
    phone: '08035550101',
    attempt,
    code: code2,
  });
  ok(
    'A4: the right code (and the phone typed the local way) gives the first session',
    r.status === 200 &&
      !!r.json.data.accessToken &&
      !!r.json.data.refreshToken &&
      r.json.data.user.email === email &&
      r.json.data.user.accountType === 'creator',
    JSON.stringify(r.json),
  );
  const access = r.json.data.accessToken;
  row = (
    await sql(
      'select email_verified, phone_verified_at from wawu_users where email = $1',
      [email],
    )
  ).rows[0];
  ok(
    'the EMAIL is proven, the PHONE is not',
    row.email_verified === true && row.phone_verified_at === null,
    JSON.stringify(row),
  );
  ok(
    'nothing is pending any more, and the account is in the sign-up sequence',
    (await sql('select 1 from phone_verifications')).rowCount === 0 &&
      (await sql('select 1 from signup_progress')).rowCount === 1,
  );
  r = await post('/auth/signup/email-code/confirm', {
    phone,
    attempt,
    code: code2,
  });
  ok(
    'the same code again is refused (400 EMAIL_CODE_INVALID)',
    r.status === 400 && r.json.code === 'EMAIL_CODE_INVALID',
    JSON.stringify(r.json),
  );

  r = await get('/auth/signup/progress', access);
  ok(
    'the progress after A4 skips the email step: a creator goes to A11',
    r.status === 200 &&
      r.json.data.step === 'creator_setup' &&
      r.json.data.inSequence === true &&
      r.json.data.emailProven === true,
    JSON.stringify(r.json),
  );
  r = await post('/auth/signup/email/start', undefined, access);
  ok(
    'the old email step answers 409 EMAIL_ALREADY_PROVEN',
    r.status === 409 && r.json.code === 'EMAIL_ALREADY_PROVEN',
    JSON.stringify(r.json),
  );
  r = await post('/auth/signup/progress', { step: 'creator_setup' }, access);
  ok(
    'A11 completes the sequence',
    r.status === 200 && r.json.data.step === 'done',
  );

  r = await post('/auth/login', { identifier: email, password });
  ok(
    'sign-in by email works afterwards',
    r.status === 200 && !!r.json.data.accessToken,
    JSON.stringify(r.json),
  );
  r = await post('/auth/login', { identifier: '08035550101', password });
  ok(
    'sign-in by the phone typed the local way works too',
    r.status === 200 && !!r.json.data.accessToken,
    JSON.stringify(r.json),
  );

  // lockout: the fourth wrong code in a row waits
  const email2 = `bola.${stamp}@example.test`;
  const phone2 = '+2348035550102';
  r = await post('/auth/signup', {
    email: email2,
    phone: '08035550102',
    password,
  });
  const attempt2 = r.json.data.attempt;
  const real2 = mailCode(email2);
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    r = await post('/auth/signup/email-code/confirm', {
      phone: phone2,
      attempt: attempt2,
      code: wrong(real2),
    });
    statuses.push(`${r.status}:${r.json.code}`);
  }
  ok(
    'four wrong codes in a row: 400, 400, 400, then 429 EMAIL_CODE_LOCKED with the wait',
    statuses.join() ===
      '400:EMAIL_CODE_INVALID,400:EMAIL_CODE_INVALID,400:EMAIL_CODE_INVALID,429:EMAIL_CODE_LOCKED' &&
      r.json.retryAfterSeconds > 0,
    statuses.join() + JSON.stringify(r.json),
  );
  r = await post('/auth/signup/email-code/confirm', {
    phone: phone2,
    attempt: attempt2,
    code: real2,
  });
  ok(
    'even the right code waits while locked',
    r.status === 429 && r.json.code === 'EMAIL_CODE_LOCKED',
  );

  // a second sign-up for an email an account holds
  const mailsBeforeClash = mailsHeld.length;
  r = await post('/auth/signup', {
    email,
    phone: '08035550199',
    password,
  });
  ok(
    'an email an account already holds answers 409 and mails nothing',
    r.status === 409 && mailsHeld.length === mailsBeforeClash,
    JSON.stringify(r.json),
  );

  ok(
    'no text message was sent in the whole mailed flow (zero Fintava calls)',
    fintavaCalls.length === 0,
    JSON.stringify(fintavaCalls),
  );
  ok(
    'the log of the whole mailed flow holds no code and no secret',
    codesInLog(code1, code2, real2, attempt, attempt2).length === 0,
    JSON.stringify(codesInLog(code1, code2, real2, attempt, attempt2)),
  );
  await halt();

  // ═══ 2. mail that cannot go out ════════════════════════════════════════════
  await boot();
  resendStatus = 500;
  const email3 = `chi.${stamp}@example.test`;
  r = await post('/auth/signup', {
    email: email3,
    phone: '08035550103',
    password,
  });
  ok(
    'Resend answering an error gives 503 EMAIL_SEND_FAILED (never a quiet "sent")',
    r.status === 503 && r.json.code === 'EMAIL_SEND_FAILED',
    JSON.stringify(r.json),
  );
  resendStatus = 200;
  r = await post('/auth/signup', {
    email: email3,
    phone: '08035550103',
    password,
  });
  ok(
    'and the person may ask again at once (nothing is held against them)',
    r.status === 201 && !!mailCode(email3),
    JSON.stringify(r.json),
  );
  await halt();

  await boot({ RESEND_API_KEY: '' });
  const before = mailsHeld.length;
  r = await post('/auth/signup', {
    email: `dayo.${stamp}@example.test`,
    phone: '08035550104',
    password,
  });
  ok(
    'with no mail transport sign-up answers 503 EMAIL_NOT_CONFIGURED and writes no account',
    r.status === 503 &&
      r.json.code === 'EMAIL_NOT_CONFIGURED' &&
      (
        await sql('select 1 from wawu_users where phone = $1', [
          '+2348035550104',
        ])
      ).rowCount === 0 &&
      mailsHeld.length === before,
    JSON.stringify(r.json),
  );
  await halt();

  // ═══ 3. the rollback: SIGNUP_VERIFY_CHANNEL=sms ════════════════════════════
  await boot({ SIGNUP_VERIFY_CHANNEL: 'sms' });
  ok(
    'the service says codes go by sms',
    log.join('').includes('Sign-up codes go by sms.'),
  );
  const mailsBefore = mailsHeld.length;
  const email4 = `emeka.${stamp}@example.test`;
  const phone4 = '+2348035550105';
  r = await post('/auth/signup', {
    email: email4,
    phone: '08035550105',
    password,
  });
  const attempt4 = r.json.data?.attempt;
  ok(
    'sms: sign-up answers as it always did (no channel field) and texts one code',
    r.status === 201 &&
      !('channel' in r.json.data) &&
      !('maskedEmail' in r.json.data) &&
      r.json.data.expiresIn === 300 &&
      texts().length === 1 &&
      texts()[0].to === phone4 &&
      mailsHeld.length === mailsBefore,
    JSON.stringify(r.json),
  );
  r = await post('/auth/signup/email-code/start', {
    phone: phone4,
    attempt: attempt4,
  });
  ok(
    'sms: the email-code routes answer 409 SIGNUP_CHANNEL_DISABLED',
    r.status === 409 && r.json.code === 'SIGNUP_CHANNEL_DISABLED',
    JSON.stringify(r.json),
  );
  r = await post('/auth/signup/resume', { phone: phone4, attempt: attempt4 });
  ok(
    'sms: resume answers the old shape',
    r.status === 200 &&
      r.json.data.step === 'phone' &&
      !('channel' in r.json.data) &&
      r.json.data.expiresIn <= 300,
    JSON.stringify(r.json),
  );
  r = await post('/auth/phone/verify/confirm', {
    phone: phone4,
    attempt: attempt4,
    code: textCode(phone4),
  });
  ok(
    'sms: the texted code gives the first session, as before',
    r.status === 200 && !!r.json.data.accessToken,
    JSON.stringify(r.json),
  );
  row = (
    await sql(
      'select email_verified, phone_verified_at from wawu_users where email = $1',
      [email4],
    )
  ).rows[0];
  ok(
    'sms: the PHONE is proven, the email is not, and no sequence row is made at confirm',
    row.phone_verified_at !== null &&
      row.email_verified === false &&
      (
        await sql(
          'select 1 from signup_progress sp join wawu_users u on u.id = sp.user_id where u.email = $1',
          [email4],
        )
      ).rowCount === 0,
    JSON.stringify(row),
  );
  r = await get('/auth/signup/progress', r.json.data.accessToken);
  ok(
    'sms: the next step is the email step, as before',
    r.status === 200 && r.json.data.step === 'email',
    JSON.stringify(r.json),
  );

  // a sign-up started under email is answered `details` once sms is active
  await halt();
  await boot();
  const email5 = `femi.${stamp}@example.test`;
  r = await post('/auth/signup', {
    email: email5,
    phone: '08035550106',
    password,
  });
  const attempt5 = r.json.data.attempt;
  const code5 = mailCode(email5);
  await halt();
  await boot({ SIGNUP_VERIFY_CHANNEL: 'sms' });
  r = await post('/auth/signup/resume', {
    phone: '+2348035550106',
    attempt: attempt5,
  });
  ok(
    'switching to sms while a mailed sign-up waits: resume answers details',
    r.status === 200 && r.json.data.step === 'details',
    JSON.stringify(r.json),
  );
  r = await post('/auth/phone/verify/confirm', {
    phone: '+2348035550106',
    attempt: attempt5,
    code: code5,
  });
  ok(
    '... and the mailed code does not prove the phone',
    r.status === 400 && r.json.code === 'PHONE_CODE_INVALID',
    JSON.stringify(r.json),
  );
  ok(
    'the log of the sms run holds no code and no secret either',
    codesInLog(code5, attempt4, attempt5, textCode(phone4)).length === 0,
  );
} catch (err) {
  console.error(err);
  failures += 1;
} finally {
  if (server && server.exitCode === null) await halt();
  await pool.end();
  resend.close();
  fintava.close();
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
