// SETTINGS-03 live-seam check: the real wawu-id, built and started on this
// machine, against a LOCAL Postgres. Nothing leaves the computer.
//
//   createdb s03_id
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/s03_id?schema=public \
//     npx prisma migrate deploy
//   npm run test:session-local
//
// It makes its own throwaway RS256 keys, refuses any database that is not on
// this machine or whose name lacks s03, and empties wawu_users and the rate
// counters there. The server sees each request's address through `X-Real-IP`.
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import argon2 from 'argon2';
import pg from 'pg';

const DB =
  process.env.S03_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/s03_id?schema=public';
const PORT = Number(process.env.S03_PORT ?? 3961);
const ID = `http://127.0.0.1:${PORT}`;
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(DB) || !/s03/.test(DB)) {
  console.error('Refusing: the database must be local and its name contain s03.');
  process.exit(2);
}
const busy = await new Promise((r) => {
  const s = net.connect(PORT, '127.0.0.1');
  s.once('connect', () => (s.destroy(), r(true)));
  s.once('error', () => r(false));
});
if (busy) {
  console.error(`Refusing: port ${PORT} is already in use by something else.`);
  process.exit(2);
}

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `  ${detail}`}`);
  if (!cond) failures += 1;
};

const build = spawnSync('npx', ['nest', 'build'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const pool = new pg.Pool({ connectionString: DB.replace(/\?.*/, '') });
const sql = (t, p) => pool.query(t, p);
const log = [];
const server = spawn('node', ['dist/main.js'], {
  env: {
    ...process.env,
    DATABASE_URL: DB,
    PORT: String(PORT),
    RS256_PRIVATE_KEY: keys.privateKey,
    RS256_PUBLIC_KEY: keys.publicKey,
    JWT_EXPIRES_IN: '15m',
    REFRESH_EXPIRES_IN: '30d',
    INTERNAL_SERVICE_KEY: 'local-s03-key',
    RESEND_API_KEY: '',
  },
});
server.stdout.on('data', (d) => log.push(d.toString()));
server.stderr.on('data', (d) => log.push(d.toString()));
const halt = async () => {
  server.kill();
  await new Promise((r) => server.once('exit', r));
  await pool.end();
};

let n = 1000;
const newIp = () => `10.3.${Math.floor(n / 250) % 250}.${n++ % 250}`;
const call = async (method, path, body, headers = {}) => {
  const res = await fetch(`${ID}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-real-ip': newIp(), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, retryAfter: res.headers.get('retry-after'), json };
};
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const login = (identifier, password) =>
  call('POST', '/auth/login', { identifier, password });
const refresh = (t) => call('POST', '/auth/refresh', { refreshToken: t });
const change = (access, currentPassword, newPassword, headers = {}) =>
  call('POST', '/auth/change-password', { currentPassword, newPassword }, {
    ...bearer(access),
    ...headers,
  });
const logout = (t, ip) =>
  call('POST', '/auth/logout', { refreshToken: t }, ip ? { 'x-real-ip': ip } : {});

