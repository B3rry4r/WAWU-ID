VERDICT: merge

# Verify USERS-DASH: POST /internal/users/list

Tested `wmt/USERS-DASH` at ad2e669 (merge-base 3216e46, confirmed). Real built app (`npm run build`, `node dist/main.js`), real HTTP, local Postgres 16 with all repo migrations. No product code or existing test changed; my attack scripts are not committed.

One medium (phone forms) means `fix`. Everything else is low. The fix is small.

## Findings

### 1. MEDIUM. UK and Ghana numbers in local form, or bare international form, find nothing
`q` of `07911 123456`, `447911123456` (stored `+447911123456`) and `024 123 4567`, `0241234567`, `233241234567` (stored `+233241234567`) all return `items: []`. These work: `+447911123456`, `+44 7911 123456`, `+233241234567`, `+233 24 123 4567`, and every Nigerian form (`0803 123 4412`, `+2348031234412`, `2348031234412`, `08031234412`, `+234-803-123-4412`, `(0803) 123-4412`, `00234 803 123 4412`).
Cause: `searchWhere` (`src/auth/users-list.ts:158-185`, phone part) uses `comparablePhone` and `phoneVariants` (`src/common/phone.util.ts:129`, `:143`). They know Nigerian local forms only; any other number must carry its `+`. The brief asks for a UK and a Ghana number in local and international form. An admin typing a Ghana user's local number gets "no one".
Fix: for a digits-only `q`, also try each supported dial code with a leading 0 dropped (and the bare `<dial><number>` form) as exact `phone in (...)`. Stays an index lookup on `wawu_users_phone_key`. Add specs for UK and Ghana.
Side note, not a defect: `8031234412` (Nigerian number without the 0 or 234) finds the user. It is the whole national number, not a part; I accept it.

