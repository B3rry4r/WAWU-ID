// JOIN-03 round 6: the lock order of everything that removes an account or its
// sign-up, run for real against a LOCAL Postgres. A double of the database
// cannot see a lock, so these are the guards for the rows below that unit specs
// only describe.
//
//   createdb bj03r6_erase_id_test
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bj03r6_erase_id_test?schema=public \
//     npx prisma migrate deploy
//   ERASE_DATABASE_URL=...same... npm run test:erase-local
//
// What it proves, each by holding a real transaction open and reading rows back:
//   1. `signupStillThere` (the check that closes D9) WAITS for a transaction
//      that has deleted the sign-up's code row and not committed. Drop
//      `FOR SHARE` from it and this fails (the verifier's N35).
//   2. D12 (a): an anonymise that queues behind a confirm which is giving the
//      account its number clears the rows keyed on that number, instead of
//      judging from a row it read before the confirm committed.
//   3. D12 (b): two accounts that hold one number (two spellings) closed at the
//      same time leave no counter, wrong-code budget or OTP row behind; while a
//      number another account still holds keeps its rows (D11).
//   4. N31: the hard delete, the SAF delete and the expired sign-up sweep take
//      the sign-up code row before the account, so a confirm in flight on the
//      same pending sign-up never deadlocks with them; nor does the anonymise
//      against a hard or SAF delete of the same account.
//   5. N30: `dropIfEmpty` (what a resend that finds its sign-up gone uses to
//      take away the counter rows it wrote) removes a row at zero and keeps one
//      that still counts something.
//
// It builds the service (everything it calls comes from dist/), refuses any
// database that is not on this machine or whose name does not contain
// erase_id_test, and empties that database's accounts. No port is used. The
// numbers below are made up.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID, randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';

const DB =
  process.env.ERASE_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/bj03r6_erase_id_test?schema=public';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(DB) || !/erase_id_test/.test(DB)) {
  console.error(
    'Refusing to run: the database must be on this machine and its name must contain erase_id_test.',
  );
  process.exit(2);
}

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(
    `${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `  ${detail}`}`,
  );
  if (!cond) failures += 1;
};

