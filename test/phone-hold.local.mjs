// AUTH-07 round 3 live-seam check: a phone number an account only typed changes
// hands when a newer sign-up PROVES it, and at no other moment (the verifier's
// F-A, on top of round 2's F1).
//
// The real wawu-id, built and started on this machine against a LOCAL Postgres,
// with nothing leaving the computer:
//   1. a stranger signs up (mailed) with the VICTIM's phone number and their own
//      mailbox, and confirms with the code mailed to the stranger. The mailed
//      code proves the stranger's EMAIL; the number is only typed.
//   2. F-A: a second stranger signs up with that number and NEVER confirms.
//      Round 2 cleared the first stranger's number the moment that sign-up was
//      made (an UNCONFIRMED sign-up stripped it). Round 3 changes nothing for
//      the holder: the new account is made without a number and the answer says
//      so (`phoneNotSaved`).
//   3. the victim signs up MAILED with their own number: not refused, but the
//      account goes ahead without the number (a mailed code proves no number),
//      and says so; the holder keeps it until something proves it.
//   4. the round 1 attack (the verifier's t8) under TEXTED sign-up: the victim
//      signs up texted (the default channel), the text goes to the victim's
//      number, nothing moves until the right code is entered; then the number is
//      the victim's and the stranger keeps everything but the number.
//   5. D1: a sign-up Resend refuses (503) releases nothing and leaves no pending
//      row holding a number or an email.
//   6. G11 and its kin: a code sent to a number its account only typed neither
//      resets that account's password nor signs in to it.
// A number that IS proven (by a texted code), and a number on a long-standing
// web account, stay held.
//
//   createdb ba07r3_a07_id_test
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ba07r3_a07_id_test?schema=public \
//     npx prisma migrate deploy
//   A07_DATABASE_URL=...same... npm run test:phone-hold-local
//
// Ports (all on 127.0.0.1): wawu-id 6121, the Resend stand-in 6122, the
// Fintava stand-in 6123. It makes its own throwaway RS256 keys, refuses any
// database that is not on this machine, and empties the scratch database (its
// name must contain a07_id_test).
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';

const DB =
  process.env.A07_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/ba07r3_a07_id_test?schema=public';
const ID_PORT = Number(process.env.A07_ID_PORT ?? 6121);
const RESEND_PORT = Number(process.env.A07_RESEND_PORT ?? 6122);
const FINTAVA_PORT = Number(process.env.A07_FINTAVA_PORT ?? 6123);
const ID = `http://127.0.0.1:${ID_PORT}`;
// The texted sections boot with the setting UNSET, which is the default and what runs
// today (set A07_TEXTED_VALUE=phone to name it, or sms, its round 1 name).
const TEXTED = process.env.A07_TEXTED_VALUE;

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
/** JSON for a failure line, with every token left out. */
const show = (value) =>
  JSON.stringify(value, (key, v) => (/token/i.test(key) ? '[token]' : v));
const ok = (name, cond, detail = '') => {
  console.log(
    `${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `  ${detail}`}`,
  );
  if (!cond) failures += 1;
};

// ── Resend stand-in: keeps every mail ────────────────────────────────────────
const mailsHeld = [];
// While `resendRefuses` is true the stand-in answers like Resend refusing a send.
let resendRefuses = false;
const resend = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (resendRefuses) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"message":"the stand-in refuses"}');
      return;
    }
    const body = JSON.parse(raw || '{}');
    mailsHeld.push({ to: body.to, subject: body.subject, html: body.html });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"local_1"}');
  });
});
await new Promise((r) => resend.listen(RESEND_PORT, '127.0.0.1', r));
const RESEND_URL = `http://127.0.0.1:${RESEND_PORT}`;
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
await new Promise((r) => fintava.listen(FINTAVA_PORT, '127.0.0.1', r));
const FINTAVA_URL = `http://127.0.0.1:${FINTAVA_PORT}/api/dev`;
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

