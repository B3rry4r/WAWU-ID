// AUTH-05 live-seam check: the sign-up sequence on the real wawu-id, built and
// started on this machine, against a LOCAL Postgres, with Fintava's
// `POST /sms/send` answered by a receiver on 127.0.0.1. Nothing leaves the
// computer, no text is sent and no mail is sent (without RESEND_API_KEY the
// service writes each mail's code to its log, which this reads).
//
//   createdb wawu_id_auth05
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/wawu_id_auth05?schema=public \
//     npx prisma migrate deploy
//   npm run test:signup-local
//
// Optional, to check the Hub side as well (a local Hub on its own database,
// trusting this wawu-id's JWKS): HUB_URL=http://127.0.0.1:<port>
// HUB_DATABASE_URL=postgresql://...localhost.../<hub db>.
//
// It reads the local-only RS256 keys from ./.env (written by wawu-backend's
// scripts/local/up.sh) and ignores that file's DATABASE_URL and mail key. It
// refuses any database that is not on this machine, and it empties the
// scratch database (its name must contain auth05).
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import dotenv from 'dotenv';
import pg from 'pg';

const DB =
  process.env.AUTH05_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_id_auth05?schema=public';
const ID_PORT = 3492;
const SMS_PORT = 3493;
const ID = `http://127.0.0.1:${ID_PORT}`;
const HUB = process.env.HUB_URL;
const HUB_DB = process.env.HUB_DATABASE_URL;

const isLocal = (url) => /@(localhost|127\.0\.0\.1)[:/]/.test(url);
if (!isLocal(DB) || !/auth05/.test(DB) || (HUB_DB && !isLocal(HUB_DB))) {
  console.error(
    'Refusing to run: every database must be on this machine, and the wawu-id one must contain auth05.',
  );
  process.exit(2);
}
if (HUB && !/^http:\/\/(127\.0\.0\.1|localhost):/.test(HUB)) {
  console.error('Refusing to run: HUB_URL must be a local address.');
  process.exit(2);
}

const local = dotenv.parse(readFileSync('.env'));
let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(
    `${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `  ${detail}`}`,
  );
  if (!cond) failures += 1;
};

// ── the local stand-in for Fintava: it records EVERY call made to it ─────────
const calls = [];
const receiver = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    calls.push({ method: req.method, url: req.url, body: raw });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
await new Promise((r) => receiver.listen(SMS_PORT, '127.0.0.1', r));
const texts = () =>
  calls
    .filter((c) => c.url === '/api/dev/sms/send')
    .map((c) => JSON.parse(c.body));
const codeFor = (phone) =>
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
      ...local,
      DATABASE_URL: DB,
      PORT: String(ID_PORT),
      RESEND_API_KEY: '',
      FINTAVA_BASE_URL: `http://127.0.0.1:${SMS_PORT}/api/dev`,
      FINTAVA_API_KEY: 'local-test-key',
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
    if (i > 60) throw new Error(`wawu-id did not start\n${log.join('')}`);
    await sleep(500);
  }
}
const halt = async () => {
  server.kill();
  await new Promise((r) => server.once('exit', r));
};

let ipCounter = 2000;
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
const mails = (address) =>
  log
    .join('')
    .split('\n')
    .filter((l) => l.includes(`[mail skipped] to=${address} `));
const mailCode = (address) =>
  mails(address)
    .at(-1)
    ?.match(/code=(\d{6})/)?.[1];
const stamp = Date.now();
const password = 'choose-a-password';
const wrong = (c) => (c === '000000' ? '111111' : '000000');

