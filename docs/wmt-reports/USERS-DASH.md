# USERS-DASH: POST /internal/users/list

Branch `wmt/USERS-DASH`, from `origin/main` 3216e46. Code pushed first, this report after. No pull request opened.

## What changed
- `src/auth/internal.controller.ts:62-83`: new route `POST /internal/users/list`. Same `@Controller('internal')`, same `assertServiceKey` (same 401 "Invalid service key"), 200 on success, checked before the body is read.
- `src/auth/auth.service.ts:665-695` (`listUsers`): runs the query. A database failure is answered with fixed text (500 "Could not list users.") so a Prisma error that carries `q` never reaches a response or a log.
- `src/auth/users-list.ts` (new): body checks, cursor, the where clauses, the row shape.
- `src/auth/users-list.spec.ts` (new): 28 tests.
- No schema change, no migration, no existing route or field touched.

## The route as built
`POST /internal/users/list`, header `x-service-key`.

Body: `{ "ids"?: string[], "q"?: string, "cursor"?: string, "limit"?: number }`

- `ids` present: 1 to 200 strings, else 400. Returns the users among them that exist (a string that is not a uuid is just "not found"). `q`, `cursor`, `limit` are ignored, even if bad. `nextCursor` is null.
- No `ids`: newest first (`createdAt` desc, `id` desc), `limit` whole number 1 to 100 (default 50, else 400), opaque `cursor` (not one this route issued is 400). The cursor is a keyset on (createdAt, id), so users added while paging never cause a duplicate or a skip of an old one.
- `q`: trimmed, 2 to 120 characters, else 400. Keeps a user when `q` is part of the first name, the last name, or "first last" (any case), OR equals the whole email (any case), OR is the whole phone written any usual way (`comparablePhone` + `phoneVariants` from the phone util, so `0803 123 4412`, `+2348031234412`, `2348031234412` all find `+2348031234412`). A part of an email or a part of a phone does not match. `%`, `_` and `\` in `q` are plain text.
- Response 200: `{ "items": [ { id, firstName, lastName, email, phone, countryCode, createdAt (ISO), emailVerified, phoneVerified } ], "nextCursor": string|null }`. Exactly those nine fields; the query selects only the columns it needs, so no hash, token or code is read.
- `phoneVerified` uses the service's own `phoneIsProven` (proof column set AND it was for the number now held), not the bare column. A phone changed after proof shows false.
- Account whose phone was released (`released:<id>`): kept in the list, `phone` is `""` (as the token already does).

Example:
```
POST /internal/users/list
x-service-key: <key>
{ "q": "0803 123 4412", "limit": 20 }

200
{ "items": [ { "id": "6f0c...", "firstName": "Adaeze", "lastName": "Okonkwo",
  "email": "adaeze@example.test", "phone": "+2348031234412", "countryCode": "NG",
  "createdAt": "2026-10-02T09:14:31.000Z", "emailVerified": true, "phoneVerified": true } ],
  "nextCursor": null }