let ipCounter = 4000;
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
    body: body === undefined ? undefined : show(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const post = (path, body, token) => call('POST', path, body, token);
const stamp = Date.now();
const password = 'choose-a-password';
const userBy = async (email) =>
  (
    await sql(
      'select id, email, phone, email_verified, phone_verified_at from wawu_users where email = $1',
      [email],
    )
  ).rows[0];
let r;
const claimPayload = (jwt) =>
  JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

/** Sign up by mail and confirm with the mailed code. Returns both answers. */
async function mailedAccount(email, phoneTyped, pw = password) {
  const start = await post('/auth/signup', {
    email,
    phone: phoneTyped,
    password: pw,
  });
  const confirmed = start.json?.data?.attempt
    ? await post('/auth/signup/email-code/confirm', {
        phone: start.json.data.phone,
        attempt: start.json.data.attempt,
        code: mailCode(email),
      })
    : null;
  return { start, confirmed };
}

try {
  await sql('select 1');
  await sql('truncate wawu_users, rate_counters, phone_guess_budgets cascade');

  const rowsFor = async (email) =>
    (
      await sql(
        `select (select count(*) from wawu_users where email = $1)::int as users,
                (select count(*) from phone_verifications v join wawu_users u on u.id = v.user_id where u.email = $1)::int as pending`,
        [email],
      )
    ).rows[0];
  const holdersOf = async (phone) =>
    (await sql('select email from wawu_users where phone = $1', [phone])).rows.map(
      (r) => r.email,
    );

  // ═══ 1. a stranger types the victim's number first ═════════════════════════
  await boot({ SIGNUP_VERIFY_CHANNEL: 'email' });
  const P = '+2348035550201';
  const strangerEmail = `stranger.${stamp}@example.test`;
  const victimEmail = `victim.${stamp}@example.test`;
  const strangerPassword = 'the-strangers-own-password';

  r = await call('GET', '/auth/signup/channel');
  ok(
    'GET /auth/signup/channel says email while the setting is email (A3 words its line by it)',
    r.status === 200 && r.json?.data?.channel === 'email',
    show(r.json),
  );

  const stranger = await mailedAccount(
    strangerEmail,
    '0803 555 0201',
    strangerPassword,
  );
  ok(
    'the stranger signs up with the victim\'s number and their own mailbox, and confirms with the mailed code (the session is theirs)',
    stranger.start.status === 201 &&
      stranger.confirmed?.status === 200 &&
      !!stranger.confirmed.json.data.accessToken &&
      stranger.start.json.data.phoneNotSaved === undefined,
    show([stranger.start.json, stranger.confirmed?.json]),
  );
  let held = await userBy(strangerEmail);
  ok(
    'the stranger\'s account holds the number, with nothing proven about it',
    held?.phone === P &&
      held.email_verified === true &&
      held.phone_verified_at === null,
    show(held),
  );

  // ═══ 2. F-A: an UNCONFIRMED sign-up takes nothing ═══════════════════════════
  const griefEmail = `grief.${stamp}@example.test`;
  const grief = await post('/auth/signup', {
    email: griefEmail,
    phone: '08035550201',
    password,
  });
  ok(
    'F-A: a second sign-up for that number is accepted (201), and its answer says the number was not saved',
    grief.status === 201 && grief.json?.data?.phoneNotSaved === true,
    show(grief.json),
  );
  held = await userBy(strangerEmail);
  const griefRow = await userBy(griefEmail);
  ok(
    'F-A: it never confirms, and the holder keeps its number (no released marker)',
    held?.phone === P && !/^released:/.test(held.phone),
    show(held),
  );
  ok(
    'F-A: the account it made holds no number at all (the marker, never a phone), its sign-up row keeps the number typed',
    /^released:/.test(griefRow?.phone ?? '') &&
      (
        await sql(
          'select v.phone from phone_verifications v join wawu_users u on u.id = v.user_id where u.email = $1',
          [griefEmail],
        )
      ).rows[0]?.phone === P,
    show(griefRow),
  );
  // the pending sign-up expires, and a later sign-up for something else runs: still nothing moves
  await sql(
    "update phone_verifications set signup_expires_at = now() - interval '1 hour' where phone = $1",
    [P],
  );
  await post('/auth/signup', {
    email: `unrelated.${stamp}@example.test`,
    phone: '08035550299',
    password,
  });
  ok(
    'F-A: after that pending sign-up expires, nobody holds a different number than before',
    (await userBy(strangerEmail))?.phone === P &&
      (await holdersOf(P)).join() === strangerEmail,
    show(await holdersOf(P)),
  );
  r = await post('/auth/login', {
    identifier: strangerEmail,
    password: strangerPassword,
  });
  ok(
    'F-A: the holder still signs in and the answer carries its number',
    r.status === 200 && r.json.data.user.phone === P,
    show(r.json),
  );

  // ═══ 3. the victim signs up MAILED with their own number ═══════════════════
  const victimStart = await post('/auth/signup', {
    email: victimEmail,
    phone: '08035550201',
    password,
  });
  ok(
    'the victim\'s mailed sign-up is not refused (201), and the answer says the number was not saved',
    victimStart.status === 201 && victimStart.json?.data?.phoneNotSaved === true,
    show(victimStart.json),
  );
  r = await post('/auth/signup/resume', {
    phone: victimStart.json.data.phone,
    attempt: victimStart.json.data.attempt,
  });
  ok(
    'an app that was closed on A4 is told the same thing when it comes back (resume)',
    r.status === 200 &&
      r.json.data.step === 'phone' &&
      r.json.data.phoneNotSaved === true,
    show(r.json),
  );
  const victimConfirmed = await post('/auth/signup/email-code/confirm', {
    phone: victimStart.json.data.phone,
    attempt: victimStart.json.data.attempt,
    code: mailCode(victimEmail),
  });
  const victimRow = await userBy(victimEmail);
  held = await userBy(strangerEmail);
  ok(
    'the victim confirms with the code mailed to their own address and is signed in, with no phone on the account',
    victimConfirmed.status === 200 &&
      !!victimConfirmed.json.data.accessToken &&
      victimConfirmed.json.data.user.phone === '' &&
      claimPayload(victimConfirmed.json.data.accessToken).phone === '' &&
      /^released:/.test(victimRow?.phone ?? '') &&
      victimRow.phone_verified_at === null,
    show(victimConfirmed.json),
  );
  ok(
    'a mailed code proves no number: the holder still holds it, untouched',
    held?.phone === P && held.phone_verified_at === null,
    show(held),
  );

  // ═══ 5. D1: a sign-up Resend refuses leaves nothing behind ════════════════
  resendRefuses = true;
  const refusedEmail = `refused.${stamp}@example.test`;
  r = await post('/auth/signup', {
    email: refusedEmail,
    phone: '08035550201',
    password,
  });
  resendRefuses = false;
  ok(
    'D1: a sign-up Resend refuses answers 503 EMAIL_SEND_FAILED with no secret',
    r.status === 503 &&
      r.json?.code === 'EMAIL_SEND_FAILED' &&
      r.json?.attempt === undefined &&
      r.json?.data === undefined,
    show(r.json),
  );
  held = await userBy(strangerEmail);
  const leftBehind = await rowsFor(refusedEmail);
  ok(
    'D1: it released nothing (the holder keeps its number) and left no account or pending row for its email',
    held?.phone === P && leftBehind.users === 0 && leftBehind.pending === 0,
    show([held, leftBehind]),
  );
  // ... also for a number nobody holds: no pending row stays holding it
  resendRefuses = true;
  const freeEmail = `free.${stamp}@example.test`;
  r = await post('/auth/signup', {
    email: freeEmail,
    phone: '08035550207',
    password,
  });
  resendRefuses = false;
  ok(
    'D1: a refused sign-up for a free number leaves no pending row holding the number or the email',
    r.status === 503 &&
      (await holdersOf('+2348035550207')).length === 0 &&
      (await rowsFor(freeEmail)).users === 0,
    show(r.json),
  );
  r = await post('/auth/signup', {
    email: freeEmail,
    phone: '08035550207',
    password,
  });
  ok(
    'D1: the same person asks again at once and is accepted',
    r.status === 201 && !!r.json?.data?.attempt,
    show(r.json),
  );

  // ═══ what must stay held ═══════════════════════════════════════════════════
  // a long-standing account (a web account: nothing proven, no sign-up
  // sequence) keeps its number. Clearing it would lose real user data.
  const webPhone = '+2348035550202';
  const webEmail = `web.${stamp}@example.test`;
  await sql(
    `insert into wawu_users (id, email, phone, email_verified, password_hash, status, updated_at)
     values (gen_random_uuid(), $1, $2, true, 'x', 'active', now())`,
    [webEmail, webPhone],
  );
  const beforeWeb = mailsHeld.length;
  r = await post('/auth/signup', {
    email: `late.${stamp}@example.test`,
    phone: '08035550202',
    password,
  });
  ok(
    'a number on a long-standing account is still held (409), nothing is mailed, nothing is cleared',
    r.status === 409 &&
      mailsHeld.length === beforeWeb &&
      (await userBy(webEmail))?.phone === webPhone,
    show(r.json),
  );

  // a sign-up refused for its email clash changes nothing for the number's holder
  const holderPhone = '+2348035550203';
  const holderEmail = `holder.${stamp}@example.test`;
  await mailedAccount(holderEmail, '08035550203');
  r = await post('/auth/signup', {
    email: webEmail,
    phone: '08035550203',
    password,
  });
  ok(
    'a sign-up refused because its email is taken changes nothing for the number\'s holder',
    r.status === 409 && (await userBy(holderEmail))?.phone === holderPhone,
    show(r.json),
  );

  // the same account signing up again with its own email and number
  await sleep(6500);
  r = await post('/auth/signup', {
    email: holderEmail,
    phone: '08035550203',
    password,
  });
  ok(
    'the same email and number again is still "an account exists" (409)',
    r.status === 409 && (await userBy(holderEmail))?.phone === holderPhone,
    show(r.json),
  );
  await halt();

  // ═══ 4. the round 1 attack under TEXTED sign-up (the default channel) ═════
  delete process.env.SIGNUP_VERIFY_CHANNEL;
  await boot({ SIGNUP_VERIFY_CHANNEL: TEXTED });
  r = await call('GET', '/auth/signup/channel');
  ok(
    'GET /auth/signup/channel says phone while the setting is unset (A3 names the text)',
    r.status === 200 && r.json?.data?.channel === 'phone',
    show(r.json),
  );
  const textsBefore = texts().length;
  const textedEmail = `owner.${stamp}@example.test`;
  r = await post('/auth/signup', {
    email: textedEmail,
    phone: '08035550201',
    password,
  });
  const textedAttempt = r.json?.data?.attempt;
  ok(
    'the victim signs up TEXTED with their own number: accepted (201), the answer is the one a plain texted sign-up gives, and one text goes to the number',
    r.status === 201 &&
      !!textedAttempt &&
      r.json.data.phoneNotSaved === undefined &&
      texts().length === textsBefore + 1 &&
      texts().at(-1)?.to === P,
    show(r.json),
  );
  ok(
    'nothing moves before the code is entered: the holder keeps the number, and the new account holds none yet',
    (await userBy(strangerEmail))?.phone === P &&
      /^released:/.test((await userBy(textedEmail))?.phone ?? ''),
    show(await holdersOf(P)),
  );
  const rightCode = textCode(P);
  r = await post('/auth/phone/verify/confirm', {
    phone: P,
    attempt: textedAttempt,
    code: rightCode === '000000' ? '111111' : '000000',
  });
  ok(
    'a wrong code proves nothing and moves nothing (400)',
    r.status === 400 && (await userBy(strangerEmail))?.phone === P,
    show(r.json),
  );
  r = await post('/auth/phone/verify/confirm', {
    phone: P,
    attempt: textedAttempt,
    code: rightCode,
  });
  ok(
    'the right code proves the number (200, phone_verified_at set) and the victim now holds it',
    r.status === 200 &&
      (await userBy(textedEmail))?.phone === P &&
      (await userBy(textedEmail))?.phone_verified_at !== null,
    show(r.json),
  );
  held = await userBy(strangerEmail);
  ok(
    'only now does the stranger give the number up: the account keeps its email and verified email and holds the marker',
    held?.email === strangerEmail &&
      held.email_verified === true &&
      /^released:/.test(held.phone),
    show(held),
  );
  r = await post('/auth/login', {
    identifier: strangerEmail,
    password: strangerPassword,
  });
  ok(
    'the stranger still signs in by email, and the account answers with NO phone (an empty string, the Hub reads that as none)',
    r.status === 200 &&
      r.json.data.user.phone === '' &&
      claimPayload(r.json.data.accessToken).phone === '',
    show(r.json),
  );
  r = await post('/auth/login', { identifier: P, password: strangerPassword });
  ok(
    'signing in by the number now finds the victim, not the stranger (the stranger\'s password does not open it)',
    r.status === 401,
    show(r.json),
  );
  r = await post('/auth/login', { identifier: P, password });
  ok(
    'the victim signs in by their number, and the account answers with the number',
    r.status === 200 && r.json.data.user.phone === P,
    show(r.json),
  );

  // an unconfirmed texted sign-up for a held number moves nothing, ever
  const keptPhone = '+2348035550203';
  const grabEmail = `grab.${stamp}@example.test`;
  r = await post('/auth/signup', {
    email: grabEmail,
    phone: '08035550203',
    password,
  });
  await sql(
    "update phone_verifications set signup_expires_at = now() - interval '1 hour' where phone = $1",
    [keptPhone],
  );
  ok(
    'an unconfirmed texted sign-up for a number a mailed account typed moves nothing, even after it expires',
    r.status === 201 && (await userBy(holderEmail))?.phone === keptPhone,
    show(r.json),
  );

  // a PROVEN number is held
  const provenPhone = '+2348035550204';
  const provenEmail = `proven.${stamp}@example.test`;
  r = await post('/auth/signup', {
    email: provenEmail,
    phone: '08035550204',
    password,
  });
  const provenAttempt = r.json?.data?.attempt;
  r = await post('/auth/phone/verify/confirm', {
    phone: provenPhone,
    attempt: provenAttempt,
    code: textCode(provenPhone),
  });
  ok(
    'a texted code proves a number (phone_verified_at is set)',
    r.status === 200 && (await userBy(provenEmail))?.phone_verified_at !== null,
    show(r.json),
  );
  await sleep(6500);
  r = await post('/auth/signup', {
    email: `grab2.${stamp}@example.test`,
    phone: '08035550204',
    password,
  });
  ok(
    'a proven number is held: the newer sign-up is refused (409)',
    r.status === 409 && (await userBy(provenEmail))?.phone === provenPhone,
    show(r.json),
  );

  // ═══ 6. an unproven number is not proof of who is holding it ═══════════════
  // Whoever types a number at a mailed sign-up has not shown it is theirs, so a
  // code sent to that number must not open or reset the account that typed it.
  // (WhatsApp is not configured here, so the code goes to the account's own
  // mailbox: this checks the route's decision, not Meta. The unit spec covers
  // the WhatsApp path with a stand-in.) A long-standing web account keeps
  // today's behaviour exactly.
  await halt();
  await boot({ SIGNUP_VERIFY_CHANNEL: 'email' });
  const typedEmail = `typed.${stamp}@example.test`;
  const typedPhone = '+2348035550206';
  const typedPassword = 'the-typed-accounts-own-password';
  await mailedAccount(typedEmail, '08035550206', typedPassword);
  const sessionsFor = async (phone) =>
    (await sql('select 1 from otp_sessions where phone = $1', [phone])).rowCount;
  const mailsBeforeReset = mailsTo(typedEmail).length;
  r = await post('/auth/forgot-password', {
    identifier: typedPhone,
    method: 'sms',
  });
  ok(
    'forgot-password by text for an unproven number: the usual answer, and no code is made or mailed for it',
    r.status === 200 &&
      (await sessionsFor(typedPhone)) === 0 &&
      mailsTo(typedEmail).length === mailsBeforeReset,
    show(r.json),
  );
  const mailsBeforeWeb = mailsTo(webEmail).length;
  r = await post('/auth/forgot-password', {
    identifier: webPhone,
    method: 'sms',
  });
  ok(
    'the same request for a long-standing account still makes its code, as before',
    r.status === 200 &&
      (await sessionsFor(webPhone)) === 1 &&
      mailsTo(webEmail).length === mailsBeforeWeb + 1,
    show(r.json),
  );
  const webCode = mailCode(webEmail);
  r = await post('/auth/reset-password', {
    identifier: webPhone,
    code: webCode,
    newPassword: 'a-new-long-password',
  });
  ok(
    '... and the reset with that code works for it',
    r.status === 200 && !!r.json.data?.accessToken,
    show(r.json),
  );

  // A real code for the unproven number, made as the OTP route makes one (it
  // goes to the holder's own mailbox here): it must neither reset the password
  // of the account that typed the number (the verifier's G11) nor sign in to it.
  await post('/auth/otp/start', { phone: typedPhone });
  const otpCode = mailCode(typedEmail);
  for (const identifier of [typedPhone, typedEmail]) {
    r = await post('/auth/reset-password', {
      identifier,
      code: otpCode,
      newPassword: 'attacker-chosen-password',
    });
    ok(
      `G11: reset-password by text with a real code for the typed-only number (identifier ${identifier.includes('@') ? 'email' : 'phone'}) is refused (401)`,
      r.status === 401,
      show(r.json),
    );
  }
  r = await post('/auth/login', {
    identifier: typedEmail,
    password: 'attacker-chosen-password',
  });
  ok(
    'G11: the typed-only account\'s password did not change (the attacker\'s password gets 401)',
    r.status === 401,
    show(r.json),
  );
  r = await post('/auth/login', {
    identifier: typedEmail,
    password: typedPassword,
  });
  ok(
    '... and its own password still signs in',
    r.status === 200,
    show(r.json),
  );
  r = await post('/auth/otp/verify', { phone: typedPhone, code: otpCode });
  ok(
    'a code for an unproven number never signs in to the account that typed it (401)',
    r.status === 401,
    show(r.json),
  );
  await sql('delete from otp_sessions');
  await post('/auth/otp/start', { phone: webPhone });
  r = await post('/auth/otp/verify', {
    phone: webPhone,
    code: mailCode(webEmail),
  });
  ok(
    '... while for a long-standing account the code still signs in, as before',
    r.status === 200 && !!r.json.data?.accessToken,
    show(r.json),
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
