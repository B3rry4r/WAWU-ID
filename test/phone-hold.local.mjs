// AUTH-07 round 2 live-seam check: nobody holds a phone number they have not
// proven (the verifier's F1, "a stranger can hold anyone's phone number").
//
// The attack, on the real wawu-id built and started on this machine against a
// LOCAL Postgres, with nothing leaving the computer:
//   1. a stranger signs up with the VICTIM's phone number and the stranger's own
//      mailbox, and confirms with the code mailed to the stranger. The mailed
//      code proves the stranger's EMAIL; the phone is only typed.
//   2. the victim then signs up with their own mailbox and their own number.
//      Before the fix this answered 409 "An account with this email or phone
//      already exists", for good, with no way round it.
// After the fix the newer sign-up takes the number: the stranger's account
// keeps its email and its password but its phone is released (the column holds
// `released:<id>`, which no client ever sees as a phone, G-16). A number that IS
// proven (by a texted code), a number on a long-standing web account, and a
// number on an account whose email clash refuses the sign-up all stay held.
//
//   createdb ba07r2_a07_id_test
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ba07r2_a07_id_test?schema=public \
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
  'postgresql://postgres:postgres@localhost:5432/ba07r2_a07_id_test?schema=public';
const ID_PORT = Number(process.env.A07_ID_PORT ?? 6121);
const RESEND_PORT = Number(process.env.A07_RESEND_PORT ?? 6122);
const FINTAVA_PORT = Number(process.env.A07_FINTAVA_PORT ?? 6123);
const ID = `http://127.0.0.1:${ID_PORT}`;
// The value that means "the code is texted" (`sms` is accepted as the same thing).
const TEXTED = process.env.A07_TEXTED_VALUE ?? 'phone';

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
const resend = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
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

  // ═══ 1. the attack (the verifier's t8) ══════════════════════════════════════
  await boot({ SIGNUP_VERIFY_CHANNEL: 'email' });
  const P = '+2348035550201';
  const strangerEmail = `stranger.${stamp}@example.test`;
  const victimEmail = `victim.${stamp}@example.test`;

  const strangerPassword = 'the-strangers-own-password';
  const stranger = await mailedAccount(
    strangerEmail,
    '0803 555 0201',
    strangerPassword,
  );
  ok(
    'the stranger signs up with the victim\'s number and their own mailbox, and confirms with the mailed code (the session is theirs)',
    stranger.start.status === 201 &&
      stranger.confirmed?.status === 200 &&
      !!stranger.confirmed.json.data.accessToken,
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

  const victim = await mailedAccount(victimEmail, '08035550201');
  ok(
    'THE ATTACK FAILS: the victim signs up with their own number and mailbox and is not refused (201, not 409)',
    victim.start.status === 201,
    show(victim.start.json),
  );
  ok(
    '... and confirms with the code mailed to their own address (200)',
    victim.confirmed?.status === 200 && !!victim.confirmed.json.data.accessToken,
    show(victim.confirmed?.json),
  );
  const victimRow = await userBy(victimEmail);
  held = await userBy(strangerEmail);
  ok(
    'the victim now holds the number',
    victimRow?.phone === P && victimRow.phone_verified_at === null,
    show(victimRow),
  );
  ok(
    'the stranger\'s account keeps its email and loses the number (the released marker, never a phone)',
    held?.email === strangerEmail &&
      held.email_verified === true &&
      /^released:/.test(held.phone),
    show(held),
  );
  let r = await post('/auth/login', {
    identifier: strangerEmail,
    password: strangerPassword,
  });
  ok(
    'the stranger still signs in by email, and the account now answers with NO phone (an empty string, the Hub reads that as none)',
    r.status === 200 &&
      r.json.data.user.phone === '' &&
      claimPayload(r.json.data.accessToken).phone === '',
    show(r.json),
  );
  r = await post('/auth/login', {
    identifier: P,
    password: strangerPassword,
  });
  ok(
    'signing in by the number now finds the victim, not the stranger (the stranger\'s password does not open it)',
    r.status === 401,
    show(r.json),
  );
  r = await post('/auth/login', { identifier: P, password });
  ok(
    'the victim signs in, by their number or their email, and the account answers with the number',
    r.status === 200 && r.json.data.user.phone === P,
    show(r.json),
  );

  // ═══ 2. what must stay held ══════════════════════════════════════════════════
  // 2a. a long-standing account (a web account: nothing proven, no sign-up
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

  // 2b. a sign-up refused for its email clash releases nothing
  const holderPhone = '+2348035550203';
  const holderEmail = `holder.${stamp}@example.test`;
  await mailedAccount(holderEmail, '08035550203');
  r = await post('/auth/signup', {
    email: webEmail,
    phone: '08035550203',
    password,
  });
  ok(
    'a sign-up refused because its email is taken releases nobody\'s number',
    r.status === 409 && (await userBy(holderEmail))?.phone === holderPhone,
    show(r.json),
  );

  // 2c. the same account signing up again with its own email and number
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

  // ═══ 3. a PROVEN number is held (the texted rollback proves it) ═════════════
  await boot({ SIGNUP_VERIFY_CHANNEL: TEXTED });
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
    email: `grab.${stamp}@example.test`,
    phone: '08035550204',
    password,
  });
  ok(
    'a proven number is held: the newer sign-up is refused (409)',
    r.status === 409 && (await userBy(provenEmail))?.phone === provenPhone,
    show(r.json),
  );

  // 2d. under the texted channel a stranger's unproven number gives way too
  const textedHolder = `texted.${stamp}@example.test`;
  const loser = `loser.${stamp}@example.test`;
  const loserPhone = '+2348035550205';
  await sql(
    `with u as (
       insert into wawu_users (id, email, phone, email_verified, password_hash, status, updated_at)
       values (gen_random_uuid(), $1, $2, true, 'x', 'active', now()) returning id)
     insert into signup_progress (user_id, updated_at) select id, now() from u`,
    [loser, loserPhone],
  );
  r = await post('/auth/signup', {
    email: textedHolder,
    phone: '08035550205',
    password,
  });
  const textedAttempt = r.json?.data?.attempt;
  const signedUp = r.status;
  r = textedAttempt
    ? await post('/auth/phone/verify/confirm', {
        phone: loserPhone,
        attempt: textedAttempt,
        code: textCode(loserPhone),
      })
    : { status: signedUp, json: r.json };
  ok(
    'texted channel: a number typed (never proven) on an account that finished a mailed sign-up gives way to a newer sign-up, which proves it by text',
    r.status === 200 &&
      (await userBy(textedHolder))?.phone === loserPhone &&
      (await userBy(textedHolder))?.phone_verified_at !== null &&
      /^released:/.test((await userBy(loser))?.phone ?? ''),
    show(r.json),
  );

  // ═══ 4. an unproven number is not proof of who is holding it ═══════════════
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
  await mailedAccount(typedEmail, '08035550206');
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

  // A code for the unproven number cannot sign anyone in to its account: plant
  // a live code for it as the OTP route would have, then try it.
  await post('/auth/otp/start', { phone: typedPhone });
  const otpCode = mailCode(typedEmail);
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