try {
  await sql('select 1');
  await sql('truncate wawu_users, rate_counters, phone_guess_budgets cascade');
  await boot();

  // ── 1. A discovering account: A2, A3, quit, resume at A4 ───────────────────
  const email = `ada.${stamp}@example.test`;
  const phone = '+2348035550101';
  let r = await post('/auth/signup', {
    email,
    phone: '0803 555 0101',
    password,
    accountType: 'user',
  });
  ok(
    'A3: sign-up answers 201 with the secret and no session',
    r.status === 201 && !!r.json.data.attempt && !r.json.data.accessToken,
    JSON.stringify(r.json),
  );
  const attempt = r.json.data.attempt;
  const textsAfterSignup = texts().length;

  r = await post('/auth/signup/resume', { phone: '08035550101', attempt });
  ok(
    'quit after A3, come back: resume answers the phone step with the time left, the type picked, and sends nothing',
    r.status === 200 &&
      r.json.data.step === 'phone' &&
      r.json.data.phone === phone &&
      r.json.data.expiresIn > 0 &&
      r.json.data.expiresIn <= 300 &&
      r.json.data.resendIn >= 0 &&
      r.json.data.resendIn <= 60 &&
      r.json.data.accountType === 'user' &&
      r.json.data.emailCodeRequired === false &&
      texts().length === textsAfterSignup,
    JSON.stringify(r.json),
  );
  r = await post('/auth/signup/resume', { phone, attempt: 'made-up-secret' });
  ok(
    'resume with a made-up secret answers details, the same as no sign-up',
    r.status === 200 &&
      r.json.data.step === 'details' &&
      Object.keys(r.json.data).length === 1,
    JSON.stringify(r.json),
  );
  r = await get('/auth/signup/progress');
  ok(
    'before the phone code there is no session: progress answers 401',
    r.status === 401 && r.json.code === 'SESSION_INVALID',
    JSON.stringify(r.json),
  );
  r = await post('/auth/login', { identifier: email, password });
  ok(
    'before the phone code sign-in gives no session (AUTH-03, unchanged)',
    r.status === 403 && !r.json.data,
    JSON.stringify(r.json),
  );

  r = await post('/auth/phone/verify/confirm', {
    phone,
    attempt,
    code: codeFor(phone),
  });
  ok(
    'A4: the code from the text, with the secret, gives the first session',
    r.status === 200 && !!r.json.data.accessToken,
    JSON.stringify(r.json),
  );
  let access = r.json.data.accessToken;
  const refresh = r.json.data.refreshToken;
  r = await post('/auth/signup/resume', { phone, attempt });
  ok(
    'resume after the code answers details (nothing left before the session)',
    r.status === 200 && r.json.data.step === 'details',
  );

  r = await get('/auth/signup/progress', access);
  ok(
    'after A4 the next step is the email, then A12 and A13',
    r.status === 200 &&
      r.json.data.step === 'email' &&
      r.json.data.inSequence === true &&
      JSON.stringify(r.json.data.steps) === '["email","interests","follows"]' &&
      r.json.data.emailProven === false,
    JSON.stringify(r.json),
  );
  r = await get('/auth/signup/progress', refresh);
  ok('a refresh token opens nothing here', r.status === 401);
  r = await post('/auth/signup/progress', { step: 'interests' }, access);
  ok(
    'A12 before the email step is refused (409 SIGNUP_STEP_OUT_OF_ORDER)',
    r.status === 409 && r.json.code === 'SIGNUP_STEP_OUT_OF_ORDER',
    JSON.stringify(r.json),
  );

  // ── 2. The email step, and the reset path it opens (G-27) ──────────────────
  await post('/auth/forgot-password', { identifier: email, method: 'email' });
  await sleep(300);
  ok(
    'before the email is proven, a reset request mails nothing (AUTH-01, unchanged)',
    mails(email).length === 0,
    mails(email).join('|'),
  );
  r = await post('/auth/signup/email/start', undefined, access);
  await sleep(300);
  ok(
    "the email step mails a code to the account's own email",
    r.status === 200 &&
      r.json.data.email === email &&
      r.json.data.expiresIn === 600 &&
      mails(email).length === 1 &&
      !!mailCode(email),
    JSON.stringify(r.json),
  );
  const emailCode = mailCode(email);
  const stored = await sql('select * from signup_email_codes');
  ok(
    'the code and the address are stored only as hashes',
    stored.rows.length === 1 &&
      !JSON.stringify(stored.rows).includes(emailCode) &&
      !JSON.stringify(stored.rows).includes(email),
  );
  r = await post('/auth/signup/email/start', undefined, access);
  ok(
    'another email code within the gap waits (429 with retryAfterSeconds)',
    r.status === 429 &&
      r.json.code === 'EMAIL_CODE_RESEND_TOO_SOON' &&
      r.json.retryAfterSeconds > 0,
    JSON.stringify(r.json),
  );
  r = await post(
    '/auth/signup/email/confirm',
    { code: wrong(emailCode) },
    access,
  );
  ok(
    'a wrong email code answers 400 EMAIL_CODE_INVALID',
    r.status === 400 && r.json.code === 'EMAIL_CODE_INVALID',
    JSON.stringify(r.json),
  );
  r = await post('/auth/signup/email/confirm', { code: emailCode }, access);
  ok(
    'the right email code proves it, and the next step is A12',
    r.status === 200 &&
      r.json.data.step === 'interests' &&
      r.json.data.emailProven === true,
    JSON.stringify(r.json),
  );
  await post('/auth/forgot-password', { identifier: email, method: 'email' });
  await sleep(300);
  ok(
    'once proven, a reset request mails the link (the reset path G-27 asked for)',
    mails(email).some((l) =>
      l.includes('subject="It Happens To The Best Of Us"'),
    ),
    mails(email).join('|'),
  );

  // ── 3. Quit after the email step, sign in again: resumes at A12 ────────────
  r = await post('/auth/login', { identifier: email, password });
  access = r.json.data?.accessToken;
  r = await get('/auth/signup/progress', access);
  ok(
    'signing in again resumes at the next step (A12)',
    r.status === 200 && r.json.data.step === 'interests',
    JSON.stringify(r.json),
  );
  r = await post('/auth/signup/progress', { step: 'follows' }, access);
  ok(
    'A13 before A12 is refused',
    r.status === 409 && r.json.code === 'SIGNUP_STEP_OUT_OF_ORDER',
  );
  r = await post('/auth/signup/progress', { step: 'creator_setup' }, access);
  ok(
    "A11 is not a discovering account's step",
    r.status === 409 && r.json.code === 'SIGNUP_STEP_OUT_OF_ORDER',
  );
  r = await post('/auth/signup/progress', { step: 'interests' }, access);
  ok(
    'A12 done: the next step is A13',
    r.status === 200 && r.json.data.step === 'follows',
  );
  const twice = await Promise.all([
    post('/auth/signup/progress', { step: 'follows' }, access),
    post('/auth/signup/progress', { step: 'follows' }, access),
  ]);
  ok(
    'A13 done (two taps at once): done, once',
    twice.every((x) => x.status === 200 && x.json.data.step === 'done'),
    twice.map((x) => x.status).join(),
  );
  const row = await sql(
    'select p.* from signup_progress p join wawu_users u on u.id = p.user_id where u.email = $1',
    [email],
  );
  ok(
    'the record shows each step and the time the sequence finished',
    !!row.rows[0]?.interests_at &&
      !!row.rows[0]?.follows_at &&
      !!row.rows[0]?.completed_at &&
      !!row.rows[0]?.email_skipped_at === false,
  );

  // ── 4. An earning account: email put off, then A11 ─────────────────────────
  const cEmail = `chidi.${stamp}@example.test`;
  const cPhone = '+2348035550202';
  r = await post('/auth/signup', {
    email: cEmail,
    phone: cPhone,
    password,
    accountType: 'creator',
  });
  const cAttempt = r.json.data.attempt;
  r = await post('/auth/phone/verify/confirm', {
    phone: cPhone,
    attempt: cAttempt,
    code: codeFor(cPhone),
  });
  const cAccess = r.json.data.accessToken;
  const creatorId = r.json.data.user.id;
  ok(
    'the sign-in answer carries the account type the app picks A11 by',
    r.json.data.user.accountType === 'creator',
  );
  r = await get('/auth/signup/progress', cAccess);
  ok(
    'an earning account goes email, then A11',
    JSON.stringify(r.json.data.steps) === '["email","creator_setup"]' &&
      r.json.data.step === 'email',
  );
  r = await post('/auth/signup/progress', { step: 'creator_setup' }, cAccess);
  ok('A11 before the email step is refused', r.status === 409);
  r = await post('/auth/signup/progress', { step: 'email' }, cAccess);
  ok(
    '"Later" on the email step moves on to A11',
    r.status === 200 &&
      r.json.data.step === 'creator_setup' &&
      r.json.data.emailProven === false,
  );
  r = await post('/auth/signup/progress', { step: 'creator_setup' }, cAccess);
  ok(
    'A11 done: the sign-up is done',
    r.status === 200 && r.json.data.step === 'done',
  );

  // ── 5. No wallet and no identity check during sign-up (R-6) ────────────────
  const other = calls.filter((c) => c.url !== '/api/dev/sms/send');
  ok(
    'wawu-id made no call to Fintava but texts (no BVN, NIN, selfie, customer or wallet)',
    other.length === 0,
    JSON.stringify(other),
  );
  if (HUB && HUB_DB) {
    const hub = new pg.Pool({ connectionString: HUB_DB.replace(/\?.*/, '') });
    const me = await fetch(`${HUB}/api/hub/users/me`, {
      headers: { authorization: `Bearer ${cAccess}` },
    });
    ok(
      'the Hub accepts the sign-up session',
      me.status === 200,
      String(me.status),
    );
    const counts = {};
    for (const t of [
      'CreatorWallet',
      'FintavaWallet',
      'WalletIdentity',
      'KycSubmission',
      'BvnCheckAttempt',
      'SelfieMatchAttempt',
    ]) {
      const q = await hub
        .query(
          `select count(*)::int as n from "${t}" where "wawuUserId" = $1`,
          [creatorId],
        )
        .catch((e) => ({ rows: [{ n: `error: ${e.message}` }] }));
      counts[t] = q.rows[0].n;
    }
    ok(
      'the Hub holds no wallet and no identity check for the new earning account',
      Object.values(counts).every((n) => n === 0),
      JSON.stringify(counts),
    );
    await hub.end();
  } else {
    console.log(
      'NOT RUN  the Hub side (set HUB_URL and HUB_DATABASE_URL to a local Hub)',
    );
  }

  // ── 6. Accounts outside the sequence ───────────────────────────────────────
  const wEmail = `web.${stamp}@example.test`;
  r = await post('/auth/register', {
    email: wEmail,
    phone: '08035550303',
    password,
    firstName: 'Web',
    lastName: 'User',
    country: 'NG',
  });
  const wAccess = r.json.data?.accessToken;
  r = await get('/auth/signup/progress', wAccess);
  ok(
    'a web account is outside the sequence: done, nothing to finish',
    r.status === 200 &&
      r.json.data.step === 'done' &&
      r.json.data.inSequence === false,
  );
  r = await post('/auth/signup/progress', { step: 'email' }, wAccess);
  ok(
    'and has no step to complete',
    r.status === 409 && r.json.code === 'SIGNUP_ALREADY_FINISHED',
  );
  const webRows = await sql(
    'select count(*)::int as n from signup_progress p join wawu_users u on u.id = p.user_id where u.email = $1',
    [wEmail],
  );
  ok('and gets no sequence record', webRows.rows[0].n === 0);

  // ── 7. An account with no pick reads as discovering ────────────────────────
  const nPhone = '+2348035550404';
  r = await post('/auth/signup', {
    email: `none.${stamp}@example.test`,
    phone: nPhone,
    password,
  });
  r = await post('/auth/phone/verify/confirm', {
    phone: nPhone,
    attempt: r.json.data.attempt,
    code: codeFor(nPhone),
  });
  ok(
    'a sign-in answer without a pick has no accountType key (AUTH-03, unchanged)',
    r.status === 200 && !('accountType' in r.json.data.user),
  );
  r = await get('/auth/signup/progress', r.json.data.accessToken);
  ok(
    'and the sequence takes the discovering path',
    JSON.stringify(r.json.data.steps) === '["email","interests","follows"]' &&
      r.json.data.accountType === null,
  );
} catch (err) {
  console.error(err);
  failures += 1;
} finally {
  await halt().catch(() => undefined);
  receiver.close();
  await pool.end();
}
console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