const build = spawnSync('npx', ['nest', 'build'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const require = createRequire(import.meta.url);
const { PrismaService } = require('../dist/prisma/prisma.service.js');
const { AuthService } = require('../dist/auth/auth.service.js');
const { signupStillThere } = require('../dist/auth/signup-still-there.js');
const {
  ProvisioningService,
} = require('../dist/provisioning/provisioning.service.js');
const { DbRateLimiter } = require('../dist/auth/rate-limiter.service.js');

const connection = DB.replace(/\?.*/, '');
const pool = new pg.Pool({ connectionString: connection, max: 4 });
const sql = (text, params) => pool.query(text, params);
const client = async () => {
  const c = new pg.Client({ connectionString: connection });
  await c.connect();
  return c;
};

const prisma = new PrismaService({ getOrThrow: () => DB });
await prisma.$connect();
const auth = new AuthService(prisma, null, null, null, null);
const provisioning = new ProvisioningService(prisma, null, null, null, null);

const tag = Date.now().toString(36);
let seq = 0;
const ten = () => `80${randomInt(10_000_000, 99_999_999)}`;

/** Waits until at least n backends of this database are waiting for a lock. */
async function waiters(n, ms = 8000) {
  const end = Date.now() + ms;
  let seen = 0;
  while (Date.now() < end) {
    const { rows } = await sql(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND datname = current_database()`,
    );
    seen = rows[0].n;
    if (seen >= n) return seen;
    await sleep(25);
  }
  return seen;
}
/** Does the promise settle within ms? Returns [settled, value or error]. */
const settles = (promise, ms) =>
  Promise.race([
    promise.then(
      (v) => [true, v],
      (e) => [true, e],
    ),
    sleep(ms).then(() => [false, undefined]),
  ]);
const text = (v) => (v instanceof Error ? v.message.slice(0, 120) : String(v));

async function account({
  phone,
  email = null,
  proved = false,
  provedFor = null,
  code = null,
  signupExpired = false,
} = {}) {
  const id = randomUUID();
  await sql(
    `INSERT INTO wawu_users (id, email, phone, password_hash, email_verified, phone_verified_at, phone_verified_for, updated_at, status)
     VALUES ($1, $2, $3, 'x', false, $4, $5, now(), 'active')`,
    [id, email, phone, proved ? new Date() : null, provedFor],
  );
  if (code) {
    await sql(
      `INSERT INTO phone_verifications (id, user_id, phone, code_hash, attempt_hash, expires_at, last_sent_at, signup_expires_at, updated_at)
       VALUES ($1, $2, $3, 'x', $4, now() + interval '5 minutes', now(), ${
         signupExpired ? "now() - interval '1 minute'" : "now() + interval '1 day'"
       }, now())`,
      [randomUUID(), id, code, `attempt-${tag}-${seq++}`],
    );
  }
  return id;
}
const codeId = async (userId) =>
  (
    await sql(`SELECT id FROM phone_verifications WHERE user_id = $1`, [
      userId,
    ])
  ).rows[0]?.id;
const exists = async (id) =>
  (await sql(`SELECT 1 FROM wawu_users WHERE id = $1`, [id])).rowCount === 1;
const row = async (id) =>
  (await sql(`SELECT * FROM wawu_users WHERE id = $1`, [id])).rows[0];

/** Counters, an OTP session and a wrong-code budget keyed on a number as the sign-up stores it. */
async function keyedOn(e164) {
  await sql(
    `INSERT INTO rate_counters (scope, key, window_start, count) VALUES ('sms-phone-gap', $1, now(), 1), ('sms-phone-day', $1, now(), 1)`,
    [e164],
  );
  await sql(
    `INSERT INTO otp_sessions (id, phone, code_hash, expires_at) VALUES (gen_random_uuid(), $1, 'x', now() + interval '5 minutes')`,
    [e164],
  );
  await sql(
    `INSERT INTO phone_guess_budgets (phone, run_count, day_start, day_count, updated_at) VALUES ($1, 1, now(), 1, now())`,
    [e164],
  );
}
async function rowsKeyedOn(e164) {
  const one = async (q) => (await sql(q, [e164])).rows[0].n;
  return {
    counters: await one(`SELECT count(*)::int n FROM rate_counters WHERE key = $1`),
    otp: await one(`SELECT count(*)::int n FROM otp_sessions WHERE phone = $1`),
    budget: await one(`SELECT count(*)::int n FROM phone_guess_budgets WHERE phone = $1`),
  };
}
const total = (r) => r.counters + r.otp + r.budget;

await sql(
  `TRUNCATE wawu_users, rate_counters, otp_sessions, phone_guess_budgets CASCADE`,
);

// ── 1. signupStillThere waits for an uncommitted delete of the code row ──────
{
  const X = await account({ phone: `+234${ten()}`, code: '+2348000000000' });
  const cid = await codeId(X);
  const [quick, there] = await settles(signupStillThere(prisma, cid), 2000);
  ok('signupStillThere: a code row nobody is touching answers at once', quick && there === true, text(there));

  const deleter = await client();
  await deleter.query('BEGIN');
  await deleter.query(`DELETE FROM phone_verifications WHERE id = $1`, [cid]);
  const asking = signupStillThere(prisma, cid);
  const [early] = await settles(asking, 700);
  const waiting = await waiters(1, 1500);
  ok(
    'signupStillThere: WAITS for a transaction that deleted the code row and has not committed (FOR SHARE)',
    !early && waiting >= 1,
    `answered early=${early}, waiting backends=${waiting}`,
  );
  await deleter.query('COMMIT');
  await deleter.end();
  const [late, value] = await settles(asking, 4000);
  ok('signupStillThere: then answers that the sign-up is gone', late && value === false, text(value));
}

// ── 2. D12 (a): the anonymise reads the account after a confirm that gave it its number ──
{
  const N = `+234${ten()}`;
  // Y was made without its number (another account holds it): its phone is the marker
  const Y = await account({ phone: 'released:pending', code: N });
  await sql(`UPDATE wawu_users SET phone = $2 WHERE id = $1`, [Y, `released:${Y}`]);
  await keyedOn(N);
  const confirm = await client();
  await confirm.query('BEGIN');
  const codeRow = await codeId(Y);
  await confirm.query(`DELETE FROM phone_verifications WHERE id = $1`, [codeRow]);
  await confirm.query(
    `UPDATE wawu_users SET phone = $2, phone_verified_for = $2, phone_verified_at = now() WHERE id = $1`,
    [Y, N],
  );
  const closing = settles(auth.deleteUser(Y, 'anonymize'), 8000); // reads Y while the confirm is open
  await waiters(1, 2000);
  await confirm.query('COMMIT');
  await confirm.end();
  const [done, value] = await closing;
  const left = await rowsKeyedOn(N);
  ok('D12 (a): the anonymise that queued behind the confirm finishes', done && value?.status === 'banned', text(value));
  ok(
    'D12 (a): no counter, OTP row or budget stays keyed on the number the confirm gave the account',
    total(left) === 0,
    JSON.stringify(left),
  );
  ok('D12 (a): the account is closed and holds no number', (await row(Y)).phone === `deleted:${Y}` && (await row(Y)).phone_verified_for === null);
}

// ── 3. D12 (b): two accounts that hold one number, closed together ───────────
{
  // A is stalled at its last statement by a lock on one of its refresh tokens, then B is closed
  for (const [label, spellB] of [['+234 / 0 spelling', (t) => `0${t}`], ['+234 / 234 spelling', (t) => `234${t}`]]) {
    const T = ten();
    const E = `+234${T}`;
    const A = await account({ phone: E, proved: true, provedFor: E });
    const B = await account({ phone: spellB(T) });
    await keyedOn(E);
    await sql(`INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (gen_random_uuid(), $1, 'x', now() + interval '1 day')`, [A]);
    const hold = await client();
    await hold.query('BEGIN');
    await hold.query(`SELECT 1 FROM refresh_tokens WHERE user_id = $1 FOR UPDATE`, [A]);
    const closeA = settles(auth.deleteUser(A, 'anonymize'), 8000); // stalls at its last statement, number lock held
    await waiters(1, 3000);
    const closeB = settles(auth.deleteUser(B, 'anonymize'), 8000);
    await sleep(600); // B either waits for A (the lock) or has already looked and left the rows
    await hold.query('COMMIT');
    await hold.end();
    const [[, a], [, b]] = await Promise.all([closeA, closeB]);
    const left = await rowsKeyedOn(E);
    ok(`D12 (b) ${label}: both are closed`, a?.status === 'banned' && b?.status === 'banned', `${text(a)} / ${text(b)}`);
    ok(`D12 (b) ${label}: nothing stays keyed on the number once nobody holds it`, total(left) === 0, JSON.stringify(left));
  }
  // rounds with real overlap, as the verifier's twin script ran them
  let leaked = 0;
  const rounds = 12;
  for (let i = 0; i < rounds; i++) {
    const T = ten();
    const E = `+234${T}`;
    const A = await account({ phone: E, proved: true, provedFor: E });
    const B = await account({ phone: `0${T}` });
    await keyedOn(E);
    const offset = [0, 1, 2, 4, 6, 9, 13, 17, 22, 28, 35, 45][i];
    await Promise.all([
      settles(auth.deleteUser(A, 'anonymize'), 8000),
      sleep(offset).then(() => settles(auth.deleteUser(B, 'anonymize'), 8000)),
    ]);
    if (total(await rowsKeyedOn(E)) !== 0) leaked += 1;
  }
  ok(`D12 (b): ${rounds} pairs closed 0 to 45 ms apart leave no row behind`, leaked === 0, `${leaked} of ${rounds} left rows`);

  // D11 stays: a number another account still holds keeps its rows
  const T = ten();
  const E = `+234${T}`;
  const gone = await account({ phone: E, proved: true, provedFor: E });
  const holder = await account({ phone: `0${T}` });
  await keyedOn(E);
  await auth.deleteUser(gone, 'anonymize');
  ok('D11: a number another account still holds keeps its counters, OTP row and budget', total(await rowsKeyedOn(E)) === 4, JSON.stringify(await rowsKeyedOn(E)));
  await auth.deleteUser(holder, 'anonymize');
  ok('D11: and they go when the last holder is closed', total(await rowsKeyedOn(E)) === 0);
}

// ── 4. N31: the code row before the account, in every path that removes one ──
const paths = {
  'hard delete': {
    run: (X) => auth.deleteUser(X, 'hard'),
    accountGone: true,
  },
  'SAF delete': {
    run: (X, email) => provisioning.deleteSafUser({ email }),
    accountGone: true,
  },
  'expired sign-up sweep in register': {
    run: (X, email, phone) => auth.releaseExpiredSignups(email, phone),
    accountGone: false, // the confirm won: the account is a confirmed one now and stays
    expired: true,
  },
};
for (const [name, path] of Object.entries(paths)) {
  const T = ten();
  const phone = `+234${T}`;
  const email = `n31-${tag}-${seq++}@erase.example.test`;
  const X = await account({ phone, email, code: phone, signupExpired: !!path.expired });
  const cid = await codeId(X);
  // the confirm: deletes the code row, then gives the account its proof, and holds the code row meanwhile
  const confirm = await client();
  await confirm.query('BEGIN');
  await confirm.query(`DELETE FROM phone_verifications WHERE id = $1`, [cid]);
  const deleting = settles(path.run(X, email, phone), 8000);
  const waiting = await waiters(1, 3000);
  let confirmError = null;
  const update = confirm
    .query(`UPDATE wawu_users SET phone_verified_at = now(), phone_verified_for = phone WHERE id = $1`, [X])
    .catch((e) => (confirmError = e));
  const [updated] = await settles(update, 5000);
  if (updated && !confirmError) await confirm.query('COMMIT');
  else await confirm.query('ROLLBACK').catch(() => {});
  await confirm.end();
  const [done, outcome] = await deleting;
  ok(
    `N31 ${name}: the delete waited behind the confirm (${waiting} waiting) and the confirm was not made to fail`,
    waiting >= 1 && updated && !confirmError,
    confirmError ? text(confirmError) : '',
  );
  ok(
    `N31 ${name}: the delete finished without an error`,
    done && !(outcome instanceof Error),
    text(outcome),
  );
  const gone = !(await exists(X));
  ok(
    `N31 ${name}: ${path.accountGone ? 'the account is deleted' : 'the confirmed account is left alone'}`,
    gone === path.accountGone,
    `gone=${gone}`,
  );
}

// the anonymise against a hard or a SAF delete of the SAME pending account
for (const [name, del] of [
  ['hard delete', (X) => auth.deleteUser(X, 'hard')],
  ['SAF delete', (X, email) => provisioning.deleteSafUser({ email })],
]) {
  const T = ten();
  const phone = `+234${T}`;
  const email = `n31x-${tag}-${seq++}@erase.example.test`;
  const X = await account({ phone, email, code: phone });
  // stalls the anonymise after it holds the code row and the account: a lock on an OTP row of the number
  await sql(
    `INSERT INTO otp_sessions (id, phone, code_hash, expires_at) VALUES (gen_random_uuid(), $1, 'x', now() + interval '5 minutes')`,
    [phone],
  );
  const hold = await client();
  await hold.query('BEGIN');
  await hold.query(`SELECT 1 FROM otp_sessions WHERE phone = $1 FOR UPDATE`, [phone]);
  const anonymising = settles(auth.deleteUser(X, 'anonymize'), 8000);
  await waiters(1, 3000);
  const deleting = settles(del(X, email), 8000);
  const waiting = await waiters(2, 3000);
  await hold.query('COMMIT');
  await hold.end();
  const [[, a], [, d]] = await Promise.all([anonymising, deleting]);
  ok(
    `N31 anonymise against a ${name} of the same pending account: neither fails (${waiting} waiting)`,
    !(a instanceof Error) && !(d instanceof Error) && waiting >= 2,
    `${text(a)} / ${text(d)}`,
  );
}

// ── 5. N30: a resend that finds its sign-up gone takes its counter rows away, and only its own ──
{
  const limits = new DbRateLimiter(prisma);
  const K = `+234${ten()}`;
  const count = async (scope) =>
    (await sql(`SELECT count FROM rate_counters WHERE scope = $1 AND key = $2`, [scope, K])).rows[0]?.count;
  await limits.hit('sms-phone-day', K, 5, 86400);
  await limits.release('sms-phone-day', K);
  ok('N30: a row whose only use was given back is at zero, not yet gone', (await count('sms-phone-day')) === 0);
  await limits.dropIfEmpty('sms-phone-day', K);
  ok('N30: dropIfEmpty removes it', (await count('sms-phone-day')) === undefined);
  await limits.hit('sms-phone-gap', K, 5, 86400);
  await limits.hit('sms-phone-gap', K, 5, 86400);
  await limits.release('sms-phone-gap', K);
  await limits.dropIfEmpty('sms-phone-gap', K);
  ok('N30: dropIfEmpty keeps a row that still counts another sign-up\'s use', (await count('sms-phone-gap')) === 1);
}

await prisma.$disconnect();
await pool.end();
console.log(failures === 0 ? '\nall passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
