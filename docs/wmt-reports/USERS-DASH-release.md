# USERS-DASH: the lead's release record (WAWU ID)

17 Nov 2026. Ruling R-142 (the dashboard has a Users page), from the owner's question of 16 Nov. Task file `tasks/USERS-DASH.md` in the mobile repo.

- What it adds: `POST /internal/users/list`, behind the service key like the other internal routes. The Hub calls it to show names, emails, phones and the sign-up country on the dashboard's Users page, and to fill a country for accounts that never chose one (R-143). No other route changes. No migration.
- Built by a Sonnet builder: `wmt/USERS-DASH` ad2e669, fix round 1 851c99a (73 source lines without specs).
- Checked by a separate Sonnet verifier, tier T2: `docs/wmt-reports/verify-USERS-DASH.md` (copied here from `wmt/USERS-DASH-verify` 2889114). Round 1: fix, one medium (a UK or Ghana phone in local form found nobody). Re-check of fix round 1: **merge**.
- Lead ruling (default, the owner may override): `ids` and the list return banned and pending-deletion accounts, so an admin can find them; only deleted accounts are left out. The nine fields are unchanged.
- On record, low, not fixed here: a malformed or oversized body is answered by the body parser before the key is checked (the same as `lookup`).
- This repo's CI runs the build, the type check and the gates, not jest. The 28 plus new specs were run by the builder and the verifier against a real database.
- Release order: this first, then the Hub (PR #272 there), then the dashboard.
