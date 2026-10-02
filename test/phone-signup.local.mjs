// AUTH-03 live-seam check: the real wawu-id, built and started on this machine,
// against a LOCAL Postgres, with Fintava's `POST /sms/send` answered by a
// receiver on 127.0.0.1. Nothing leaves the computer and no text is sent.
//
//   createdb wawu_id_auth03
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/wawu_id_auth03?schema=public \
//     npx prisma migrate deploy
//   npm run test:phone-local
//
// It reads the local-only RS256 keys from ./.env (written by wawu-backend's
// scripts/local/up.sh) and ignores that file's DATABASE_URL and mail key. It
// refuses to run against any database that is not on this machine, and it
// empties wawu_users and the two counter tables in the scratch database (its
// name must contain auth03). The server sees each request's address through
// `X-Real-IP`, as it does behind nginx, so every scenario picks its own.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import dotenv from 'dotenv';
import pg from 'pg';

const DB =
  process.env.AUTH03_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_id_auth03?schema=public';
const ID_PORT = 3392;
const SMS_PORT = 3393;
const ID = `http://127.0.0.1:${ID_PORT}`;

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(DB) || !/auth03/.test(DB)) {
  console.error(
    'Refusing to run: the database must be on this machine and its name must contain auth03.',
  );
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

// ── the local stand-in for Fintava's SMS endpoint ────────────────────────────
const texts = [];
let smsStatus = 200;
const receiver = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (
      req.method === 'POST' &&
      req.url === '/api/dev/sms/send' &&
      smsStatus === 200
    ) {
      texts.push({ auth: req.headers.authorization, ...JSON.parse(raw) });
    }
    res.writeHead(smsStatus, { 'content-type': 'application/json' });
    res.end(
      smsStatus === 200
        ? '{}'
        : '{"status":403,"message":["Merchant is not active"]}',
    );
  });
});
await new Promise((r) => receiver.listen(SMS_PORT, '127.0.0.1', r));
const lastCode = () => texts.at(-1).sms.match(/\b(\d{6})\b/)[1];
const codeFor = (phone) =>
  [...texts]
    .reverse()
    .find((t) => t.to === phone)
    ?.sms.match(/\b(\d{6})\b/)[1];
const wrongFor = (code) => (code === '000000' ? '111111' : '000000');

// ── build, then start the real service (again, with other settings, per phase)
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
const clean = () =>
  sql('truncate wawu_users, rate_counters, phone_guess_budgets cascade');

let ipSeq = 0;
const freshIp = () =>
  `198.51.100.${++ipSeq % 250}${Math.floor(ipSeq / 250) ? '' : ''}`;
const ipFor = (n) =>
  `10.${Math.floor(n / 65000)}.${Math.floor(n / 250) % 250}.${n % 250}`;
let ipCounter = 1000;
const newIp = () => ipFor(ipCounter++);

