// JOIN-03 round 4, D6 (the verifier's N17 gap): the owner's G-16 script, `apply` then
// the Hub finalising a deletion, then `revert`, run for real against a LOCAL Postgres.
//
// What it proves, each by reading the rows back:
//   1. `apply` releases the number of an account that can sign in by email
//      (`released:<id>`) and clears the number that account proved.
//   2. The Hub then finalises one released account's deletion, through the real
//      `AuthService.deleteUser(..., 'anonymize')` of the build: `deleted:<id>`.
//   3. `revert` puts a released account back byte for byte, but leaves an
//      anonymised one anonymised: no phone, no proved number, no digits of the
//      number anywhere in its row. An account given another number since `apply`
//      is left as it is too. The output counts and lists what it left.
//   4. A number an anonymised account once held, since taken by a new account,
//      does not stop the revert for the others.
//   5. The write repeats the test in its WHERE: an account whose deletion is
//      finalised AFTER `revert` has read the rows but BEFORE it writes them (a
//      lock held open by this script makes that exact order) is left anonymised.
//   6. Both g16_ tables are dropped by `revert`, so the old numbers do not stay.
//
//   createdb bj03r4_g16_id_test
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bj03r4_g16_id_test?schema=public \
//     npx prisma migrate deploy
//   G16_DATABASE_URL=...same... npm run test:g16-local
//
// It builds the service (the script and the AuthService it calls come from dist/),
// refuses any database that is not on this machine or whose name does not contain
// g16_id_test, and empties that database's accounts. No port is used. The numbers
// below are made up.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import pg from 'pg';