try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${ID}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 60) throw new Error(`wawu-id did not start\n${log.join('')}`);
    await sleep(500);
  }
  await sql('truncate wawu_users, rate_counters cascade');
  const mk = async (id, email, phone, password) =>
    sql(
      `insert into wawu_users (id, email, phone, first_name, last_name, password_hash, email_verified, updated_at)
       values ($1,$2,$3,'T','User',$4,true,now())`,
      [id, email, phone, password ? await argon2.hash(password) : null],
    );
  const A = 'aaaaaaaa-0000-4000-8000-000000000001';
  const B = 'bbbbbbbb-0000-4000-8000-000000000002';
  const C = 'cccccccc-0000-4000-8000-000000000003';
  await mk(A, 'ada@example.test', '+2348031230001', 'old-password-1');
  await mk(B, 'bola@example.test', '+2348031230002', 'bola-password-1');
  await mk(C, 'cee@example.test', '+2348031230003', null);
  const hashOf = async (id) =>
    (await sql('select password_hash h from wawu_users where id=$1', [id])).rows[0].h;
  const tokensOf = async (id) =>
    Number((await sql('select count(*) c from refresh_tokens where user_id=$1', [id])).rows[0].c);

  // Ada signs in on a phone and a laptop; Bola on his phone.
  const phone = (await login('ada@example.test', 'old-password-1')).json.data;
  const laptop = (await login('ada@example.test', 'old-password-1')).json.data;
  const bola = (await login('bola@example.test', 'bola-password-1')).json.data;
  ok('setup: three sessions signed in', phone && laptop && bola && (await tokensOf(A)) === 2);

  // ── the door: only a live access token opens it ───────────────────────────
  for (const [name, headers] of [
    ['no token', {}],
    ['garbage', bearer('nope')],
    ['a refresh token', bearer(phone.refreshToken)],
  ]) {
    const r = await call('POST', '/auth/change-password',
      { currentPassword: 'old-password-1', newPassword: 'new-password-2' }, headers);
    ok(`change-password with ${name} is refused 401 SESSION_INVALID`,
      r.status === 401 && r.json.code === 'SESSION_INVALID', JSON.stringify(r));
  }
  ok('...and the password is unchanged', await argon2.verify(await hashOf(A), 'old-password-1'));

  // ── validation ────────────────────────────────────────────────────────────
  let r = await change(phone.accessToken, 'old-password-1', 'short');
  ok('a new password under 8 characters is a 400', r.status === 400, JSON.stringify(r));
  r = await call('POST', '/auth/change-password', { currentPassword: 'x' }, bearer(phone.accessToken));
  ok('a missing new password is a 400', r.status === 400);
  r = await change(phone.accessToken, 'old-password-1', 'x'.repeat(129));
  ok('a 129-character new password is a 400', r.status === 400);

  // ── wrong current password ────────────────────────────────────────────────
  r = await change(phone.accessToken, 'not-the-password', 'new-password-2');
  ok('a wrong current password is refused 400 CURRENT_PASSWORD_WRONG',
    r.status === 400 && r.json.code === 'CURRENT_PASSWORD_WRONG', JSON.stringify(r));
  ok('...it echoes neither password', !JSON.stringify(r.json).includes('not-the-password') && !JSON.stringify(r.json).includes('new-password-2'));
  ok('...the password is unchanged and both devices still refresh',
    (await argon2.verify(await hashOf(A), 'old-password-1')) && (await tokensOf(A)) === 2);
  r = await change(phone.accessToken, 'old-password-1', 'old-password-1');
  ok('"changing" to the same password is refused PASSWORD_UNCHANGED',
    r.status === 400 && r.json.code === 'PASSWORD_UNCHANGED', JSON.stringify(r));

  // ── an account with no password ───────────────────────────────────────────
  // (it signs in only by phone code, so a token is made here by hand-free means:
  // there is none; the unit suite holds PASSWORD_NOT_SET)

  // ── the change itself ─────────────────────────────────────────────────────
  r = await change(phone.accessToken, 'old-password-1', 'new-password-2');
  ok('the right current password changes it: 200 and a new pair',
    r.status === 200 && r.json.data?.accessToken && r.json.data?.refreshToken, JSON.stringify(r));
  const kept = r.json.data;
  ok('...this device keeps a session (one refresh token left for Ada)', (await tokensOf(A)) === 1);
  ok("...the old phone's refresh token is refused 401", (await refresh(phone.refreshToken)).status === 401);
  ok("...the laptop's refresh token is refused 401 (other device signed out)", (await refresh(laptop.refreshToken)).status === 401);
  ok("...Bola's session is untouched", (await refresh(bola.refreshToken)).status === 200);
  const again = await refresh(kept.refreshToken);
  ok('...the pair this device was given refreshes', again.status === 200, JSON.stringify(again));
  ok('...the old password no longer signs in (401)', (await login('ada@example.test', 'old-password-1')).status === 401);
  ok('...the new password signs in', (await login('ada@example.test', 'new-password-2')).status === 200);
  ok('...the stored hash is argon2, not the password', (await hashOf(A)).startsWith('$argon2') && !(await hashOf(A)).includes('new-password-2'));

  // ── guessing the current password ─────────────────────────────────────────
  const tok = (await login('bola@example.test', 'bola-password-1')).json.data;
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await change(tok.accessToken, `guess-${i}-xxxx`, 'bola-new-pass-2')).status);
  ok('five wrong current passwords are five 400s', codes.every((c) => c === 400), codes.join(','));
  r = await change(tok.accessToken, 'bola-password-1', 'bola-new-pass-2');
  ok('the sixth try, even with the RIGHT password, waits: 429 RATE_LIMITED with Retry-After',
    r.status === 429 && r.json.code === 'RATE_LIMITED' && Number(r.retryAfter) > 0 && r.json.retryAfterSeconds > 0, JSON.stringify(r));
  ok("...Bola's password is unchanged", await argon2.verify(await hashOf(B), 'bola-password-1'));
  const adaAgain = (await login('ada@example.test', 'new-password-2')).json.data;
  r = await change(adaAgain.accessToken, 'new-password-2', 'ada-third-pass-3');
  ok("...and Bola's wait does not hold up Ada", r.status === 200, JSON.stringify(r));
  // Parallel guesses cannot all slip under the limit.
  await sql('truncate rate_counters');
  const burst = await Promise.all(
    Array.from({ length: 12 }, (_, i) => change(tok.accessToken, `burst-${i}-xxx`, 'bola-new-pass-2')),
  );
  ok('12 parallel wrong guesses: at most 5 are answered, the rest 429',
    burst.filter((x) => x.status === 400).length === 5 && burst.filter((x) => x.status === 429).length === 7,
    burst.map((x) => x.status).join(','));
  await sql('truncate rate_counters');

  // ── sign out ──────────────────────────────────────────────────────────────
  const d1 = (await login('bola@example.test', 'bola-password-1')).json.data;
  const d2 = (await login('bola@example.test', 'bola-password-1')).json.data;
  const out = await logout(d1.refreshToken);
  ok('sign-out answers 200 { data: { signedOut: true } }', out.status === 200 && out.json.data?.signedOut === true, JSON.stringify(out));
  ok('...the refresh token that signed out is refused 401', (await refresh(d1.refreshToken)).status === 401);
  ok("...Bola's other device is still signed in", (await refresh(d2.refreshToken)).status === 200);
  const second = await logout(d1.refreshToken);
  const junk = await logout('not.a.token');
  const unknownLooking = await logout(keys.publicKey.slice(0, 40));
  ok('signing out again, or with garbage, answers the same 200 (no enumeration)',
    JSON.stringify(second.json) === JSON.stringify(out.json) &&
    JSON.stringify(junk.json) === JSON.stringify(out.json) &&
    JSON.stringify(unknownLooking.json) === JSON.stringify(out.json) &&
    [second, junk, unknownLooking].every((x) => x.status === 200));
  r = await call('POST', '/auth/logout', {});
  ok('sign-out with no token in the body is a 400', r.status === 400);
  const adaNow = (await login('ada@example.test', 'ada-third-pass-3')).json.data;
  const before = await tokensOf(A);
  await logout(adaNow.refreshToken);
  ok("Ada's sign-out ends only Ada's token", (await tokensOf(A)) === before - 1 && (await tokensOf(B)) >= 1);
  // an access token is not a refresh token
  const accessAsRefresh = await logout(adaNow.accessToken);
  ok('an access token sent to sign-out ends nothing and answers the same',
    accessAsRefresh.status === 200 && (await tokensOf(A)) === before - 1);

  // ── a refresh in flight while the account is revoked (real Postgres) ──────
  await sql('truncate rate_counters');
  const TRIALS = 24;
  let survivors = 0;
  let changeFailures = 0;
  for (let i = 0; i < TRIALS; i++) {
    const pw = i % 2 ? 'race-pass-b-1' : 'race-pass-a-1';
    const cur = i === 0 ? 'ada-third-pass-3' : i % 2 ? 'race-pass-a-1' : 'race-pass-b-1';
    const session = (await login('ada@example.test', cur)).json.data;
    const stale = (await login('ada@example.test', cur)).json.data;
    const [changed, rotated] = await Promise.all([
      change(session.accessToken, cur, pw),
      sleep((i % 6) * 10).then(() => refresh(stale.refreshToken)),
    ]);
    if (changed.status !== 200) {
      changeFailures += 1;
      continue;
    }
    // Whatever the order, the only session left is the one the change handed over.
    const alive = [];
    if (rotated.status === 200) alive.push(rotated.json.data.refreshToken);
    alive.push(stale.refreshToken);
    for (const t of alive) if ((await refresh(t)).status === 200) survivors += 1;
    if ((await tokensOf(A)) !== 1) survivors += 1;
    if ((await refresh(changed.json.data.refreshToken)).status !== 200) survivors += 1;
  }
  ok(`${TRIALS} trials of a refresh racing a password change: zero surviving stale sessions`,
    survivors === 0 && changeFailures === 0, `survivors=${survivors} changeFailures=${changeFailures}`);

  let logoutErrors = 0;
  let loose = 0;
  for (let i = 0; i < TRIALS; i++) {
    const cur = TRIALS % 2 === 0 ? 'race-pass-b-1' : 'race-pass-a-1';
    const d = (await login('ada@example.test', cur)).json.data;
    const [out, rot] = await Promise.all([
      logout(d.refreshToken),
      sleep(i % 4 === 0 ? 0 : (i * 5) % 30).then(() => refresh(d.refreshToken)),
    ]);
    if (out.status !== 200 || ![200, 401].includes(rot.status)) logoutErrors += 1;
    if ((await refresh(d.refreshToken)).status === 200) loose += 1;
  }
  ok(`${TRIALS} trials of a refresh racing a sign-out: no error, the signed-out token never works after`,
    logoutErrors === 0 && loose === 0, `errors=${logoutErrors} loose=${loose}`);

  // ── sign-out is limited per address ──────────────────────────────────────
  const ip = '203.0.113.77';
  const statuses = [];
  for (let i = 0; i < 32; i++) statuses.push((await logout('x', ip)).status);
  ok('30 sign-outs a minute from one address, then 429',
    statuses.slice(0, 30).every((s) => s === 200) && statuses.slice(30).every((s) => s === 429), statuses.join(','));
  ok('...another address is not held up', (await logout('x', '203.0.113.78')).status === 200);

  // ── what the log holds ────────────────────────────────────────────────────
  const logText = log.join('');
  ok('the server log holds no password and no token',
    !/new-password-2|old-password-1|bola-password-1|ada-third-pass/.test(logText) &&
    !logText.includes(kept.refreshToken));
} catch (err) {
  failures += 1;
  console.error(err);
} finally {
  await halt();
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