```

## Deleted and closed accounts (what I did)
Left out of both the list and `ids`, by the same four marks `isClosedAccount` reads: status `banned`, status `pending_deletion`, a `deletedAt` stamp, or a `deleted:<id>` phone. So a banned account is also left out. If the dashboard should still show banned people, that is one line to change (`OPEN_ACCOUNT_WHERE` in `users-list.ts`): your call.

## Speed
Email and phone are unique, so a whole-email or whole-phone match is an index lookup on its own. But `q` is one OR with the name search, and a name search (contains) cannot use a plain index, so the database scans the table. Measured on a scratch Postgres 16 with 100,000 users (warm, through the real code): newest page of 50 about 40 ms; name part 65 to 85 ms; "first last" about 110 ms; email about 80 to 100 ms; phone about 120 ms; no match about 65 ms; deep page 46 ms. Roughly linear in users, so about 10x at 1,000,000. I added no index: a created_at index would only trim the page sort (about 40 ms) and a name index needs the trigram extension, which is not a plain additive index. Say if you want either.

## Runs
- `npx tsc --noEmit`: clean.
- Lint: `eslint` (no `--fix`) on my four files: clean. Whole-repo lint, without `--fix`, already reports 51 errors in files I did not touch (prettier format, e.g. `policies.service.ts`, `provisioning.service.ts`); I left them.
- New spec, 3 runs in a row: 28/28, 28/28, 28/28.
- Same spec on a real Postgres 16 (`SPEC_DB_URL`, migrations applied): 28/28. This found a real bug the stand-in table could not: Prisma passes `%` and `_` of `contains` to LIKE, so `q` of `%%` matched everyone. Fixed by escaping (`plain()`), and tested.
- Specs that cover `internal.controller.ts` (anonymise-phone-proof, data-export-email, two-tick-verification, pin-reset-code-email, money-check-report): 5 suites, 138/138.
- Whole suite, `npx jest`: 53 suites passed, 1 skipped; 1003 passed, 50 skipped, 0 failed. The skipped ones are the existing DB-gated specs, not mine, unchanged. No failures, so nothing to compare to `origin/main`.
- CI (`branch-checks.yml`, `deploy.yml`) runs `prisma migrate deploy`, `tsc --noEmit`, `npm run build`; it does NOT run jest. I did not run `npm run build`; `tsc` passes.

## What I could not prove
- No call to the live service or to the Hub; the Hub's side of the contract is untested here.
- The default spec uses an in-memory stand-in for the table (so it runs with no database); it is only as good as that stand-in. The real-database run above is the check on the actual SQL, and it is not part of CI.
- Timings are from a scratch machine and synthetic rows (short names), not the live table.
- "first last" with more than 8 spaces in `q` is only tried at the first 8 spaces.

## Fix round 1
Code head `851c99a` on `wmt/USERS-DASH` (this report is committed after it). Source diff of the round without specs: +73 / -13 lines in 3 files (`users-list.ts` +49/-12, `phone.util.ts` +15, `auth.service.ts` +9/-1). Whole feature without specs against `origin/main`: 361 added lines in 4 files.

1. **Phone in a local or bare international form (MEDIUM).**
   - `src/common/phone.util.ts:194` `callingCodes()`: every calling code of `COUNTRY_CODES` that the phone library supports, once each (207 candidates for one local number). It is derived from the one country list; no second list.
   - `src/auth/users-list.ts:177` `phoneCandidates()`: besides the old Nigerian variants, a digits-only `q` also tries `+<digits>` (bare international) and, if it starts with 0, `+<dial><rest>` for every calling code.
   - `src/auth/users-list.ts:199-208` `looksLikePhone()`: a `q` of only digits and phone marks (`+ ( ) - .` and spaces) with 7 to 15 digits is searched as the phone only, one exact `phone in (...)`. This is a choice I made so it stays an index lookup: without it the name branch forces a table scan. Cost: a name made only of digits is no longer found by `q`. Other `q` text still searches name, email and phone as before.
   - EXPLAIN on 100,000 users, `07911 123456` (207 candidates): `Index Scan using wawu_users_phone_key`, 0.65 ms.
   - Specs: UK in 7 forms, Ghana in 6 forms, Nigerian in 8 forms, partial numbers still find nothing.
2. **NUL in `q` (LOW).** `users-list.ts:125`: 400 with fixed text. Spec with three NUL shapes.
3. **Failure log (LOW).** `auth.service.ts:672` and `:699`: one fixed line, `users/list: database call failed (<ErrorClassName>)`, nothing else. Spec: three failing requests (q with an email, q with a phone, ids) give exactly three lines, each exactly that text, none with the email, phone or id.
4. **Lead ruling: banned and pending_deletion are returned.** `users-list.ts:161` `OPEN_ACCOUNT_WHERE` renamed `NOT_DELETED_WHERE`, now only `deletedAt = null` and phone not `deleted:...`. What an admin sees now, in the list and by `ids`:
   - active, suspended, banned, pending_deletion: returned, same nine fields (no `status` field, so the Hub cannot tell them apart from this route).
   - deleted (`deletedAt` set, or `deleted:<id>` phone): left out.
   - `released:<id>` phone: returned, phone `""`.
   Specs changed to match (the old "left out" expectations for banned and pending_deletion were rewritten, as the ruling asks).

Runs: `tsc` clean; eslint (no `--fix`) clean on the five touched source files; new spec 3 times in a row 33/33, 33/33, 33/33, and 33/33 on real Postgres 16; the five controller specs plus `src/common`: 8 suites, 245/245; gates `run.py` 0 fail (48 warn, as before), `check_baseline.py` ok. I did not run the whole suite or `npm run build` this round.

Not proven: the 100,000-row EXPLAIN is a scratch table; finding 2 (key versus body parser) left as ruled.
