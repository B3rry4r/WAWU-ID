// BACKEND_GAPS G-16 (AUTH-05): one phone number held by more than one account,
// written two ways (`0803...` on one row, `+234803...` on another). Web
// `register` stores the phone as typed and checks duplicates exactly, so this
// can only come from rows that already exist.
//
// WHICH ROW KEEPS THE NUMBER (default, agent; the owner may override):
//   1. the account that proved the phone (phone_verified_at; at most one can);
//   2. else an account whose phone is its only way in (it cannot sign in by
//      email: no email, no password, or an email never confirmed);
//   3. else the account that signed in most recently (its newest refresh token);
//   4. else the oldest account.
// Every other row that CAN sign in by email (an email, a password and a
// confirmed email) RELEASES the number: its phone becomes `released:<its id>`
// (the same shape an anonymised account gets, `deleted:<id>`). It keeps its
// email, password, ticks and everything else, and signs in by email. wawu-id
// never hands the marker on as a phone: tokens and answers carry an empty
// phone for it (src/auth/released-phone.ts). A row whose phone is its only way
// in is NEVER released: `report` lists it under "owner to decide" and `apply`
// leaves it as it is. Nothing is merged and nothing is deleted.
//
// THIS REWRITES REAL USER DATA, so only the owner runs `apply` (DECISIONS:
// WORKFLOW section 10). It is never run by a task. `report` only reads.
//
//   npm run build                                  # the script uses dist/common/phone.util.js
//   DATABASE_URL=... node scripts/data/g16-duplicate-phones.mjs report
//   DATABASE_URL=... node scripts/data/g16-duplicate-phones.mjs apply  --owner-approved
//   DATABASE_URL=... node scripts/data/g16-duplicate-phones.mjs revert --owner-approved
//
// `apply` writes every old phone to the table g16_phone_releases first, in the
// same transaction, and `revert` puts each one back from there (refusing, and
// changing nothing, if the number, in any spelling, is held by a row that
// apply did not see holding it: apply records every row of each set it
// touched, keeper, released and held, in g16_phone_members), then
// drops both tables. Neither touches any other column (updated_at included), so
// a revert leaves every row byte for byte as it was. `report` prints ids and
// masked numbers only.
import { createRequire } from 'node:module';
import pg from 'pg';

const require = createRequire(import.meta.url);
let normalisePhone;
let revertClashes;
try {
  ({ normalisePhone } = require('../../dist/common/phone.util.js'));
  ({ revertClashes } = require('../../dist/auth/g16-revert.js'));
} catch {
  console.error(
    'Run `npm run build` first: this uses dist/common/phone.util.js.',
  );
  process.exit(2);
}

const mode = process.argv[2] ?? 'report';
const approved = process.argv.includes('--owner-approved');
if (!['report', 'apply', 'revert'].includes(mode)) {
  console.error(
    'Usage: report | apply --owner-approved | revert --owner-approved',
  );
  process.exit(2);
}
if (mode !== 'report' && !approved) {
  console.error(
    `${mode} rewrites real accounts' phone numbers. Only the owner runs it, with --owner-approved.`,
  );
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL.');
  process.exit(2);
}

const mask = (phone) =>
  phone.length > 6 ? `${phone.slice(0, 4)}...${phone.slice(-3)}` : '***';