### 2. LOW. A bad key does not beat a bad body
Steps: `POST /internal/users/list` with `x-service-key: nope` and body `{"ids":[` gives 400 "Unexpected end of JSON input". A 3 MB body with a wrong key, or with no key, gives 500 "Internal server error" (body-parser's 413 is turned into 500 by the filter). Cause: the global `json()` parser (`src/mail/mail-relay-body.ts`, `useBodyParsers`, used by `src/main.ts:12`) runs before any guard; only `/internal/mail/send` has a key check ahead of it. `users/lookup` behaves the same, and worse: its DTO pipe answers a missing or wrong key with 400 "each value in ids must be a UUID". For a well-formed body, `list` is better than `lookup`: no key, wrong key, empty key, key in `Authorization`, a Bearer access token all give 401 "Invalid service key" and no database call. No data leaks. The brief's "before the body is read" holds only for valid JSON under 100 kb. Fix (optional, one place): extend the pre-parser key check in `useBodyParsers` to `/internal/*`.

### 3. LOW. `q` with a NUL character answers 500
`{"q":"a\u0000bc"}` gives 500 "Could not list users." (Postgres refuses NUL). Should be 400. Fixed text, no leak. Fix: reject `\u0000` in `parseListBody`.

### 4. LOW. A database failure writes no log line
With Postgres stopped, three requests (a `q`, an `ids`, a phone `q`) each gave 500 "Could not list users." and the server log gained 0 lines. Nothing leaks, but an operator cannot see the outage from this route. Fix: log a fixed line (error class name only).

### 5. INFO. Speed grows with the table
Whole table is scanned for every `q` and for the newest page (see numbers). At 100,000 rows nothing is near 300 ms. At about 1,000,000 rows expect 0.4 to 1 s. If that is ever reached: `pg_trgm` GIN indexes on `lower(first_name)`, `lower(last_name)` and an index on `(created_at desc, id desc)`. Not needed now.

## Judgement: closed accounts left out (banned, pending_deletion, deleted)
Grade: **acceptable for deleted and pending_deletion; wrong default for banned (medium-ish product risk, not a code defect, owner's call).**
- Deleted and `deleted:<id>` phone accounts: leaving out is right; the data is erased or being erased.
- Banned: an admin Users page is the place an admin looks for a banned person to review or unban. With this route they vanish from the list, so the admin cannot find them. Worse, the Hub fills country by `ids`; if a Hub row for a banned person exists elsewhere (reports, orders), it would show with no name or contact.
- Pending_deletion: the person can still cancel deletion in the window; an admin may need to see them. Showing them with a `status` would be best.
- Recommendation: return banned and pending_deletion in `ids` always, and in the list; add a `status` field only if the Hub agrees (the nine-field contract forbids it today). Until then, keep the built choice for deleted only. The change is `OPEN_ACCOUNT_WHERE` (`users-list.ts:~140`). I did not grade this as a blocker because the owner's order said "closed accounts are left out" and the builder flagged it.
- Suspended accounts are kept (good). `released:<id>` accounts are kept with `phone: ""` (good).

## Passes

### V1 Diff against origin/main: passed
Exactly five files: `docs/wmt-reports/USERS-DASH.md`, `src/auth/auth.service.ts` (+42, imports and `listUsers` only), `src/auth/internal.controller.ts` (+22, one new route), `src/auth/users-list.ts` (new), `src/auth/users-list.spec.ts` (new). 952 insertions, 0 deletions. No schema, migration, guard, existing route or test changed.

### V2 Guard: passed on contract, failed on strict reading (finding 2)
Valid-JSON body: no key, wrong, empty, key in `Authorization`, Bearer token: all 401 `{"statusCode":401,"message":"Invalid service key"}`. Malformed or huge body with a bad key: 400/500 from the body parser (finding 2, same as `lookup`). Route is `/internal/users/list` only: `/users/list` 404, GET 404; no global prefix; `InternalController` is the only controller at `internal/users`.

### V3 Response: passed
Raw JSON for a user with every column filled (hash, token ids, trust score, onboarding ref, app ids, gender, occupation, verification dates all set): keys exactly `countryCode, createdAt, email, emailVerified, firstName, id, lastName, phone, phoneVerified`. No hash, token, code, PIN, BVN or NIN (those are not selected; the Prisma `select` is `LIST_SELECT`). Not wrapped in `data` (the Hub accepts both).

### V4 Behaviour: passed except finding 1 and 3
- `ids`: found/missing mixed 2 of 4; duplicates collapsed; non-uuid just not found; 200 ids ok; 201 = 400; `[]` = 400; non-array, numbers, object = 400; upper-case uuid found; `ids` wins over bad `q`/`limit`/`cursor`; `nextCursor` null.
- Closed accounts: banned, pending_deletion, `deletedAt`, `deleted:` phone excluded from `ids` and list; suspended and `released:` kept.
- Walk: 120 accounts with createdAt ties, limit 7, 21 pages; after page 2 added 50 accounts, after page 3 banned 10. No duplicate; every untouched account seen exactly once.
- Cursor: `abc`, appended char, bad uuid, huge number, `!!!`, number, object, newline-injected: all 400. `limit` 0, 101, "5", 2.5, -1: 400; 1, 100, null, 1e0: 200.
- `q`: first part, last part, any case, "first last" and a middle part of both, whole email any case: match. Email part (`okonkwo@ex`, `@ex.test`), phone parts (`803123441`, `0803123441`, `+234803123`, `31234412`): no match. 1 char, empty, only spaces: 400; 120 ok; 121 400; number/array/object: 400. `%%`, `__`, `\\`, `' OR 1=1 --`, `'; DROP TABLE wawu_users;--`: no match, table intact. `50%`, `o'br`, `\ien`, `we_ird%@ex.test` (any case) match only their own row. `released:xyz` and `deleted:abc` match nothing. Many spaces (110) and 30 splits: 200.

### V7 Logs: passed (no personal data)
Full Nest logging on. After about 230 requests (good, bad, failing database): 0 hits in the server log for the emails, phones, `q` strings or SQL text sent; error bodies are fixed text. (Finding 4: the failure is not logged at all.)

### V8 Speed, 100,000 users: passed
Through real HTTP, median of 5 warm runs: newest 50 = 55 ms; newest 100 = 50; deep page = 16; name part = 79 (common name 66); "first last" = 105; whole email = 74; phone (0xxx or +234) = 79 / 78; no match = 67; ids of 200 = 4. Nothing over 300 ms. EXPLAIN: newest and every `q` = parallel seq scan + top-N sort, 36 ms and 107 ms; `ids` = primary-key index scan 0.06 ms. Linear in rows (finding 5).

### V9 Gates: passed
- `npx tsc --noEmit`: clean.
- `npm run build`: exit 0 (builder had not run it).
- eslint, no `--fix`, on the four changed source files: clean.
- New spec x3: 28/28, 28/28, 28/28.
- Controller specs (anonymise-phone-proof, data-export-email, two-tick-verification, pin-reset-code-email, money-check-report): 5 suites, 138/138.
- Whole jest, once: 53 suites passed, 1 skipped; 1003 passed, 50 skipped, 0 failed.
- `scripts/gates/run.py`: 0 fail, 48 warn; `check_baseline.py` ok; `check_deploy_in_sync.py` ok.
- CI: `branch-checks.yml` (wmt/**) runs migrate, tsc, build and the deploy-sync check. `gates.yml` runs the gate scripts. Neither runs jest, so the 28 new tests and my real-database checks are never run by CI. `deploy.yml`: a push to `main` builds, rsyncs to the droplet, runs `deploy/deploy.sh`, restarts and probes JWKS. **A merge to main goes live by itself.** No migration in this change, so deploy is additive. `railway.json` only sets `npm run start:prod` (runs `prisma migrate deploy`).

## What I could not prove
- No call to the live service, the Hub or a real mailbox/phone; the Hub's side of the contract is untested.
- Timings are on one scratch machine with synthetic short names, not the live table.
- Banned-person display in the Hub I did not see; judged from the contract text only.
- Each `q` finding was run once against my seeded rows, not exhaustively across all phone formats of every country.

---

# Re-check of fix round 1

Tested `wmt/USERS-DASH` at 98ee1d8 (code 851c99a), built and run as before: real app, real HTTP, local Postgres 16, 100,000 seeded users. **VERDICT: merge.** Nothing medium or worse left. Finding 2 (a bad body beats a bad key) is unchanged and still low, as before; it was not in this round.

## 1. Finding 1 (medium, phone forms): fixed
- UK `07911 123456`, `07911123456`, `447911123456`, `+447911123456`, `+44 7911 123456`: find the UK user.
- Ghana `024 123 4567`, `0241234567`, `233241234567`, `+233241234567`, `+233 24 123 4567`: find the Ghana user.
- All eight Nigerian forms from round 0 (`0803 123 4412`, `+2348031234412`, `2348031234412`, `08031234412`, dashes, brackets, `00234 ...`) still find the user.
- Two countries: I seeded a UK `+447911123456` and a Nigerian `+2347911123456`. `07911123456` and `07911 123 456` return both and nobody else. `7911123456` returns only the Nigerian one. `07911123457` returns nobody.
- Parts still do not match: `803123441`, `0803123441`, `+234803123`, `31234412`, `1234567` return nobody. (`8031234412`, the whole Nigerian number without its 0, still finds the user, as before.)
- How: a `q` of only digits and phone marks with 7 to 15 digits is searched ONLY as `phone in (...)` (`users-list.ts` `looksLikePhone`, `phoneCandidates`). The list is exact strings: the old variants, `+<digits>`, and `+<dial code><digits without the leading 0>` for each of 204 calling codes. Exact match only; no `like`, so no guessing by part of a number.
- EXPLAIN, 100,000 rows: `Index Scan using wawu_users_phone_key`, 0.3 ms. HTTP median over 5 runs: Nigerian local 4 ms, `+234` 2 ms, bare international 2 ms, UK local 3 ms (was 78 to 79 ms before, a table scan). Other `q` kinds as before: name part 93 ms, common name 98, "first last" 85, whole email 111 (max 167), no match 94, newest page 34, deep page 17. Nothing near 300 ms.

## 2. Finding 3 and 4: fixed
- `q` with a NUL: 400 `q must be text.` (was 500).
- Database stopped, four requests (two `q`, one phone `q`, one `ids`): each 500 "Could not list users."; server log gained exactly four lines `ERROR [UsersList] users/list: database call failed (PrismaClientKnownRequestError)`. Grep for the emails, phones, `q` and id I sent: 0 hits in log and response.

## 3. Lead ruling carried out: what each account kind returns
In `ids` and in the list alike (checked both):
- active, suspended: returned.
- banned: returned (was left out).
- pending_deletion: returned (was left out).
- `released:<id>` phone: returned, `phone` is `""`.
- deleted (`deletedAt` set): left out.
- `deleted:<id>` phone: left out.
- Still the nine fields, same names (checked on the raw JSON of a user with every column filled earlier; the select and `toListed` shape are untouched). Cursor walk with 50 added and 10 closed mid-walk: no duplicate, every untouched account seen once; the 10 banned during the walk are now returned, as ruled.
- `q` finds banned and pending_deletion people by name (`Banned`, `Pend Ing`); `Gone`, `DelPhone` find nobody.

## 4. Nothing else moved
- `git diff ad2e669 851c99a --stat`: `auth.service.ts` (+10/-1: a Logger and a catch), `users-list.ts`, `users-list.spec.ts`, and `src/common/phone.util.ts` (+15, adds `callingCodes()` and two imports; no existing function changed). Against origin/main: 6 files, 1117 added, the only removals are within the changed branch lines above; `internal.controller.ts` unchanged since round 0 (+22, one new route). `lookup` and all other routes are untouched in the diff.
- Guard: valid-JSON body with no key, wrong, empty, key in `Authorization`, Bearer token: all 401 "Invalid service key". `/users/list` 404, GET 404.
- `npx tsc --noEmit` clean; `npm run build` exit 0; eslint without `--fix` on the five changed source files clean; new spec 3 runs: 33/33 each; the nine suites that touch `phone` (including `phone.util`): 9 suites, 253/253; whole jest once: 53 passed, 1 skipped, 1008 passed, 50 skipped, 0 failed; gates `run.py` 0 fail (48 warn, same as before).

## What I could not prove
- I ran my own attack script again (106 of 111 checks as written); the 5 "fails" were checks written for round 0 that no longer apply or were my wrong guesses (banned now listed; `ada.okonkwo`, `8031234412`, `%_` expectations), each looked at by hand and correct.
- Not run: the Hub, the live service. Numbers are one scratch machine, synthetic rows.
- Phone local forms are tried against every supported calling code, so a local number that is valid in no country still returns nobody; I did not check each of the 204 codes by hand, only the UK, Ghana, Nigeria and a UK/Nigeria clash.