const attempts = new Map();
const normPhone = (raw) => {
  const d = String(raw).replace(/[^\d+]/g, '');
  const m = d.match(/^(?:\+?234|0)?(\d{10})$/);
  return m ? `+234${m[1]}` : d;
};
// The app keeps the secret sign-up returns and sends it back; so does this.
const post = async (path, body, ip = newIp(), extra = {}) => {
  const payload =
    path.startsWith('/auth/phone/verify/') && body.attempt === undefined
      ? { ...body, attempt: attempts.get(normPhone(body.phone)) ?? 'no-secret' }
      : body;
  const started = performance.now();
  const res = await fetch(`${ID}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': ip, ...extra },
    body: JSON.stringify(payload),
  });
  const ms = performance.now() - started;
  const json = await res.json();
  if (path === '/auth/signup' && json.data?.attempt) {
    attempts.set(json.data.phone, json.data.attempt);
  }
  return {
    status: res.status,
    retryAfter: res.headers.get('retry-after'),
    json,
    ms,
  };
};
const shapeOf = (r) =>
  `${r.status} ${r.json.code ?? '-'} ${Object.keys(r.json.data ?? r.json)
    .sort()
    .join(',')}`;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const UTC_NOW = "(now() at time zone 'utc')";
const skipGap = (phone) =>
  sql(
    `update rate_counters set window_start = window_start - interval '2 minutes' where scope = 'sms-phone-gap' and key = $1`,
    [phone],
  );
const endLock = (phone) =>
  sql(
    `update phone_guess_budgets set locked_until = ${UTC_NOW} - interval '1 minute' where phone = $1`,
    [phone],
  );
const endDay = (phone) =>
  sql(
    `update phone_guess_budgets set day_start = day_start - interval '25 hours' where phone = $1`,
    [phone],
  ).then(() =>
    sql(
      `update rate_counters set window_start = window_start - interval '25 hours' where scope = 'sms-phone-day' and key = $1`,
      [phone],
    ),
  );
const stamp = Date.now();
const password = 'choose-a-password';
const mailTo = (address) =>
  log
    .join('')
    .split('\n')
    .filter((l) => l.includes(`[mail skipped] to=${address}`));

try {
  await sql('select 1');
  await clean();
  await boot();

  // ── 1. The sign-up, the wrong codes, the wait, and signing back in ─────────
  const email = `ngozi.${stamp}@example.test`;
  const phone = '+2348031234412';
  let r = await post('/auth/signup', {
    email,
    phone: '0803 123 4412',
    password,
    occupation: 'Photographer',
    accountType: 'creator',
  });
  ok(
    'signup answers 201 with the number normalised',
    r.status === 201 && r.json.data.phone === phone,
    JSON.stringify(r.json),
  );
  ok(
    'signup issues no session',
    !('accessToken' in r.json.data) && !('refreshToken' in r.json.data),
  );
  ok(
    'one SMS reached the provider route, to +234..., with the bearer key and { to, sms }',
    texts.length === 1 &&
      texts[0].to === phone &&
      texts[0].auth === 'Bearer local-test-key' &&
      /Your WAWU code is \d{6}\./.test(texts[0].sms),
    JSON.stringify(texts),
  );
  r = await post('/auth/login', { identifier: email, password });
  ok(
    'before the code, sign-in is refused exactly as before (EMAIL_NOT_VERIFIED)',
    r.status === 403 && r.json.code === 'EMAIL_NOT_VERIFIED',
    JSON.stringify(r.json),
  );

  const real = lastCode();
  const wrong = wrongFor(real);
  for (let i = 1; i <= 3; i++) {
    r = await post('/auth/phone/verify/confirm', {
      phone: '+234 803 123 4412',
      code: wrong,
    });
    ok(
      `wrong code ${i} answers "That code isn't right"`,
      r.status === 400 &&
        r.json.code === 'PHONE_CODE_INVALID' &&
        r.json.message === "That code isn't right",
      JSON.stringify(r.json),
    );
  }
  r = await post('/auth/phone/verify/confirm', {
    phone: '08031234412',
    code: wrong,
  });
  ok(
    'the fourth wrong code answers 429 with a wait',
    r.status === 429 &&
      r.json.code === 'PHONE_CODE_LOCKED' &&
      r.json.retryAfterSeconds === 900 &&
      r.retryAfter === '900',
    JSON.stringify(r),
  );
  r = await post('/auth/phone/verify/confirm', {
    phone: '08031234412',
    code: real,
  });
  ok(
    'during the wait even the right code is refused',
    r.status === 429 && r.json.code === 'PHONE_CODE_LOCKED',
    JSON.stringify(r.json),
  );
  await skipGap(phone);
  const before = texts.length;
  await post('/auth/phone/verify/start', { phone: '08031234412' });
  await sleep(300);
  ok(
    'a resend during the wait is texted but gives the guesses back to nobody (see F-2 below)',
    texts.length === before + 1,
  );
  r = await post('/auth/phone/verify/confirm', {
    phone: '08031234412',
    code: lastCode(),
  });
  ok(
    'and the new code is still refused until the wait is over',
    r.status === 429 && r.json.code === 'PHONE_CODE_LOCKED',
    JSON.stringify(r.json),
  );

  await endLock(phone);
  r = await post('/auth/phone/verify/confirm', {
    phone: '08031234412',
    code: real,
  });
  ok(
    'after the wait the old code no longer works',
    r.status === 400 && r.json.code === 'PHONE_CODE_INVALID',
    JSON.stringify(r.json),
  );
  r = await post('/auth/phone/verify/start', { phone: '+2348031234412' });
  ok(
    'asking again at once is held back (resend gap)',
    r.status === 429 && r.json.code === 'PHONE_CODE_RESEND_TOO_SOON',
    JSON.stringify(r.json),
  );
  await skipGap(phone);
  r = await post('/auth/phone/verify/start', { phone: '+2348031234412' });
  await sleep(300);
  r = await post('/auth/phone/verify/confirm', {
    phone: '08031234412',
    code: lastCode(),
  });
  ok(
    'the new code proves the phone and issues a session',
    r.status === 200 && !!r.json.data.accessToken && !!r.json.data.refreshToken,
    JSON.stringify(r.json).slice(0, 200),
  );
  ok(
    'the user in that session carries the occupation',
    r.json.data.user.occupation === 'Photographer',
  );
  const keys = Object.keys(r.json.data.user).sort().join(',');
  ok(
    'the session user has the keys /auth/login has always answered, plus accountType (R-36: additive)',
    keys ===
      'accountType,country,email,fullName,gender,id,occupation,phone,state,status,trustScore,verification,verificationTier' &&
      r.json.data.user.accountType === 'creator',
    keys,
  );

  const refresh = r.json.data.refreshToken;
  r = await post('/auth/login', { identifier: email, password });
  ok(
    'the sign-in answer carries accountType and occupation',
    r.json.data.user.accountType === 'creator' &&
      r.json.data.user.occupation === 'Photographer',
    JSON.stringify(r.json.data.user),
  );
  ok(
    'a user who signed up on mobile signs back in with email and password, email never confirmed',
    r.status === 200 && !!r.json.data.accessToken,
    JSON.stringify(r.json).slice(0, 200),
  );
  await sleep(200);
  ok(
    'no mail goes to the email nobody proved (no login alert)',
    mailTo(email).length === 0,
    mailTo(email).join('|'),
  );
  r = await post('/auth/login', { identifier: '+2348031234412', password });
  ok(
    'and with the phone as stored',
    r.status === 200,
    JSON.stringify(r.json).slice(0, 200),
  );
  r = await post('/auth/login', { identifier: '08031234412', password });
  ok(
    'F-6: and with the phone as typed, 0803...',
    r.status === 200,
    JSON.stringify(r.json).slice(0, 200),
  );
  r = await post('/auth/login', { identifier: '0803 123 4412', password });
  ok(
    'F-6: with spaces too',
    r.status === 200,
    JSON.stringify(r.json).slice(0, 200),
  );
  r = await post('/auth/login', {
    identifier: email,
    password: 'not the password',
  });
  ok(
    'a wrong password is still refused',
    r.status === 401,
    JSON.stringify(r.json),
  );
  r = await post('/auth/refresh', { refreshToken: refresh });
  ok(
    'the session refreshes',
    r.status === 200 && !!r.json.data.accessToken,
    JSON.stringify(r.json).slice(0, 120),
  );
  const row = (
    await sql(
      'select phone, phone_verified_at, email_verified, occupation, account_type from wawu_users where email = $1',
      [email],
    )
  ).rows[0];
  ok(
    'the row holds the normalised phone, proof time, occupation and account type, email still unverified',
    row.phone === phone &&
      row.phone_verified_at &&
      row.email_verified === false &&
      row.occupation === 'Photographer' &&
      row.account_type === 'creator',
    JSON.stringify(row),
  );

  // ── 2. The old path for everyone else is unchanged ─────────────────────────
  const webEmail = `web.${stamp}@example.test`;
  r = await post('/auth/register', {
    firstName: 'Ada',
    lastName: 'Obi',
    email: webEmail,
    phone: '08099900011',
    country: 'Nigeria',
    password,
  });
  ok(
    'web register still issues its tokens (unchanged)',
    r.status === 201 && !!r.json.data.accessToken,
    JSON.stringify(r.json).slice(0, 120),
  );
  r = await post('/auth/login', { identifier: webEmail, password });
  ok(
    'web account with unproven email and unproven phone is still refused',
    r.status === 403 && r.json.code === 'EMAIL_NOT_VERIFIED',
    JSON.stringify(r.json),
  );
  await post('/auth/email/verify/start', { email: webEmail });
  await sleep(300);
  const emailCode = [
    ...log
      .join('')
      .matchAll(
        new RegExp(
          `to=${webEmail.replace('.', '\\.')}[^\\n]*code=(\\d{6})`,
          'g',
        ),
      ),
  ].at(-1)?.[1];
  r = await post('/auth/email/verify/confirm', {
    email: webEmail,
    code: emailCode ?? '000000',
  });
  ok(
    'email confirmation still works',
    r.status === 200,
    JSON.stringify(r.json).slice(0, 120),
  );
  r = await post('/auth/login', { identifier: webEmail, password });
  ok(
    "a web account's sign-in answer has no accountType key (shape unchanged)",
    !('accountType' in (r.json.data?.user ?? { accountType: 1 })),
  );
  ok(
    'and then that account signs in as before',
    r.status === 200,
    JSON.stringify(r.json).slice(0, 120),
  );
  await sleep(200);
  ok(
    'and still gets its login alert',
    mailTo(webEmail).some((l) =>
      /subject="(?!Your WAWUAfrica verification)/.test(l),
    ),
  );
  const web = (
    await sql(
      'select phone_verified_at, occupation, account_type from wawu_users where email = $1',
      [webEmail],
    )
  ).rows[0];
  ok(
    'web rows are untouched by the new columns',
    web.phone_verified_at === null &&
      web.occupation === null &&
      web.account_type === null,
    JSON.stringify(web),
  );
  r = await post('/auth/login', { identifier: '+2348099900011', password });
  ok(
    'F-6: a web row stored 08099900011 is not found as +234... (legacy lookup unchanged)',
    r.status === 404 && r.json.code === 'USER_NOT_IN_WAWUID',
    JSON.stringify(r.json),
  );

  // ── 3. F-1: nothing but a pending sign-up can be texted or confirmed ───────
  const legacyPhone = '+2348099900011';
  const sentBefore = texts.length;
  r = await post('/auth/phone/verify/start', { phone: '08099900011' });
  await sleep(300);
  ok(
    'F-1: start for a web account answers like any number and sends nothing',
    r.status === 200 && texts.length === sentBefore,
    JSON.stringify(r.json),
  );
  for (let i = 0; i < 3; i++) {
    r = await post('/auth/phone/verify/confirm', {
      phone: '08099900011',
      code: String(100000 + i * 7919),
    });
    ok(
      `F-1: confirm ${i + 1} for a web account is a plain wrong code`,
      r.status === 400 && r.json.code === 'PHONE_CODE_INVALID' && !r.json.data,
      JSON.stringify(r.json),
    );
  }
  const legacyRow = (
    await sql(`select phone_verified_at from wawu_users where email = $1`, [
      webEmail,
    ])
  ).rows[0];
  ok(
    'F-1: the web account was not stamped as phone-verified',
    legacyRow.phone_verified_at === null,
  );
  await sql(`update wawu_users set phone = $1 where email = $2`, [
    '+2348099900012',
    webEmail,
  ]);
  r = await post('/auth/phone/verify/start', { phone: '+2348099900012' });
  await sleep(300);
  ok(
    'F-1: nor is a legacy row holding a +234 number (verified email, no proof)',
    texts.length === sentBefore && r.status === 200,
  );
  await skipGap('+2348031234412');
  r = await post('/auth/phone/verify/start', { phone });
  await sleep(300);
  ok(
    'F-1: nor an account whose phone is already proven',
    texts.length === sentBefore,
  );

  // ── 4. F-2: a resend does not give guesses back; a daily cap ───────────────
  const p2 = '+2348032222201';
  r = await post('/auth/signup', {
    email: `f2.${stamp}@example.test`,
    phone: p2,
    password,
  });
  const results = [];
  for (let round = 0; round < 2; round++) {
    const code = codeFor(p2);
    for (let i = 0; i < 2; i++)
      results.push(
        (
          await post('/auth/phone/verify/confirm', {
            phone: p2,
            code: wrongFor(code),
          })
        ).status,
      );
    await skipGap(p2);
    await post('/auth/phone/verify/start', { phone: p2 });
    await sleep(250);
  }
  ok(
    'F-2: two wrong codes, a resend, two more: the fourth wrong code overall starts the wait',
    results.join() === '400,400,400,429',
    results.join(),
  );
  const p2b = '+2348032222202';
  await post('/auth/signup', {
    email: `f2b.${stamp}@example.test`,
    phone: p2b,
    password,
  });
  let guesses = 0;
  let deniedAt = null;
  for (let round = 0; round < 6 && deniedAt === null; round++) {
    await endLock(p2b);
    for (let i = 0; i < 4; i++) {
      const g = await post('/auth/phone/verify/confirm', {
        phone: p2b,
        code: wrongFor(codeFor(p2b)),
      });
      if (g.status === 400 || (g.status === 429 && i === 3)) guesses += 1;
      if (g.status === 429 && i === 0) {
        deniedAt = guesses;
        break;
      }
    }
  }
  ok(
    'F-2: the day cap stops guessing at 12 wrong codes however often the wait ends',
    guesses === 12 && deniedAt === 12,
    `guesses=${guesses} deniedAt=${deniedAt}`,
  );
  await endLock(p2b);
  r = await post('/auth/phone/verify/confirm', {
    phone: p2b,
    code: codeFor(p2b),
  });
  ok(
    'F-2: with the cap spent even the right code waits (retry-after is hours, never more than a day)',
    r.status === 429 &&
      r.json.retryAfterSeconds > 900 &&
      r.json.retryAfterSeconds <= 86400,
    JSON.stringify(r.json),
  );
  await endDay(p2b);
  await skipGap(p2b);
  await endLock(p2b);
  await post('/auth/phone/verify/start', { phone: p2b });
  await sleep(300);
  r = await post('/auth/phone/verify/confirm', {
    phone: p2b,
    code: codeFor(p2b),
  });
  ok(
    'F-2: after the day the number starts clean and the right code works',
    r.status === 200,
    JSON.stringify(r.json).slice(0, 100),
  );

  // ── 5. F-3: every kind of number gets the same answer, in the same time ────
  const classes = { unknown: [], pending: [], verified: [], legacy: [] };
  for (let i = 0; i < 12; i++) {
    const n = String(30000 + i);
    const unk = `+23480555${n}`;
    const pen = `+23480666${n}`;
    const ver = `+23480777${n}`;
    const leg = `+23480888${n}`;
    await post('/auth/signup', {
      email: `p${i}.${stamp}@example.test`,
      phone: pen,
      password,
    });
    await post('/auth/signup', {
      email: `v${i}.${stamp}@example.test`,
      phone: ver,
      password,
    });
    await post('/auth/phone/verify/confirm', {
      phone: ver,
      code: codeFor(ver),
    });
    await sql(
      `insert into wawu_users (id, email, phone, password_hash, email_verified, updated_at) values (gen_random_uuid(), $1, $2, 'x', true, now())`,
      [`l${i}.${stamp}@example.test`, leg],
    );
    await sleep(60);
    for (const [kind, ph] of [
      ['unknown', unk],
      ['pending', pen],
      ['verified', ver],
      ['legacy', leg],
    ]) {
      await skipGap(ph);
      classes[kind].push({ phone: ph });
    }
  }
  const samples = { start: {}, confirm: {} };
  for (const [kind, list] of Object.entries(classes)) {
    samples.start[kind] = [];
    samples.confirm[kind] = [];
    for (const { phone: ph } of list) {
      samples.start[kind].push(
        await post('/auth/phone/verify/start', { phone: ph }),
      );
    }
    await sleep(300);
    for (const { phone: ph } of list) {
      samples.confirm[kind].push(
        await post('/auth/phone/verify/confirm', { phone: ph, code: '123456' }),
      );
    }
  }
  for (const route of ['start', 'confirm']) {
    const shapes = Object.fromEntries(
      Object.entries(samples[route]).map(([k, v]) => [
        k,
        [
          ...new Set(
            v.map(
              (x) =>
                x.status +
                ' ' +
                (x.json.code ?? '-') +
                ' ' +
                Object.keys(x.json.data ?? x.json)
                  .sort()
                  .join(','),
            ),
          ),
        ].join(' | '),
      ]),
    );
    const same = new Set(Object.values(shapes)).size === 1;
    ok(
      `F-3: ${route} answers every kind of number with the same status and body shape`,
      same,
      JSON.stringify(shapes),
    );
    const med = Object.fromEntries(
      Object.entries(samples[route]).map(([k, v]) => [
        k,
        Math.round(median(v.map((x) => x.ms))),
      ]),
    );
    const spread =
      Math.max(...Object.values(med)) - Math.min(...Object.values(med));
    console.log(`      ${route} median ms by kind: ${JSON.stringify(med)}`);
    ok(
      `F-3: ${route} takes about as long for each kind (medians within 40 ms)`,
      spread <= 40,
      `spread=${spread}ms`,
    );
  }
  // a stranger (no secret) learns nothing from the gap, the lock or the budget
  const strangerStart = [];
  for (const ph of [classes.unknown[0].phone, classes.pending[0].phone]) {
    strangerStart.push(
      shapeOf(
        await post('/auth/phone/verify/start', {
          phone: ph,
          attempt: 'a-stranger',
        }),
      ),
    );
    strangerStart.push(
      shapeOf(
        await post('/auth/phone/verify/start', {
          phone: ph,
          attempt: 'a-stranger',
        }),
      ),
    );
  }
  ok(
    'U-3: asked twice at once with a wrong secret, a registered and an unregistered number answer the same (no resend-gap tell)',
    new Set(strangerStart).size === 1 && strangerStart[0].startsWith('200'),
    strangerStart.join(' | '),
  );
  const strangerConfirm = [];
  for (const ph of [classes.unknown[1].phone, classes.pending[1].phone]) {
    for (let i = 0; i < 6; i++) {
      strangerConfirm.push(
        shapeOf(
          await post('/auth/phone/verify/confirm', {
            phone: ph,
            attempt: 'a-stranger',
            code: '654321',
          }),
        ),
      );
    }
  }
  ok(
    'F-3: six wrong codes with no secret never lock anything, and look the same for either number',
    new Set(strangerConfirm).size === 1 && strangerConfirm[0].startsWith('400'),
    [...new Set(strangerConfirm)].join(' | '),
  );

  // ── 6. D-3 and F-4: an email held by a phone-proven account ────────────────
  const mailCode = (address) =>
    [
      ...log
        .join('')
        .matchAll(
          new RegExp(
            `to=${address.replace(/[.+]/g, '\\$&')} [^\\n]*code=(\\d{6})`,
            'g',
          ),
        ),
    ].at(-1)?.[1];
  const victimEmail = `victim.${stamp}@example.test`;
  const victimPass = 'victims-own-password';
  r = await post('/auth/signup', {
    email: victimEmail,
    phone: '08022222222',
    password: victimPass,
  });
  await sleep(250);
  r = await post('/auth/phone/verify/confirm', {
    phone: '08022222222',
    code: codeFor('+2348022222222'),
  });
  ok(
    'D-3: the victim signs up on mobile and proves their phone, never their email',
    r.status === 200,
  );
  const victimId = r.json.data.user.id;
  // the attacker signs up with the victim's email and a phone of their own
  r = await post('/auth/signup', {
    email: victimEmail,
    phone: '09011111111',
    password: 'attackers-password',
  });
  ok(
    'D-3: the attacker signup is accepted but says an email code is needed',
    r.status === 201 && r.json.data.emailCodeRequired === true,
    JSON.stringify(r.json),
  );
  let holder = (
    await sql(
      `select email, phone, phone_verified_at from wawu_users where id = $1`,
      [victimId],
    )
  ).rows[0];
  ok(
    'D-3(a): the phone-proven victim lost nothing (email, phone, proof intact)',
    holder.email === victimEmail &&
      holder.phone === '+2348022222222' &&
      holder.phone_verified_at !== null,
    JSON.stringify(holder),
  );
  r = await post('/auth/login', {
    identifier: victimEmail,
    password: victimPass,
  });
  ok(
    'D-3(a): and still signs in by email with their own password',
    r.status === 200 && r.json.data.user.id === victimId,
    JSON.stringify(r.json).slice(0, 120),
  );
  await sleep(250);
  const phoneCodeA = codeFor('+2349011111111');
  r = await post('/auth/phone/verify/confirm', {
    phone: '09011111111',
    code: phoneCodeA,
  });
  ok(
    'D-3(c): the attacker holds the phone code but not the mailbox: refused, no session',
    r.status === 400 && !r.json.data,
    JSON.stringify(r.json),
  );
  const attackerRow = (
    await sql(
      `select email, phone_verified_at from wawu_users where phone = '+2349011111111'`,
    )
  ).rows[0];
  ok(
    'D-3(c): the attacker account has no email and no proof, and the victim still has theirs',
    attackerRow.email === null && attackerRow.phone_verified_at === null,
  );
  // an attacker who does get both codes is the owner of the mailbox: the email moves, the other account keeps its phone
  await skipGap('+2349011111111');
  await post('/auth/phone/verify/start', { phone: '09011111111' });
  await sleep(300);
  r = await post('/auth/phone/verify/confirm', {
    phone: '09011111111',
    code: codeFor('+2349011111111'),
    emailCode: mailCode(victimEmail),
  });
  ok(
    'D-3(b): whoever proves the mailbox gets the email and a session of their own account',
    r.status === 200 &&
      r.json.data.user.email === victimEmail &&
      r.json.data.user.id !== victimId,
    JSON.stringify(r.json).slice(0, 160),
  );
  holder = (
    await sql(
      `select email, phone, phone_verified_at, password_hash is not null as has_pw from wawu_users where id = $1`,
      [victimId],
    )
  ).rows[0];
  ok(
    'D-3(b): the account that held the unproven email keeps its phone, proof and password',
    holder.email === null &&
      holder.phone === '+2348022222222' &&
      holder.phone_verified_at !== null &&
      holder.has_pw,
    JSON.stringify(holder),
  );
  r = await post('/auth/login', {
    identifier: '08022222222',
    password: victimPass,
  });
  ok(
    'D-3(b): and signs in by phone',
    r.status === 200 && r.json.data.user.id === victimId,
    JSON.stringify(r.json).slice(0, 120),
  );
  await post('/auth/signup', {
    email: `squat.${stamp}@example.test`,
    phone: '07033333333',
    password,
  });
  r = await post('/auth/signup', {
    email: `squat.${stamp}@example.test`,
    phone: '07044444444',
    password,
  });
  ok(
    'F-4: an unproven sign-up does not hold its email',
    r.status === 201 && r.json.data.emailCodeRequired === false,
    JSON.stringify(r.json),
  );
  ok(
    'F-4: the superseded sign-up is gone',
    (
      await sql(
        `select count(*)::int as n from wawu_users where phone = '+2347033333333'`,
      )
    ).rows[0].n === 0,
  );
  await post('/auth/signup', {
    email: `ttl.${stamp}@example.test`,
    phone: '07055555555',
    password,
  });
  await sql(
    `update phone_verifications set signup_expires_at = ${UTC_NOW} - interval '1 minute' where phone = '+2347055555555'`,
  );
  r = await post('/auth/phone/verify/confirm', {
    phone: '07055555555',
    code: codeFor('+2347055555555'),
  });
  ok(
    'F-4: an unfinished sign-up stops being confirmable once it expires',
    r.status === 400 && r.json.code === 'PHONE_CODE_INVALID',
    JSON.stringify(r.json),
  );
  r = await post('/auth/register', {
    firstName: 'Web',
    lastName: 'Person',
    email: `ttl.${stamp}@example.test`,
    phone: '07055555555',
    country: 'Nigeria',
    password,
  });
  ok(
    'U-4: a web register is not refused by the expired, never-confirmed sign-up that held the same email and phone',
    r.status === 201,
    JSON.stringify(r.json).slice(0, 120),
  );
  await post('/auth/signup', {
    email: `live.${stamp}@example.test`,
    phone: '07066660000',
    password,
  });
  r = await post('/auth/register', {
    firstName: 'Web',
    lastName: 'Person',
    email: `live.${stamp}@example.test`,
    phone: '07066660001',
    country: 'Nigeria',
    password,
  });
  ok(
    'U-4: a pending sign-up that has NOT expired still answers 409 to a web register (unchanged)',
    r.status === 409,
    JSON.stringify(r.json),
  );

  // ── 6b. D-1: a later sign-up cannot capture the victim ─────────────────────
  const vEmail = `d1v.${stamp}@example.test`;
  const aEmail = `d1a.${stamp}@example.test`;
  const victim = await post('/auth/signup', {
    email: vEmail,
    phone: '08044440001',
    password: 'victims-pass-1',
  });
  const victimSecret = victim.json.data.attempt;
  const victimCode = codeFor('+2348044440001');
  await skipGap('+2348044440001');
  const attacker = await post('/auth/signup', {
    email: aEmail,
    phone: '08044440001',
    password: 'attackers-pass-1',
  });
  const attackerCode = codeFor('+2348044440001');
  ok(
    'D-1: the attacker signs up with the victim phone and gets their own secret',
    attacker.status === 201 && attacker.json.data.attempt !== victimSecret,
    JSON.stringify(attacker.json).slice(0, 100),
  );
  r = await post('/auth/phone/verify/confirm', {
    phone: '08044440001',
    attempt: victimSecret,
    code: attackerCode,
  });
  ok(
    'D-1: the victim types the newest text with the secret they hold: refused, no session in the attacker account',
    r.status === 400 && !r.json.data,
    JSON.stringify(r.json),
  );
  r = await post('/auth/phone/verify/confirm', {
    phone: '08044440001',
    attempt: victimSecret,
    code: victimCode,
  });
  ok(
    'D-1: and with their own first code too',
    r.status === 400 && !r.json.data,
    JSON.stringify(r.json),
  );
  r = await post('/auth/phone/verify/confirm', {
    phone: '08044440001',
    attempt: attacker.json.data.attempt,
    code: victimCode,
  });
  ok(
    'D-1: the attacker cannot redeem the code that was texted to the victim before their sign-up',
    r.status === 400 && !r.json.data,
    JSON.stringify(r.json),
  );
  const rowA = (
    await sql(`select phone_verified_at from wawu_users where email = $1`, [
      aEmail,
    ])
  ).rows[0];
  ok(
    'D-1: nothing was proven by any of those',
    rowA.phone_verified_at === null,
  );
  r = await post('/auth/phone/verify/confirm', {
    phone: '08044440001',
    attempt: attacker.json.data.attempt,
    code: attackerCode,
  });
  ok(
    'D-1: the real holder of the current sign-up is not locked out by the failed attempts',
    r.status === 200 && r.json.data.user.email === aEmail,
    JSON.stringify(r.json).slice(0, 120),
  );

  // ── 6c. U-1: a stranger spends nothing of a number's ───────────────────────
  const uPhone = '+2348044440002';
  const u = await post('/auth/signup', {
    email: `u1.${stamp}@example.test`,
    phone: uPhone,
    password,
  });
  for (let i = 0; i < 16; i++)
    await post(
      '/auth/phone/verify/confirm',
      { phone: uPhone, attempt: 'guessing-the-secret', code: '000000' },
      `203.0.113.${i + 20}`,
    );
  const textsBefore2 = texts.length;
  for (let i = 0; i < 6; i++)
    await post(
      '/auth/phone/verify/start',
      { phone: uPhone, attempt: 'guessing-the-secret' },
      `203.0.113.${i + 60}`,
    );
  await sleep(250);
  ok(
    'U-1: strangers with no secret sent no text',
    texts.length === textsBefore2,
  );
  await skipGap(uPhone);
  r = await post('/auth/phone/verify/start', {
    phone: uPhone,
    attempt: u.json.data.attempt,
  });
  ok(
    'U-1: and the holder can still resend at once (no gap or daily budget was spent)',
    r.status === 200,
    JSON.stringify(r.json),
  );
  await sleep(250);
  r = await post('/auth/phone/verify/confirm', {
    phone: uPhone,
    attempt: u.json.data.attempt,
    code: codeFor(uPhone),
  });
  ok(
    'U-1: and confirm (no wrong-code budget was spent)',
    r.status === 200,
    JSON.stringify(r.json).slice(0, 80),
  );

  // ── 6d. D-2: no session by any route before the phone code ─────────────────
  const dEmail = `d2.${stamp}@example.test`;
  const dPhone = '+2348044440003';
  const d = await post('/auth/signup', {
    email: dEmail,
    phone: dPhone,
    password,
  });
  r = await post('/auth/email/verify/start', { email: dEmail });
  await sleep(300);
  r = await post('/auth/email/verify/confirm', {
    email: dEmail,
    code: mailCode(dEmail) ?? '000000',
  });
  ok(
    'D-2: email verify confirm gives no token while the phone code is pending',
    r.status === 403 && r.json.code === 'PHONE_NOT_CONFIRMED' && !r.json.data,
    JSON.stringify(r.json),
  );
  r = await post('/auth/login', { identifier: dEmail, password });
  ok(
    'D-2: nor does login',
    r.status === 403 && !r.json.data,
    JSON.stringify(r.json),
  );
  ok(
    'D-2: and the refused email confirmation changed nothing (email still unverified)',
    (
      await sql(`select email_verified from wawu_users where email = $1`, [
        dEmail,
      ])
    ).rows[0].email_verified === false,
  );
  r = await post('/auth/otp/start', { phone: dPhone });
  await sleep(300);
  const otpCode = mailCode(dEmail);
  r = await post('/auth/otp/verify', {
    phone: dPhone,
    code: otpCode ?? '000000',
  });
  ok(
    'D-2: nor does the phone OTP route (its code is mailed to the account email while WhatsApp is unset)',
    r.status === 403 && !r.json.data,
    JSON.stringify(r.json),
  );
  r = await post('/auth/forgot-password', {
    identifier: dEmail,
    method: 'sms',
  });
  await sleep(300);
  r = await post('/auth/reset-password', {
    identifier: dEmail,
    code: mailCode(dEmail) ?? '000000',
    newPassword: 'attackers-new-password',
  });
  ok(
    'D-2: nor does the SMS-code password reset',
    r.status === 403 || r.status === 401,
    JSON.stringify(r.json),
  );
  ok(
    'D-2: no refresh token exists for the account',
    (
      await sql(
        `select count(*)::int as n from refresh_tokens rt join wawu_users u on u.id = rt.user_id where u.email = $1`,
        [dEmail],
      )
    ).rows[0].n === 0,
  );
  r = await post('/auth/phone/verify/confirm', {
    phone: dPhone,
    attempt: d.json.data.attempt,
    code: codeFor(dPhone),
  });
  ok(
    'D-2: after the phone code the account gets its session',
    r.status === 200 && !!r.json.data.accessToken,
    JSON.stringify(r.json).slice(0, 80),
  );
  r = await post('/auth/login', {
    identifier: dEmail,
    password: 'attackers-new-password',
  });
  ok('D-2: and the reset the stranger tried changed nothing', r.status !== 200);
  r = await post('/auth/login', { identifier: dEmail, password });
  ok(
    'D-2: the owner password still signs in',
    r.status === 200,
    JSON.stringify(r.json).slice(0, 80),
  );

  // ── 6e. D-4: changing the phone number keeps the right to sign in ──────────
  const internal = (path, body) =>
    fetch(`${ID}${path}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-service-key': local.INTERNAL_SERVICE_KEY.replace(/"/g, ''),
      },
      body: JSON.stringify(body),
    });
  const changed = await internal(
    `/internal/users/${r.json.data.user.id}/phone`,
    { phone: '08088880001' },
  );
  ok(
    'D-4: the internal phone change answers 200',
    changed.status === 200,
    String(changed.status),
  );
  r = await post('/auth/login', { identifier: dEmail, password });
  ok(
    'D-4: and the user still signs in afterwards (email never verified through sign-up)',
    r.status === 200,
    JSON.stringify(r.json).slice(0, 80),
  );
  r = await post('/auth/login', { identifier: '08088880001', password });
  ok(
    'D-4: by the new phone too',
    r.status === 200,
    JSON.stringify(r.json).slice(0, 80),
  );

  // ── 7. F-5: parallel requests ──────────────────────────────────────────────
  const same = {
    email: `par.${stamp}@example.test`,
    phone: '07066666666',
    password,
  };
  const par = await Promise.all(
    Array.from({ length: 6 }, () => post('/auth/signup', same, '172.16.0.1')),
  );
  const parStatuses = par
    .map((x) => x.status)
    .sort()
    .join();
  ok(
    'F-5: six parallel identical sign-ups give no server error and one account',
    !par.some((x) => x.status >= 500) &&
      par.some((x) => x.status === 201) &&
      (
        await sql(
          `select count(*)::int as n from wawu_users where email = $1`,
          [same.email],
        )
      ).rows[0].n === 1,
    parStatuses,
  );
  await sleep(300);
  const code5 = codeFor('+2347066666666');
  const conf = await Promise.all(
    [1, 2, 3].map(() =>
      post(
        '/auth/phone/verify/confirm',
        { phone: '07066666666', code: code5 },
        '172.16.0.2',
      ),
    ),
  );
  const confStatuses = conf
    .map((x) => x.status)
    .sort()
    .join();
  ok(
    'F-5: three parallel confirms with one code give one session and no server error',
    conf.filter((x) => x.status === 200).length === 1 &&
      !conf.some((x) => x.status >= 500),
    confStatuses,
  );
  const sameP = await Promise.all(
    ['a', 'b'].map((n) =>
      post(
        '/auth/signup',
        {
          email: `${n}.race.${stamp}@example.test`,
          phone: '07077777777',
          password,
        },
        '172.16.0.3',
      ),
    ),
  );
  ok(
    'F-5: two parallel sign-ups with one phone give no server error',
    !sameP.some((x) => x.status >= 500),
    sameP.map((x) => x.status).join(),
  );

  // ── 8. F-8: Nigerian numbers only ──────────────────────────────────────────
  const textsBefore = texts.length;
  r = await post('/auth/signup', {
    email: `intl.${stamp}@example.test`,
    phone: '+14155552671',
    password,
  });
  ok(
    'F-8: an international number is refused with a clear 400',
    r.status === 400 && r.json.code === 'PHONE_NOT_SUPPORTED',
    JSON.stringify(r.json),
  );
  r = await post('/auth/phone/verify/start', { phone: '+442071838750' });
  ok(
    'F-8: and on start too',
    r.status === 400 && r.json.code === 'PHONE_NOT_SUPPORTED',
    JSON.stringify(r.json),
  );
  await sleep(200);
  ok(
    'F-8: no text was sent and no account made',
    texts.length === textsBefore &&
      (
        await sql(
          `select count(*)::int as n from wawu_users where email like 'intl.%'`,
        )
      ).rows[0].n === 0,
  );

  // ── 9. F-9: limits on texts ────────────────────────────────────────────────
  const limitIp = '192.0.2.50';
  const outcomes = [];
  for (let i = 0; i < 31; i++) {
    outcomes.push(
      await post(
        '/auth/signup',
        {
          email: `ip${i}.${stamp}@example.test`,
          phone: `0807000${String(1000 + i)}`,
          password,
        },
        limitIp,
        { 'x-forwarded-for': `1.2.3.${i}` },
      ),
    );
  }
  const last = outcomes.at(-1);
  ok(
    'F-9: 30 sign-ups from one address pass and the 31st is a 429 with Retry-After',
    outcomes.slice(0, 30).every((x) => x.status === 201) &&
      last.status === 429 &&
      last.json.code === 'RATE_LIMITED' &&
      Number(last.retryAfter) > 0 &&
      Number(last.retryAfter) <= 3600,
    `${outcomes.map((x) => x.status).join(',')} ${last.retryAfter}`,
  );
  ok(
    'F-9: writing a different X-Forwarded-For does not get round it (X-Real-IP, set by nginx, is used)',
    outcomes.slice(25).every((x) => x.status === 201 || x.status === 429),
  );
  r = await post(
    '/auth/signup',
    { email: `ip.other.${stamp}@example.test`, phone: '08070009999', password },
    '192.0.2.51',
  );
  ok(
    'F-9: another address is not held back',
    r.status === 201,
    JSON.stringify(r.json),
  );
  const pPhone = '+2348031119999';
  await post('/auth/signup', {
    email: `pp.${stamp}@example.test`,
    phone: pPhone,
    password,
  });
  const perPhone = [];
  for (let i = 0; i < 5; i++) {
    await skipGap(pPhone);
    perPhone.push(
      (await post('/auth/phone/verify/start', { phone: pPhone })).status,
    );
  }
  ok(
    'F-9: one number can be asked for 5 times a day, then 429',
    perPhone.slice(0, 4).every((s) => s === 200) && perPhone[4] === 429,
    perPhone.join(),
  );
  const unkPhone = '+2348031118888';
  const perUnknown = [];
  for (let i = 0; i < 6; i++) {
    perUnknown.push(
      (await post('/auth/phone/verify/start', { phone: unkPhone })).status,
    );
  }
  ok(
    'F-9: a number nobody registered, or with a wrong secret, spends nothing and always answers 200',
    perUnknown.every((x) => x === 200),
    perUnknown.join(),
  );
  const dosPhone = '+2348031117777';
  const dos = await post('/auth/signup', {
    email: `dos.${stamp}@example.test`,
    phone: dosPhone,
    password,
  });
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 4; i++)
      await post(
        '/auth/phone/verify/confirm',
        { phone: dosPhone, attempt: 'a-stranger', code: '000000' },
        '203.0.113.200',
      );
  }
  r = await post('/auth/phone/verify/confirm', {
    phone: dosPhone,
    attempt: dos.json.data.attempt,
    code: codeFor(dosPhone),
  });
  ok(
    "F-9: a stranger cannot burn a victim's guesses: 16 wrong codes with no secret, and the real code works",
    r.status === 200,
    JSON.stringify(r.json).slice(0, 80),
  );
  const v6 = [];
  for (let i = 0; i < 31; i++) {
    v6.push(
      (
        await post(
          '/auth/signup',
          {
            email: `v6.${i}.${stamp}@example.test`,
            phone: `0809${String(5000000 + i)}`,
            password,
          },
          `2001:db8:abcd:12:${i}:${i}:${i}:${i}`,
        )
      ).status,
    );
  }
  ok(
    'U-2: 31 sign-ups from 31 addresses in one IPv6 /64 count as one client: the 31st is a 429',
    v6.slice(0, 30).every((x) => x === 201) && v6[30] === 429,
    v6.join(),
  );

  // ── 10. The provider refuses the text ──────────────────────────────────────
  smsStatus = 403;
  const retryEmail = `retry.${stamp}@example.test`;
  r = await post('/auth/signup', {
    email: retryEmail,
    phone: '07012345678',
    password,
  });
  ok(
    'when the provider refuses, signup says so (503)',
    r.status === 503 && r.json.code === 'SMS_SEND_FAILED',
    JSON.stringify(r.json),
  );
  smsStatus = 200;
  r = await post('/auth/signup', {
    email: retryEmail,
    phone: '07012345678',
    password,
  });
  ok(
    'the same person tries again at once and a code is sent',
    r.status === 201 && texts.at(-1).to === '+2347012345678',
    JSON.stringify(r.json),
  );
  r = await post('/auth/signup', {
    email: `bad.${stamp}@example.test`,
    phone: '1234567',
    password,
  });
  ok(
    'a malformed number is a 400',
    r.status === 400 && r.json.code === 'PHONE_INVALID',
    JSON.stringify(r.json),
  );

  // ── 11. The daily budget for the whole service ─────────────────────────────
  await halt();
  await clean();
  await boot({ SMS_LIMIT_GLOBAL_PER_DAY: '2' });
  const g1 = await post('/auth/signup', {
    email: `g1.${stamp}@example.test`,
    phone: '08041000001',
    password,
  });
  const g2 = await post('/auth/signup', {
    email: `g2.${stamp}@example.test`,
    phone: '08041000002',
    password,
  });
  const g3 = await post('/auth/signup', {
    email: `g3.${stamp}@example.test`,
    phone: '08041000003',
    password,
  });
  const g4 = await post('/auth/phone/verify/start', { phone: '08049999999' });
  ok(
    'F-9: with a budget of 2 texts a day the third sign-up and any resend are 429 (same for an unregistered number)',
    g1.status === 201 &&
      g2.status === 201 &&
      g3.status === 429 &&
      g4.status === 429 &&
      g3.json.code === 'RATE_LIMITED' &&
      Number(g3.retryAfter) > 0,
    [g1, g2, g3, g4].map((x) => x.status).join(),
  );

  // ── 12. U-1: the daily budget is exact, even for a burst ───────────────────
  await halt();
  await clean();
  await boot({
    SMS_LIMIT_GLOBAL_PER_DAY: '5',
    SMS_LIMIT_IP_PER_HOUR: '1000',
    SMS_LIMIT_IP_PER_DAY: '1000',
  });
  const burstBefore = texts.length;
  const burst = await Promise.all(
    Array.from({ length: 24 }, (_, i) =>
      post('/auth/signup', {
        email: `burst${i}.${stamp}@example.test`,
        phone: `0803200${String(1000 + i)}`,
        password,
      }),
    ),
  );
  await sleep(300);
  ok(
    'U-1: 24 parallel sign-ups against a budget of 5 send exactly 5 texts (before: 22 too many)',
    texts.length - burstBefore === 5 &&
      burst.filter((x) => x.status === 201).length === 5,
    `texts=${texts.length - burstBefore} created=${burst.filter((x) => x.status === 201).length}`,
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
