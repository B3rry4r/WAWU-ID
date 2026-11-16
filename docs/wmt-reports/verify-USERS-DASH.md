VERDICT: fix
INTERIM

# Verify USERS-DASH (interim)

Branch under test: `wmt/USERS-DASH` at ad2e669, merge-base 3216e46. Real app, real HTTP, local Postgres 16 with the repo's migrations.

## Findings so far
1. **MEDIUM. A UK or Ghana number in local form, or in international form without `+`, finds nothing.** `q` = `07911 123456`, `447911123456` (UK) and `024 123 4567`, `0241234567`, `233241234567` (Ghana) all return 0 items for stored `+447911123456` and `+233241234567`. `+447911123456`, `+44 7911 123456`, `+233241234567` work. Nigerian forms all work. Cause: `searchWhere` (`src/auth/users-list.ts`, `comparablePhone` + `phoneVariants`) only knows Nigerian local forms; the util reads any other number only with its `+`. The owner's list asks for local and international form for UK and Ghana. Fix: for a digits-only `q`, also try each supported dial code with the leading 0 dropped, as exact `phone in (...)`; stays index-friendly.
2. **LOW. A bad key does not beat a bad body.** Malformed JSON with a wrong key answers 400 "Unexpected end of JSON input"; a 3 MB body with a wrong or missing key answers 500. The global body parser (`src/main.ts`, `src/mail/mail-relay-body.ts`) runs before the guard. `users/lookup` is the same (and worse: it answers 400 "must be a UUID" to a missing key). With a valid-JSON body, no key / wrong / empty / wrong header / access token all give 401 "Invalid service key". No data leaks; the contract line "before the body is read" does not hold for bad bodies.
3. **LOW. `q` containing a NUL character answers 500 "Could not list users."** It should be 400. Fixed text, no leak.
4. **LOW. A database failure leaves no log line at all** (`auth.service.ts` catch is silent). Nothing leaks, but an operator cannot see the outage from this route.

## Held so far
Nine fields exactly, no hash or other column in the raw JSON (user with every column filled). `ids`: found, missing, duplicates, non-uuid, 200 ok, 201 = 400, empty, non-array, non-string all as the contract says. Closed accounts (banned, pending_deletion, deletedAt, `deleted:` phone) left out of list and `ids`; suspended and `released:` accounts kept, phone shown as "". Cursor walk with 50 accounts added and 10 closed mid-walk: no duplicate, no untouched account missed. Tampered cursors 400. `limit` 0, 101, "5", 2.5, -1 all 400. `q`: names any case, "first last", whole email any case, part of email no, part of phone no, `%` `_` `\` quotes and SQL text plain. Logs: with good, bad and failing-database requests no email, phone or `q` appears in the server log or in an error body. `/users/list` (no `internal`) is 404; GET is 404. tsc clean; eslint clean on the four changed files; new spec 28/28 three times; the 5 specs covering the controller 138/138.

Still to run: speed at 100,000 users, full jest, npm run build result, CI/deploy notes, banned-account judgement.