const DB =
  process.env.G16_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/ba05_g16_id_test?schema=public';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(DB) || !/g16_id_test/.test(DB)) {
  console.error(
    'Refusing to run: the database must be on this machine and its name must contain g16_id_test.',
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

const pool = new pg.Pool({ connectionString: DB.replace(/\?.*/, '') });
const sql = (text, params) => pool.query(text, params);
const script = (mode) =>
  spawnSync(
    process.execPath,
    ['scripts/data/g16-duplicate-phones.mjs', mode, '--owner-approved'],
    { env: { ...process.env, DATABASE_URL: DB }, encoding: 'utf8' },
  );

const NUMBER = (n) => `803111${n}`.slice(0, 10); // 10 digits after the country code
const ids = {};
const uuid = () => crypto.randomUUID();
async function account(label, { phone, proved = true, email = true }) {
  const id = uuid();
  ids[label] = id;
  await sql(
    `INSERT INTO wawu_users (id, email, phone, password_hash, email_verified, phone_verified_at, phone_verified_for, updated_at, status)
     VALUES ($1, $2, $3, 'x', $4, $5, $6, now(), 'active')`,
    [
      id,
      email ? `${label}@g16.example.test` : null,
      phone,
      email,
      proved ? new Date('2026-10-01T10:00:00Z') : null,
      proved ? phone : null,
    ],
  );
  return id;
}
const rowText = async (id) =>
  (await sql('SELECT x::text AS t FROM wawu_users x WHERE id = $1', [id]))
    .rows[0]?.t;
const row = async (id) =>
  (
    await sql(
      'SELECT phone, phone_verified_at, phone_verified_for, status, email FROM wawu_users WHERE id = $1',
      [id],
    )
  ).rows[0];
const digitsEverywhere = async (digits) => {
  const tables = (
    await sql(
      `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename NOT LIKE '\\_prisma%'`,
    )
  ).rows.map((r) => r.tablename);
  const hits = [];
  for (const t of tables) {
    const n = (
      await sql(
        `SELECT count(*)::int AS n FROM "${t}" x WHERE regexp_replace(x::text, '[^0-9]', '', 'g') LIKE '%' || $1 || '%'`,
        [digits],
      )
    ).rows[0].n;
    if (n > 0) hits.push(`${t}:${n}`);
  }
  return hits;
};

// ── an empty scratch database ────────────────────────────────────────────────
await sql('DROP TABLE IF EXISTS g16_phone_releases, g16_phone_members');
await sql('DELETE FROM wawu_users');

// Four numbers, each held by a keeper (0803... form, proved) and a second account (+234 form) that can
// sign in by email, so `apply` releases it.
const sets = {
  one: NUMBER('0001'), // the released account is anonymised after apply (D6)
  two: NUMBER('0002'), // the released account is still released at revert: restored
  three: NUMBER('0003'), // the released account is given another number after apply
  four: NUMBER('0004'), // the released account is finalised while revert is writing
};
for (const [name, n] of Object.entries(sets)) {
  await account(`keeper-${name}`, { phone: `0${n}` });
  // sets one and two: the released account had PROVED the number, so `apply` must clear that proof and `revert`
  // must put it back (set two is restored, set one is anonymised first). JOIN-03 round 5, N26: before this the
  // only account that had proved its number was the one that never gets restored, so a revert that left
  // `phone_verified_for` empty passed this test.
  await account(`released-${name}`, {
    phone: `+234${n}`,
    proved: name === 'one' || name === 'two',
  });
}
// a tie (set one: both proved) goes to the older account, so the keepers are the older ones
await sql(
  `UPDATE wawu_users SET created_at = now() - interval '30 days' WHERE email LIKE 'keeper-%'`,
);

const before = {};
for (const label of [
  'keeper-one',
  'keeper-two',
  'keeper-three',
  'keeper-four',
  'released-two',
]) {
  before[label] = await rowText(ids[label]);
}

// ── apply ────────────────────────────────────────────────────────────────────
const apply = script('apply');
ok('apply exits 0', apply.status === 0, apply.stderr);
ok(
  'apply says it released 4 rows',
  /released 4 row\(s\) across 4 number\(s\)/.test(apply.stdout),
  apply.stdout,
);
for (const name of Object.keys(sets)) {
  const r = await row(ids[`released-${name}`]);
  ok(
    `apply: released-${name} reads released:<id> and proves no number`,
    r.phone === `released:${ids[`released-${name}`]}` &&
      r.phone_verified_for === null,
    JSON.stringify({ phone: r.phone.slice(0, 9), for: r.phone_verified_for }),
  );
  ok(
    `apply: keeper-${name} is untouched`,
    (await rowText(ids[`keeper-${name}`])) === before[`keeper-${name}`],
  );
}

// ── the Hub finalises set one's released account (the real service code) ────
const prisma = new PrismaService({ getOrThrow: () => DB });
await prisma.$connect();
const auth = new AuthService(prisma, null, null, null, null);
await auth.deleteUser(ids['released-one'], 'anonymize');
const gone = await row(ids['released-one']);
ok(
  'the Hub anonymised released-one: deleted marker, banned, no proved number',
  gone.phone === `deleted:${ids['released-one']}` &&
    gone.status === 'banned' &&
    gone.phone_verified_for === null,
);
// set one's old number is then taken by a NEW account (the number is free: its holder is gone)
await account('newcomer-one', { phone: `+234${sets.one}`, proved: false });
// set three's released account is given another number (what the phone-change routes do)
await sql('UPDATE wawu_users SET phone = $2 WHERE id = $1', [
  ids['released-three'],
  `+234803999${sets.three.slice(-4)}`,
]);
const threeBefore = await rowText(ids['released-three']);
const oneBefore = await rowText(ids['released-one']);

// ── revert: 1 to 4, 6 ────────────────────────────────────────────────────────
const revert = script('revert');
ok(
  'revert exits 0 (an anonymised account whose old number a newcomer holds does not stop it)',
  revert.status === 0,
  `${revert.stderr}${revert.stdout}`,
);
ok(
  'revert restored the rows still released (sets two and four) and says so',
  /restored 2 row\(s\)/.test(revert.stdout),
  revert.stdout,
);
ok(
  'revert counts what it left and names those accounts (sets one and three), and no others',
  /left 2 row\(s\) as they are/.test(revert.stdout) &&
    revert.stdout.includes(ids['released-one']) &&
    revert.stdout.includes(ids['released-three']) &&
    !revert.stdout.includes(ids['released-two']) &&
    !revert.stdout.includes(ids['released-four']),
  revert.stdout,
);
ok(
  'revert: the anonymised account is exactly as the Hub left it',
  (await rowText(ids['released-one'])) === oneBefore,
);
const afterOne = await row(ids['released-one']);
ok(
  'revert: the anonymised account still has the deleted marker, no proved number, no email',
  afterOne.phone === `deleted:${ids['released-one']}` &&
    afterOne.phone_verified_for === null &&
    afterOne.email === null &&
    afterOne.status === 'banned',
);
ok(
  "revert: the anonymised account's row holds no digits of its old number",
  !(await rowText(ids['released-one'])).replace(/\D/g, '').includes(sets.one),
);
ok(
  'revert: an account given another number since apply is left as it is',
  (await rowText(ids['released-three'])) === threeBefore,
);
ok(
  'revert: a released account is restored byte for byte',
  (await rowText(ids['released-two'])) === before['released-two'],
);
// N26: the restored account had proved its number; both the phone and the proof come back
const restoredTwo = await row(ids['released-two']);
ok(
  'revert: the account that had proved its number proves it again (phone and phone_verified_for both restored)',
  before['released-two'].includes(`+234${sets.two}`) &&
    restoredTwo.phone === `+234${sets.two}` &&
    restoredTwo.phone_verified_for === `+234${sets.two}` &&
    restoredTwo.phone_verified_at !== null,
  JSON.stringify({
    phone: restoredTwo.phone?.slice(0, 9),
    for: restoredTwo.phone_verified_for?.slice(0, 9),
  }),
);
ok(
  'revert: a keeper is untouched',
  (await rowText(ids['keeper-two'])) === before['keeper-two'],
);
ok(
  'revert dropped both g16_ tables (the old numbers do not stay)',
  (
    await sql(
      `SELECT count(*)::int AS n FROM pg_tables WHERE tablename LIKE 'g16\\_%'`,
    )
  ).rows[0].n === 0,
);
// the old number of the anonymised account is held by two live accounts (the keeper and the newcomer) and by no other row or table
const hits = await digitsEverywhere(sets.one);
ok(
  "the anonymised account's old number is now only where the newcomer and the keeper hold it",
  hits.join(',') === 'wawu_users:2',
  hits.join(','),
);

// ── 5: finalised between revert's read and its write ────────────────────────
// A fresh pair. `revert` reads the rows, then its UPDATE waits on a lock this script holds;
// the lock is released by a transaction that finalises the deletion. The WHERE must then skip the row.
await sql(`DELETE FROM wawu_users WHERE email LIKE '%@g16.example.test'`);
const n4 = sets.four;
await account('keeper-race', { phone: `0${n4}` });
await account('released-race', { phone: `+234${n4}`, proved: false });
await sql(
  `UPDATE wawu_users SET created_at = now() - interval '30 days' WHERE id = $1`,
  [ids['keeper-race']],
);
const apply2 = script('apply');
ok('race: apply exits 0', apply2.status === 0, apply2.stderr);
const holder = new pg.Client({ connectionString: DB.replace(/\?.*/, '') });
await holder.connect();
await holder.query('BEGIN');
await holder.query(
  `UPDATE wawu_users SET phone = 'deleted:' || id::text, phone_verified_for = NULL, status = 'banned', email = NULL WHERE id = $1`,
  [ids['released-race']],
);
const child = spawn(
  process.execPath,
  ['scripts/data/g16-duplicate-phones.mjs', 'revert', '--owner-approved'],
  { env: { ...process.env, DATABASE_URL: DB } },
);
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
const exited = new Promise((resolve) => child.on('close', resolve));
let waiting = false;
for (let i = 0; i < 100 && !waiting; i++) {
  await new Promise((r) => setTimeout(r, 150));
  waiting =
    (
      await sql(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'UPDATE wawu_users SET phone = $2%'`,
      )
    ).rows[0].n > 0;
}
ok(
  'race: revert reached its write and is waiting on the open deletion',
  waiting,
);
await holder.query('COMMIT');
await holder.end();
const code = await exited;
ok('race: revert exits 0', code === 0, out);
const raced = await row(ids['released-race']);
ok(
  'race: the account finalised meanwhile stays anonymised (no phone, no proved number)',
  raced.phone === `deleted:${ids['released-race']}` &&
    raced.phone_verified_for === null &&
    raced.email === null,
  JSON.stringify({ phone: raced.phone.slice(0, 9) }),
);
ok(
  'race: revert says it restored 0 and left that account',
  /restored 0 row\(s\)/.test(out) && out.includes(ids['released-race']),
  out,
);

// ── tidy ─────────────────────────────────────────────────────────────────────
await sql('DELETE FROM wawu_users');
await prisma.$disconnect();
await pool.end();
console.log(
  failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