/** Every set of two or more live rows whose phones are one number, with the keeper first. */
async function duplicateSets(client) {
  const { rows } = await client.query(`
    SELECT u.id, u.phone, u.created_at, u.phone_verified_at,
           (u.email IS NOT NULL AND u.password_hash IS NOT NULL AND u.email_verified) AS email_way_in,
           (SELECT max(r.created_at) FROM refresh_tokens r WHERE r.user_id = u.id) AS last_session
      FROM wawu_users u
     WHERE u.phone NOT LIKE 'deleted:%' AND u.phone NOT LIKE 'released:%'`);
  const byNumber = new Map();
  for (const row of rows) {
    const number = normalisePhone(row.phone);
    if (!number) continue;
    byNumber.set(number, [...(byNumber.get(number) ?? []), row]);
  }
  const time = (d) => (d ? new Date(d).getTime() : -Infinity);
  const sets = [];
  for (const [number, members] of byNumber) {
    if (members.length < 2) continue;
    members.sort(
      (a, b) =>
        Number(!!b.phone_verified_at) - Number(!!a.phone_verified_at) ||
        Number(!b.email_way_in) - Number(!a.email_way_in) ||
        time(b.last_session) - time(a.last_session) ||
        time(a.created_at) - time(b.created_at) ||
        String(a.id).localeCompare(String(b.id)),
    );
    const others = members.slice(1);
    sets.push({
      number,
      keeper: members[0],
      release: others.filter((r) => r.email_way_in),
      hold: others.filter((r) => !r.email_way_in),
    });
  }
  return sets;
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  if (mode === 'report') {
    const sets = await duplicateSets(client);
    console.log(`${sets.length} number(s) held by more than one account`);
    for (const s of sets) {
      console.log(
        `${mask(s.number)}  keeps: ${s.keeper.id} (${mask(s.keeper.phone)})  releases: ${
          s.release.map((r) => `${r.id} (${mask(r.phone)})`).join(', ') ||
          'none'
        }${
          s.hold.length
            ? `  owner to decide (the phone is its only way in, not released): ${s.hold
                .map((r) => `${r.id} (${mask(r.phone)})`)
                .join(', ')}`
            : ''
        }`,
      );
    }
  } else if (mode === 'apply') {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS g16_phone_releases (
        user_id uuid PRIMARY KEY REFERENCES wawu_users(id) ON DELETE CASCADE,
        old_phone text NOT NULL,
        keeper_id uuid NOT NULL,
        released_at timestamptz NOT NULL DEFAULT now())`);
    // Every row apply saw holding a number it touched (keeper, released,
    // held), so revert can tell them from a row that took the number later.
    await client.query(`
      CREATE TABLE IF NOT EXISTS g16_phone_members (
        user_id uuid PRIMARY KEY REFERENCES wawu_users(id) ON DELETE CASCADE,
        phone text NOT NULL)`);
    const sets = await duplicateSets(client);
    let released = 0;
    for (const s of sets) {
      for (const m of [s.keeper, ...s.release, ...s.hold]) {
        await client.query(
          'INSERT INTO g16_phone_members (user_id, phone) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [m.id, m.phone],
        );
      }
      for (const r of s.release) {
        await client.query(
          'INSERT INTO g16_phone_releases (user_id, old_phone, keeper_id) VALUES ($1, $2, $3)',
          [r.id, r.phone, s.keeper.id],
        );
        await client.query(
          "UPDATE wawu_users SET phone = 'released:' || id::text WHERE id = $1",
          [r.id],
        );
        released += 1;
      }
    }
    await client.query('COMMIT');
    console.log(
      `released ${released} row(s) across ${sets.length} number(s); undo with revert`,
    );
  } else {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT user_id, old_phone, keeper_id FROM g16_phone_releases ORDER BY released_at',
    );
    // A clash is a row apply did not see holding the number in ANY spelling
    // (0803..., +234..., 234..., spaced), or any row on the exact old text
    // (the column is unique): src/auth/g16-revert.ts.
    const { rows: members } = await client.query(
      'SELECT user_id, phone FROM g16_phone_members',
    );
    const { rows: live } = await client.query(
      'SELECT id, phone FROM wawu_users',
    );
    const clashes = revertClashes(rows, members, live, normalisePhone);
    if (clashes.length) {
      await client.query('ROLLBACK');
      console.error(
        `Not reverted: ${clashes.length} old number(s) are held by another row now. Nothing changed.`,
      );
      process.exitCode = 1;
    } else {
      for (const r of rows) {
        await client.query('UPDATE wawu_users SET phone = $2 WHERE id = $1', [
          r.user_id,
          r.old_phone,
        ]);
      }
      await client.query('DROP TABLE g16_phone_releases');
      await client.query('DROP TABLE g16_phone_members');
      await client.query('COMMIT');
      console.log(`restored ${rows.length} row(s)`);
    }
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw err;
} finally {
  await client.end();
}
