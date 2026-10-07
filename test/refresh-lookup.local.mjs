// AUTH-08 live-seam check: the real wawu-id, built and started on this
// machine, against a LOCAL Postgres. Nothing leaves the computer.
//
//   createdb auth08_test_id
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/auth08_test_id?schema=public \
//     npx prisma migrate deploy
//   npm run test:refresh-local
//
// It makes its own throwaway RS256 keys, refuses any database that is not on
// this machine or whose name lacks "auth08", and empties wawu_users and the
// rate counters there. The server sees each request's address through
// `X-Real-IP`.
//
// Run it from a checkout to test that checkout, or from another one with
// AUTH08_SERVER_DIR pointing at a built wawu-id (the same script then runs
// against OLD code, where the jti checks are skipped and the timing is the
// proof). AUTH08_TIMING_ROWS (default 200) is the number of stored refresh
// tokens the timing section gives one account.
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import argon2 from 'argon2';
import pg from 'pg';

const SERVER_DIR = process.env.AUTH08_SERVER_DIR ?? process.cwd();
const require = createRequire(`${SERVER_DIR}/`);
const jsonwebtoken = require('jsonwebtoken');
const DB =
  process.env.AUTH08_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/auth08_test_id?schema=public';
const PORT = Number(process.env.AUTH08_PORT ?? 3962);
const ROWS = Number(process.env.AUTH08_TIMING_ROWS ?? 200);
const ID = `http://127.0.0.1:${PORT}`;
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(DB) || !/auth08/.test(DB)) {
  console.error('Refusing: the database must be local and its name contain auth08.');
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

if (!process.env.AUTH08_NO_BUILD) {
  const build = spawnSync('npx', ['nest', 'build'], { stdio: 'inherit', cwd: SERVER_DIR });
  if (build.status !== 0) process.exit(build.status ?? 1);
}
const pool = new pg.Pool({ connectionString: DB.replace(/\?.*/, '') });
const sql = (t, p) => pool.query(t, p);
const log = [];
const server = spawn('node', ['dist/main.js'], {
  cwd: SERVER_DIR,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    DATABASE_URL: DB,
    PORT: String(PORT),
    RS256_PRIVATE_KEY: keys.privateKey,
    RS256_PUBLIC_KEY: keys.publicKey,
    JWT_EXPIRES_IN: '15m',
    REFRESH_EXPIRES_IN: '30d',
    INTERNAL_SERVICE_KEY: 'local-auth08-key',
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
const newIp = () => `10.8.${Math.floor(n / 250) % 250}.${n++ % 250}`;
const call = async (method, path, body, headers = {}) => {
  const t = Date.now();
  const res = await fetch(`${ID}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-real-ip': newIp(), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ms: Date.now() - t, json };
};
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const login = (identifier, password) =>
  call('POST', '/auth/login', { identifier, password });
const refresh = (t) => call('POST', '/auth/refresh', { refreshToken: t });
const logout = (t) => call('POST', '/auth/logout', { refreshToken: t });
const claims = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());

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
  const hasJti =
    (
      await sql(
        `select 1 from information_schema.columns where table_name='refresh_tokens' and column_name='jti'`,
      )
    ).rowCount === 1;
  console.log(`server: ${SERVER_DIR}, refresh_tokens.jti column: ${hasJti ? 'present' : 'absent'}`);

  await sql('truncate wawu_users, rate_counters cascade');
  const mk = async (id, email, phone, password) =>
    sql(
      `insert into wawu_users (id, email, phone, first_name, last_name, password_hash, email_verified, updated_at)
       values ($1,$2,$3,'T','User',$4,true,now())`,
      [id, email, phone, await argon2.hash(password)],
    );
  const A = 'aaaaaaaa-0000-4000-8000-000000000001';
  const B = 'bbbbbbbb-0000-4000-8000-000000000002';
  const C = 'cccccccc-0000-4000-8000-000000000003';
  await mk(A, 'ada@example.test', '+2348031230001', 'ada-password-1');
  await mk(B, 'bola@example.test', '+2348031230002', 'bola-password-1');
  await mk(C, 'cee@example.test', '+2348031230003', 'cee-password-1');
  const count = async (id, where = '') =>
    Number(
      (await sql(`select count(*) c from refresh_tokens where user_id=$1 ${where}`, [id]))
        .rows[0].c,
    );

  // ── the flow, as the app does it ──────────────────────────────────────────
  const first = await login('ada@example.test', 'ada-password-1');
  ok('login answers 200 with a pair', first.status === 200 && first.json.data?.refreshToken, JSON.stringify(first));
  const t1 = first.json.data;
  if (hasJti) {
    const row = (await sql('select jti from refresh_tokens where user_id=$1', [A])).rows[0];
    ok('the stored row carries the jti signed into the token', row?.jti && row.jti === claims(t1.refreshToken).jti);
  }
  const rot = await refresh(t1.refreshToken);
  ok('refresh with the live token answers 200 and a new pair', rot.status === 200 && rot.json.data?.refreshToken, JSON.stringify(rot));
  ok('...the new refresh token is a different token', rot.json.data?.refreshToken !== t1.refreshToken);
  const reuse = await refresh(t1.refreshToken);
  ok('refresh with the already-used token is refused 401', reuse.status === 401, JSON.stringify(reuse));
  ok('...and it did not sign the device out: the newer token still refreshes',
    (await refresh(rot.json.data.refreshToken)).status === 200);
  const live = (await login('ada@example.test', 'ada-password-1')).json.data;
  const out = await logout(live.refreshToken);
  ok('logout answers 200 { signedOut: true }', out.status === 200 && out.json.data?.signedOut === true, JSON.stringify(out));
  ok('refresh after logout is refused 401', (await refresh(live.refreshToken)).status === 401);
  const again = await logout(live.refreshToken);
  ok('logout again answers the same 200', again.status === 200 && JSON.stringify(again.json) === JSON.stringify(out.json));

  // ── a token whose record is gone (the jti names nothing) ─────────────────
  if (hasJti) {
    const doomed = (await login('ada@example.test', 'ada-password-1')).json.data;
    const keep = (await login('ada@example.test', 'ada-password-1')).json.data;
    await sql('delete from refresh_tokens where jti=$1', [claims(doomed.refreshToken).jti]);
    const gone = await refresh(doomed.refreshToken);
    ok('a real token whose record was deleted is refused 401', gone.status === 401, JSON.stringify(gone));
    ok('...a sign-out with it answers 200 and ends nothing else',
      (await logout(doomed.refreshToken)).status === 200 && (await refresh(keep.refreshToken)).status === 200);
  }

  // ── a token issued before this change ────────────────────────────────────
  await sql('delete from refresh_tokens where user_id=$1', [A]);
  const legacy = async (withJti, userId = A) => {
    const token = jsonwebtoken.sign(
      { sub: userId, ...(withJti ? { jti: randomUUID() } : {}), type: 'refresh' },
      keys.privateKey,
      { algorithm: 'RS256', expiresIn: '30d' },
    );
    await sql(
      'insert into refresh_tokens (id, user_id, token_hash, expires_at) values ($1,$2,$3,$4)',
      [randomUUID(), userId, await argon2.hash(token), new Date(claims(token).exp * 1000)],
    );
    return token;
  };
  for (const withJti of [true, false]) {
    const old = await legacy(withJti);
    const r1 = await refresh(old);
    const r2 = await refresh(old);
    ok(`a pre-change token (payload ${withJti ? 'names an unstored jti, as shipped' : 'has no jti'}, row jti null) refreshes once: 200`,
      r1.status === 200 && r1.json.data?.refreshToken, JSON.stringify(r1));
    ok('...and a second use is refused 401', r2.status === 401, JSON.stringify(r2));
    ok('...what it was swapped for refreshes', (await refresh(r1.json.data.refreshToken)).status === 200);
  }

  // ── expired records go on the next issue ─────────────────────────────────
  await sql('delete from refresh_tokens where user_id in ($1,$2)', [A, B]);
  const decoy = await argon2.hash('some other device');
  const seed = async (userId, k, expired) => {
    for (let i = 0; i < k; i++) {
      await sql(
        'insert into refresh_tokens (id, user_id, token_hash, expires_at) values ($1,$2,$3,$4)',
        [randomUUID(), userId, decoy, new Date(Date.now() + (expired ? -(i + 1) * 3600_000 : 20 * 86400_000))],
      );
    }
  };
  await seed(A, 7, true);
  await seed(B, 3, true);
  await seed(A, 2, false);
  ok('setup: Ada holds 9 rows, 7 of them expired', (await count(A)) === 9 && (await count(A, 'and expires_at < now()')) === 7);
  await login('ada@example.test', 'ada-password-1');
  ok('after one sign-in Ada holds no expired row, and keeps her 2 live ones plus the new one',
    (await count(A, 'and expires_at < now()')) === 0 && (await count(A)) === 3, `rows=${await count(A)}`);
  ok("...Bola's expired rows are not touched by Ada's sign-in", (await count(B)) === 3);
  await login('bola@example.test', 'bola-password-1');
  ok('...and are gone after Bola signs in', (await count(B, 'and expires_at < now()')) === 0 && (await count(B)) === 1);

  // ── sign-out of everything sweeps null-jti rows too ──────────────────────
  await sql('delete from refresh_tokens where user_id=$1', [C]);
  await login('cee@example.test', 'cee-password-1');
  const oldC = await legacy(true, C);
  const oldC2 = await legacy(false, C);
  const here = await login('cee@example.test', 'cee-password-1');
  const ch = await call('POST', '/auth/change-password',
    { currentPassword: 'cee-password-1', newPassword: 'cee-password-2' }, bearer(here.json.data.accessToken));
  ok('a password change answers 200', ch.status === 200, JSON.stringify(ch));
  ok('...it left Cee one refresh token (this device)', (await count(C)) === 1);
  ok('...pre-change tokens (with and without a jti) and the others are refused',
    (await refresh(oldC)).status === 401 && (await refresh(oldC2)).status === 401 &&
    (await refresh(here.json.data.refreshToken)).status === 401 &&
    (await refresh(ch.json.data.refreshToken)).status === 200);

  // ── speed with many stored tokens ────────────────────────────────────────
  await sql('delete from refresh_tokens where user_id=$1', [A]);
  const few = (await login('ada@example.test', 'ada-password-1')).json.data;
  await login('ada@example.test', 'ada-password-1');
  const r2 = await refresh(few.refreshToken);
  console.log(`TIMING  2 stored tokens: refresh ${r2.ms} ms`);
  await sql('delete from refresh_tokens where user_id=$1', [A]);
  // ROWS - 1 rows already held (real argon2 hashes, at the production cost), then a real
  // sign-in is the ROWS-th and the newest.
  for (let i = 0; i < ROWS - 1; i++) {
    await sql(
      'insert into refresh_tokens (id, user_id, token_hash, expires_at, created_at) values ($1,$2,$3,$4,now() - ($5 || \' seconds\')::interval)',
      [randomUUID(), A, decoy, new Date(Date.now() + 20 * 86400_000), String(ROWS * 2 - i)],
    );
  }
  const mine = (await login('ada@example.test', 'ada-password-1')).json.data;
  ok(`setup: Ada holds ${ROWS} stored refresh tokens`, (await count(A)) === ROWS, `rows=${await count(A)}`);
  const big = await refresh(mine.refreshToken);
  console.log(`TIMING  ${ROWS} stored tokens: refresh ${big.ms} ms (status ${big.status})`);
  const next = (await login('ada@example.test', 'ada-password-1')).json.data;
  const bigOut = await logout(next.refreshToken);
  console.log(`TIMING  ${ROWS} stored tokens: sign-out ${bigOut.ms} ms (status ${bigOut.status})`);
  ok(`with ${ROWS} stored tokens a refresh answers 200 in under 1 s`, big.status === 200 && big.ms < 1000, `${big.ms} ms`);
  ok(`with ${ROWS} stored tokens a sign-out answers 200 in under 1 s`, bigOut.status === 200 && bigOut.ms < 1000, `${bigOut.ms} ms`);
  ok('...and the sign-out really ended that token', (await refresh(next.refreshToken)).status === 401);

  const logText = log.join('');
  ok('the server log holds no token', !logText.includes(mine.refreshToken) && !logText.includes(few.refreshToken));
} catch (err) {
  failures += 1;
  console.error(err);
} finally {
  await halt();
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
