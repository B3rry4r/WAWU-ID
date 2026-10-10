# WAWUAfrica API Contracts
# Derived precisely from design file data structures (lib/*.jsx)
# Cross-reference note: if any shape seems ambiguous, check the relevant
# lib/*.jsx file in the design ZIP — the data constants ARE the contract.

---

## CONVENTIONS

- All hub endpoints: `BASE/api/hub/*`
- All admin endpoints: `BASE/api/admin/*`
- Auth header: `Authorization: Bearer <wawu_id_jwt>`
- Response envelope:
  ```json
  { "statusCode": 200, "message": "string", "data": {} }
  ```
- Paginated envelope:
  ```json
  { "statusCode": 200, "message": "string", "data": [],
    "pagination": { "currentPage": 1, "nextPage": 2, "perPage": 20, "total": 120 } }
  ```
- Timestamps: ISO 8601 strings
- Verification: two independent ticks, not a tier. Every user on the wire carries
  `verification: { creator: { verified, expiresAt }, professional: { verified, expiresAt } }`.
  See Section 1, PATCH /internal/users/:wawuId/verification.
- Trust tier enum (LEGACY, still on the wire, read `verification` instead):
  `basic | verified_user | verified_business | certified_professional | trusted_partner | official`
- Post status enum: `published | pending | rejected`
- User status enum: `active | suspended | banned`

---

## 1. WAWU ID SERVICE CONTRACTS

Source: `lib/onb-screens.jsx`

### POST /auth/register
```json
Request:
{
  "fullName": "Ada Okeke",
  "email": "ada@email.com",
  "phone": "+2348012345678",
  "dialCode": "+234",
  "country": "Nigeria",
  "state": "Lagos",
  "occupation": "Agripreneur",
  "password": "min8chars"
}

Response 201:
{
  "data": {
    "accessToken": "eyJ...",
    "refreshToken": "eyJ...",
    "user": {
      "id": "uuid",
      "fullName": "Ada Okeke",
      "email": "ada@email.com",
      "phone": "+2348012345678",
      "country": "Nigeria",
      "state": "Lagos",
      "occupation": "Agripreneur",
      "verificationTier": "basic",
      "trustScore": 0,
      "status": "active"
    }
  }
}
```

### How a mobile sign-up is verified: `SIGNUP_VERIFY_CHANNEL` (AUTH-07)
One setting decides what the code at A4 proves and how it travels (mobile repo
DECISIONS.md R-39; owner, 6 Oct 2026: Fintava, and with it SMS, is being removed):

| `SIGNUP_VERIFY_CHANNEL` | the 6-digit code is | it proves | routes that work |
|---|---|---|---|
| `phone` (default) | texted to the phone through the SmsProvider (Fintava) | the phone, exactly as AUTH-03 built it | `POST /auth/signup`, `/auth/phone/verify/start`, `/auth/phone/verify/confirm`, `/auth/signup/resume` |
| `email` | **mailed** to the email typed at sign-up, through the same mailer as every other mail | the EMAIL (`email_verified`); the phone is stored, not proven (`phone_verified_at` stays empty) | `POST /auth/signup`, `/auth/signup/email-code/start`, `/auth/signup/email-code/confirm`, `/auth/signup/resume` |

**Release steps, in this order.** The default is `phone` so that deploying this service
changes nothing by itself.
1. Deploy this service with the value unset or `phone`. Nothing changes for anyone.
2. Release the app build with email codes to testers. An older build and a sign-up already
   waiting on a text keep working while the value is `phone` (the new build draws the texted
   screens when the answer carries no `channel`; only A3's line says email).
3. Confirm Resend in production: `RESEND_API_KEY` is set on this service and the sending
   domain is verified, shown by a real mail arriving in a real mailbox.
4. Set `SIGNUP_VERIFY_CHANNEL=email` and restart.
5. From then an older app build, and any sign-up still waiting on a text, is refused (409
   `SIGNUP_CHANNEL_DISABLED`; the person starts again at A3).
Rolling back is setting `phone` and restarting.

- Only a literal `email` (any case, trimmed) selects email. Anything else, nothing, a typo, or
  `sms` (this value's earlier name), is `phone`: a typo never switches off the sign-up that
  is live. The value is read at start; change it and restart to switch.
- A route of the channel that is not active answers **409 `SIGNUP_CHANNEL_DISABLED`**
  (`{ statusCode, code, message }`), before it checks anything or spends anything. No route
  is removed, the SMS provider and the phone-code routes stay, so `phone` is the old
  behaviour byte for byte (the `phone` answers carry no new field).
- A sign-up started under one channel is answered `step: 'details'` by `resume` once the
  other is active (its code went the other way): the person starts again at A3. Nothing is
  lost: a new sign-up replaces the unproven one.
- The limits are the phone code's, from the same config, counted on the email where the
  phone code counted the number (below). The wrong-code rules and the 60 s resend gap are
  the same. A mailed code lives 600 s (`SIGNUP_EMAIL_CODE_TTL_SECONDS`), because the mail
  says "expires in 10 minutes".
- A mailed sign-up that is confirmed is in the sign-up sequence (its `signup_progress` row
  is made at confirm) and its `email` step is already done, so the next step is A11 or A12.
- No code is ever logged by these routes. Mail is handed over strictly: no transport
  (`RESEND_API_KEY` unset) answers 503 `EMAIL_NOT_CONFIGURED` and an error from Resend
  answers 503 `EMAIL_SEND_FAILED` on the sign-up and on a resend alike, with no account
  written for the first, and, for the others, the reserved mail given back, no wait held
  against the person, and (on a resend) the code that was live left working.
- **A phone is held only once it is proven.** With `email`, a typed number is not proven, so
  it is not held against a newer sign-up for it: the newer sign-up takes the number and the
  older account keeps everything but the number (its `phone` becomes `released:<id>`, which
  every client reads as no phone). This applies to an account that finished a mailed sign-up
  and whose `phone_verified_at` is empty. A proven number, and the number of a long-standing
  (web or legacy) account that is not in the sign-up sequence, are held as before (409). A
  code sent to a number its account only typed does not reset that account's password or
  sign in to it (`forgot-password` by text, `reset-password` by text, `otp/verify`).

#### POST /auth/signup with `channel: email` (`SIGNUP_VERIFY_CHANNEL=email`)
```json
Response 201:
{ "data": { "phone": "+2348031234412", "expiresIn": 600, "resendIn": 60,
            "attempt": "Xk3...43 chars, unguessable, keep it",
            "emailCodeRequired": false,
            "channel": "email", "maskedEmail": "a•••@example.com" } }

Error 400 PHONE_INVALID / PHONE_NOT_SUPPORTED   as below (the number is still Nigerian only, R-36)
Error 409                      as below
Error 429 RATE_LIMITED / EMAIL_CODE_RESEND_TOO_SOON   with retryAfterSeconds
Error 503 EMAIL_NOT_CONFIGURED / EMAIL_SEND_FAILED
```
An email held by a **phone-proven** mobile account that never proved it is still never
taken from it, but there is no second code: the one mailed code is the proof, and the
email moves to the new account when it is entered (`emailCodeRequired` stays false).

#### POST /auth/signup/email-code/start (mail another code)
For the holder of a sign-up's `attempt`. Any other call gets the same answer, mails nothing.
```json
Request:  { "phone": "+2348031234412", "attempt": "Xk3..." }
Response 200: { "data": { "phone": "+2348031234412", "expiresIn": 600, "resendIn": 60, "channel": "email" } }
Error 409 SIGNUP_CHANNEL_DISABLED
Error 429 EMAIL_CODE_RESEND_TOO_SOON / RATE_LIMITED
Error 503 EMAIL_NOT_CONFIGURED / EMAIL_SEND_FAILED   (a refused resend: the code that was live still works)
```

#### POST /auth/signup/email-code/confirm
Gives a session only to the account that sign-up created.
```json
Request:  { "phone": "08031234412", "attempt": "Xk3...", "code": "481902" }
Response 200: { "data": { "accessToken": "eyJ...", "refreshToken": "eyJ...", "user": {...} } }

Error 400 EMAIL_CODE_INVALID   wrong code, expired, a wrong or replaced attempt, nothing
                               pending for that number (the same answer for all of them)
Error 409 EMAIL_ALREADY_CONFIRMED / SIGNUP_CHANNEL_DISABLED
Error 429 EMAIL_CODE_LOCKED (4 wrong in a row, then 900 s) / RATE_LIMITED
```
After it the account has `email_verified = true`, `phone_verified_at = NULL`, and signs in
by email, or by phone typed either way (the local-form lookup also finds an account in the
sign-up sequence).

#### POST /auth/signup/resume, with `channel: email`
`{ step: 'phone', phone, expiresIn, resendIn, emailCodeRequired: false, accountType,
channel: 'email', maskedEmail }` (the step is still named `phone`: it is the code step,
whichever way the code travels).

The text below describes `SIGNUP_VERIFY_CHANNEL=phone` (the default).

### POST /auth/signup (mobile sign-up, phone code)
Creates the account and texts a 6-digit code to the phone. **Issues no session**:
the session comes from `/auth/phone/verify/confirm`. The phone may be written
`0803...`, `+234 803...` or `2348031234412`; it is stored as `+2348031234412`.
Only Nigerian numbers (`+234`, config `SIGNUP_ALLOWED_PHONE_PREFIX`) are texted.
The answer carries an `attempt` secret, shown once: the next two calls need it
with the phone, so a code only works in the sign-up that asked for it.
```json
Request:
{
  "email": "ada@email.com",
  "phone": "08031234412",
  "password": "min8chars",
  "occupation": "Photographer",   // optional
  "accountType": "creator"        // optional, "user" | "creator"
}

Response 201:
{ "data": { "phone": "+2348031234412", "expiresIn": 300, "resendIn": 60,
            "attempt": "Xk3...43 chars, unguessable, keep it",
            "emailCodeRequired": false } }

Error 400 PHONE_INVALID        not a usable phone number
Error 400 PHONE_NOT_SUPPORTED  a valid number that is not Nigerian; nothing is sent
Error 409                      the email or phone belongs to an account that is not an unconfirmed
                               mobile sign-up: a phone-proven mobile account (phone), or a web, legacy
                               or email-verified account (email or phone)
Error 429 RATE_LIMITED / PHONE_CODE_RESEND_TOO_SOON   with retryAfterSeconds and a Retry-After header
Error 503 SMS_NOT_CONFIGURED / SMS_SEND_FAILED        no account is created for the first
```
- A later sign-up for a phone (or email) held by an **unconfirmed** sign-up replaces
  it, and the replaced sign-up's `attempt` stops working (a code texted for one
  sign-up cannot be redeemed in another). An unconfirmed sign-up can no longer be
  confirmed 24 hours after it was made (`PENDING_SIGNUP_TTL_SECONDS`) and then holds
  neither its email nor its phone, even against `POST /auth/register`.
- An email held by a **phone-proven** mobile account (one that never proved its
  email) is never taken from it. The new sign-up is created without an email and the
  answer says `emailCodeRequired: true`; a code is mailed to that address, and the
  email is given to the new account only when `confirm` also carries that code
  (`emailCode`). The other account keeps its phone, proof and password and signs in by
  phone. Web, legacy and email-verified accounts are never touched (409).

### POST /auth/phone/verify/start (send another code)
For the holder of a sign-up's `attempt`. Any other call (an unregistered number, a web
or legacy account, an account whose phone is proven, a wrong or replaced `attempt`)
gets the same answer, sends nothing and spends nothing but the caller's own address
allowance.
```json
Request:  { "phone": "+2348031234412", "attempt": "Xk3..." }
Response 200: { "data": { "phone": "+2348031234412", "expiresIn": 300, "resendIn": 60 } }
Error 429 PHONE_CODE_RESEND_TOO_SOON / RATE_LIMITED   { "statusCode", "code", "message", "retryAfterSeconds" }
```

### POST /auth/phone/verify/confirm
Gives a session only to the account that sign-up created, never to an existing account.
```json
Request:  { "phone": "08031234412", "attempt": "Xk3...", "code": "481902", "emailCode": "123456" }
          // emailCode only when sign-up said emailCodeRequired
Response 200: { "data": { "accessToken": "eyJ...", "refreshToken": "eyJ...", "user": {...} } }

Error 400 { "statusCode": 400, "code": "PHONE_CODE_INVALID", "message": "That code isn't right" }
          (wrong code, expired, a wrong or replaced attempt, nothing pending for that number:
          the same answer for all of them)
Error 409 PHONE_ALREADY_CONFIRMED   a second request with the same code, at the same moment
Error 429 { "statusCode": 429, "code": "PHONE_CODE_LOCKED", "message": "...", "retryAfterSeconds": 900 }
          (the fourth wrong code in a row, and every call until the wait is over, even with the
          right code; also once a number has taken its daily cap of wrong codes)
Error 429 RATE_LIMITED              too many checks from one address
```
Wrong codes are counted per phone number, so asking for a fresh code or signing up again
never gives guesses back. Only a call that carries a live `attempt` for that number is
counted, so a stranger cannot lock a number or use up its budget.

### Who gets a session before the phone code (D-2)
An account created by `POST /auth/signup` whose phone code is still pending holds **no
session from any route**. Every route in this service that hands out tokens goes through
`TokensService.issueTokens`, which refuses (403 `PHONE_NOT_CONFIRMED`), and the routes
that change state first refuse before they write anything:
`POST /auth/login`, `/auth/refresh`, `/auth/otp/verify`, `/auth/email/verify/confirm`,
`/auth/reset-password` (code by SMS), `/auth/activate`, `/auth/register` (cannot reach
such an account: it answers 409 for a live one), and `/auth/phone/verify/confirm` (which
deletes the pending state first). Web and legacy accounts have no pending state and are
answered exactly as before. `POST /auth/register` is unchanged: it still issues tokens
before any confirmation (BACKEND_GAPS G-2 in the mobile repo).

### Limits on the sign-up phone routes
All in `src/auth/phone-verification.config.ts`, each overridable in the environment,
each PROVISIONAL until the owner confirms it. Counters live in the database, so they
hold across instances; the daily text budget is reserved atomically before a text is
sent (a burst never sends more than the budget) and given back if the text is not sent.

| Limit | Default | Worst case at 7 naira a text |
|---|---|---|
| requests from one address (signup and start) | 30 an hour, 100 a day | 100 texts, 700 naira a day |
| texts sent to one number | 5 a day, 1 a minute | 5 texts, 35 naira |
| texts sent in all, per day | 2,000 | 14,000 naira: it takes about 20 addresses |
| code checks from one address | 120 an hour | no text |
| wrong codes in a row, then wait | 4, then 900 s | no text |
| wrong codes per number per day | 12 | no text; chance of guessing a code at most 12 in 1,000,000 a day |
| life of a code / of an unconfirmed sign-up | 300 s / 24 h | |

A stranger who signs up with someone else's phone gets texts sent to that number and
uses up its 5 a day; the real owner is then told to wait until the window ends. That is
the cost of letting anyone start a sign-up without proving the phone first, and is
bounded by the per-address limits.

### Client address
The per-address limits count the address in `X-Real-IP`, which nginx sets from the
connection (`proxy_set_header X-Real-IP $remote_addr`, wawu-backend
`deploy/install-services.sh`) so a client cannot choose it; without it, the LAST
`X-Forwarded-For` entry; never the first (client-written). An IPv6 address counts as its
/64 prefix. This holds only while nginx is the first hop and the service is not reachable
except through it. Behind a CDN or load balancer every caller would share one address
(the proxy's) and 30 sign-ups an hour would be all there is; the proxy's own header would
have to be trusted instead. Reached directly, without nginx, a client can write its own
`X-Real-IP`.

### The sign-up sequence (AUTH-05)
The published contract for every route the mobile app calls is `contract/openapi.json`,
generated from the code by `npm run contract:build` (a test fails when it is out of date);
the app generates its types from it. The order, enforced here:

| step | screen | route | session |
|---|---|---|---|
| account type | A2 | sent with `POST /auth/signup` (`accountType`; none reads as `user`) | none |
| details | A3 | `POST /auth/signup` | none |
| phone | A4 | `POST /auth/phone/verify/confirm` (the first session) | none |
| `email` | (no artboard) | `POST /auth/signup/email/start`, `/email/confirm`, or put off | yes |
| `creator_setup` | A11 | `POST /auth/signup/progress {step}` (earning: `creator`) | yes |
| `interests` | A12 | `POST /auth/signup/progress {step}` (discovering: `user`) | yes |
| `follows` | A13 | `POST /auth/signup/progress {step}`, after `interests` | yes |

No step runs an identity check and none opens a wallet (R-6): the only call this service
makes to Fintava during sign-up is the text.

### POST /auth/signup/resume
For an app closed between A3 and A4. Sends nothing, changes nothing.
```
Request:  { phone: string, attempt: string }
Response 200: { data: { step: 'phone', phone, expiresIn, resendIn, emailCodeRequired, accountType } }
          or  { data: { step: 'details' } }   (no live sign-up for this secret: start again at A3, or sign in)
Errors:   400 validation, 429 RATE_LIMITED (resume checks per address, 120 an hour, PROVISIONAL)
```
`expiresIn` and `resendIn` are what is left (0 means ask for a new code / resend now). A
made-up, replaced, expired or already confirmed secret all answer `details` after the
same single lookup by the secret's hash.

### GET /auth/signup/progress  (Authorization: Bearer <access token>)
```
Response 200: { data: { step: 'email'|'creator_setup'|'interests'|'follows'|'done',
                        inSequence: boolean, accountType: 'user'|'creator'|null,
                        steps: string[], emailProven: boolean } }
Errors:   401 SESSION_INVALID (no token, a refresh token, expired, another key, a suspended or deleted account)
```
An account is in the sequence when it proved its phone at sign-up (`phone_verified_at`);
its record (`signup_progress`) is made the first time this is asked (parallel first
calls make one record and give the same answer). Every web, legacy
and phone-only account answers `step: 'done', inSequence: false` and gets no record.

### POST /auth/signup/progress  (Bearer)
```
Request:  { step: 'email'|'creator_setup'|'interests'|'follows' }
Response 200: the progress, as above
Errors:   409 SIGNUP_STEP_OUT_OF_ORDER (not the next step, or not this account's),
          409 SIGNUP_ALREADY_FINISHED, 401 SESSION_INVALID
```
Completes the next step only. `email` here means "Later" (the email stays unproven and can
be proven at any time). A step already done answers the progress unchanged.

### POST /auth/signup/email/start  (Bearer)
Mails a 6-digit code to the account's own email (nothing else is ever mailed from here).
```
Response 200: { data: { email, expiresIn: 600, resendIn: 60 } }
Errors:   409 EMAIL_NOT_SET, 409 EMAIL_ALREADY_PROVEN,
          429 EMAIL_CODE_RESEND_TOO_SOON (60 s gap, PROVISIONAL), 429 RATE_LIMITED (5 a day per account, PROVISIONAL)
```
The code lives 600 s, the "10 minutes" the mail states. Only hashes are stored: the code
(argon2) and the address (sha256), so a code proves only the address it was sent to.

### POST /auth/signup/email/confirm  (Bearer)
```
Request:  { code: '123456' }
Response 200: the progress, as above, with emailProven: true
Errors:   400 EMAIL_CODE_INVALID, 429 EMAIL_CODE_LOCKED (the phone code's rules: the fourth
          wrong code in a row waits 900 s, 12 a day), 409 EMAIL_NOT_SET, 409 EMAIL_ALREADY_PROVEN
```
The same right code sent again while it lives (a double tap, at once or after) answers the
same success; any other code once the email is proven answers 409 EMAIL_ALREADY_PROVEN.
A proven email receives the reset link (`POST /auth/forgot-password` with `method: 'email'`)
and the other mail this service sends; an unproven one still does not.

### Login rule (POST /auth/login)
An account with an email must have confirmed it, **or** have proven its phone
(`phone_verified_at` set by `/auth/phone/verify/confirm`). Every account that has
not proven its phone is judged exactly as before (403 `EMAIL_NOT_VERIFIED`).
A phone typed the local way (`0803...`) finds a phone-verified account stored as
`+234...` when the exact lookup finds nothing. The user in the answer carries
`occupation` (as always, null when none) and, only when the account has one,
`accountType`; accounts without one are answered with no such key. Mail (the
sign-in alert and the others sent from this service) goes only to an email that
was proven, or to accounts that never went through mobile sign-up. Changing a
phone number through the internal routes writes the phone and nothing else, so a
mobile account keeps its right to sign in.

### POST /auth/login
```json
Request:
{ "email": "ada@email.com", "password": "ada12345" }

Response 200:
{
  "data": {
    "accessToken": "eyJ...",
    "refreshToken": "eyJ...",
    "user": { same shape as register response user }
  }
}

Error 401: { "statusCode": 401, "message": "Invalid credentials" }
```

### POST /auth/otp/start
```json
Request: { "phone": "+2348012345678" }
Response 200: { "data": { "message": "OTP sent", "expiresIn": 300 } }
```

### POST /auth/otp/verify
```json
Request: { "phone": "+2348012345678", "code": "123456" }
Response 200: { "data": { "accessToken": "eyJ...", "refreshToken": "eyJ...", "user": {...} } }
Error 401: { "statusCode": 401, "message": "Invalid or expired OTP" }
```

### POST /auth/refresh
```json
Request: { "refreshToken": "eyJ..." }
Response 200: { "data": { "accessToken": "eyJ...", "refreshToken": "eyJ..." } }
```

### POST /auth/logout (SETTINGS-03)
```json
Request: { "refreshToken": "eyJ..." }
Response 200: { "data": { "signedOut": true } }
```
The presented refresh token stops working (the account's other tokens are
untouched). The same 200 for a live, an expired, an already-used, a forged and
an unknown token, so it tells nobody which is which. 400 validation, 429
RATE_LIMITED (30 a minute per client address).

### POST /auth/change-password  (Authorization: Bearer <access token>) (SETTINGS-03)
```json
Request: { "currentPassword": "...", "newPassword": "8 to 128 characters" }
Response 200: { "data": { "accessToken": "eyJ...", "refreshToken": "eyJ..." } }
```
Every refresh token and pending reset link of the account is deleted in the
same transaction as the new hash; the response is a fresh pair for the
calling device. Other devices cannot refresh and are out when their access
token (`JWT_EXPIRES_IN`) runs out.
Errors: 400 CURRENT_PASSWORD_WRONG, 400 PASSWORD_UNCHANGED, 400 validation;
401 SESSION_INVALID; 409 PASSWORD_NOT_SET; 429 RATE_LIMITED (five wrong current
passwords in 15 minutes per account, the sixth waits even with the right one;
a right password gives the tries back).

### POST /auth/forgot-password
```json
Request: { "identifier": "ada@email.com", "method": "email" }
Response 200: { "data": { "message": "If an account exists, a reset code has been sent.", "expiresInSeconds": 3600 } }
```
`method: "email"` mails a link to the web reset page. The answer carries
`expiresInSeconds`, the link's real lifetime, and it is the same whether or not
an account exists. Without `method` (or `"sms"`) a code is sent instead and the
answer has `message` only.

### POST /auth/reset-password
```json
Request: { "token": "string", "email": "ada@email.com", "password": "newpass123" }
Response 200: { "data": { "message": "Password reset successfully" } }
```

### POST /auth/activate (one-time link for Category B users)
```json
Request: { "activationToken": "string", "password": "newpass123" }
Response 200: { "data": { "accessToken": "eyJ...", "refreshToken": "eyJ...", "user": {...} } }
```

### GET /.well-known/jwks.json
```json
Response 200:
{
  "keys": [{
    "kty": "RSA",
    "use": "sig",
    "alg": "RS256",
    "kid": "string",
    "n": "base64url",
    "e": "AQAB"
  }]
}
```

### INTERNAL — GET /internal/users/export
Header: `X-Service-Key: <secret>`
Query: `page=1&per_page=500`
```json
Response 200:
{
  "data": [{
    "category": "A|B|C",
    "email": "string",
    "phone": "string",
    "firstName": "string",
    "lastName": "string",
    "country": "string",
    "state": "string|null",
    "passwordHash": "string|null",
    "onboardingRef": "uuid|null",
    "wawuafricaAppUserId": "int|null",
    "sourceCreatedAt": "timestamp"
  }],
  "pagination": { "currentPage": 1, "nextPage": 2, "total": 31000 }
}
```

### INTERNAL — PATCH /internal/users/:wawuId/verification
Header: `X-Service-Key: <secret>`

The two-tick model. There is no ladder and no Trust Score: there are exactly
TWO paid annual verifications, and they are INDEPENDENT, because one person can
hold both roles.

| Verification | Price | Tick |
|---|---|---|
| creator | NGN 4,999 / year | purple |
| professional | NGN 9,999 / year | green |

One call grants, renews or revokes ONE tick. `expiresAt` null on a grant is a
perpetual, admin-granted tick (that is what the backfill from the old ladder
produces). There is no `verified` field to send: whether a tick draws is
derived from the expiry server-side on every read.

```json
Request: { "tick": "creator", "granted": true, "expiresAt": "2027-09-21T00:00:00.000Z" }
Request: { "tick": "professional", "granted": false }
Response 200: { "data": { "id": "uuid", "fullName": "Ada Okeke", "verification": {
  "creator":      { "verified": true,  "expiresAt": "2027-09-21T00:00:00.000Z" },
  "professional": { "verified": false, "expiresAt": null }
}, "verificationTier": "basic", "trustScore": 0, "status": "active" } }
```

`verification` is carried on every WAWU ID response that returns a user (login,
register, OTP verify, refresh, the internal lookup) and in the access-token
claims. The legacy `verificationTier` and `trustScore` fields stay on the wire
unchanged so an older Hub build keeps parsing these responses while both sides
deploy.

### INTERNAL — PATCH /internal/users/:wawuId/trust-score
Header: `X-Service-Key: <secret>`

SUPERSEDED by PATCH /internal/users/:wawuId/verification. Trust Score is gone as
a product surface and nothing replaces it. The route stays reachable, writing
only the legacy `trust_score` column that no read path consults, so an older Hub
calling it mid-deploy gets a 200 rather than a 404.
```json
Request: { "trustScore": 82 }
Response 200: { "data": { "id": "uuid", "trustScore": 82, ... } }
```

### INTERNAL — PATCH /internal/users/:wawuId/verification-tier
Header: `X-Service-Key: <secret>`

SUPERSEDED by PATCH /internal/users/:wawuId/verification, for the same reason
and on the same terms as trust-score above. Writes only the legacy
`verification_tier` column.
```json
Request: { "tier": "certified_professional" }
Response 200: { "data": { "id": "uuid", "verificationTier": "certified_professional", ... } }
```

---

## 2. FEED & POSTS

Source: `lib/feed-data.jsx`, `lib/feed-create.jsx`, `lib/posts.jsx`

### Shared types

**Author object** (appears on every post and comment):
```json
{
  "id": "uuid",
  "name": "Ada Okeke",
  "verificationTier": "verified",
  "trustScore": 82,
  "avatar": null
}
```

**ProductRef object** (attached to Sell posts or any post with product):
```json
{
  "platform": "WAWUBasket | WAWUBeauty",
  "productId": "string",
  "sellerId": "uuid",
  "snapshot": {
    "name": "Ground Egusi · 500g",
    "price": "₦4,500",
    "imageUrl": "string | null"
  }
}
```

**Post object** (full shape):
```json
{
  "id": "string",
  "category": "Learn | Sell | Opportunity | Event | Question | Research",
  "variant": "generic | product | opportunity | event | training",
  "title": "string",
  "body": "string",
  "tags": ["Agriculture", "Business"],
  "author": { ...Author },
  "votes": 128,
  "userVote": "up | down | none",
  "comments": 24,
  "isSaved": false,
  "status": "published | pending | rejected",
  "rejectionReason": null,
  "createdAt": "2026-06-04T10:00:00Z",
  "productRef": null | { ...ProductRef },
  "opportunityMeta": null | {
    "org": "Tony Elumelu Foundation",
    "location": "Nigeria · Ghana · Kenya",
    "deadline": "Closes 30 Jun 2026",
    "adminVerified": true
  },
  "eventMeta": null | {
    "month": "JUL",
    "day": "18",
    "location": "Eko Hotel, Lagos",
    "time": "09:00 – 17:00 WAT"
  }
}
```

### GET /api/hub/feed
Auth: required

Query params:
```
filter: "All" | "Learn" | "Buy" | "Sell" | "Opportunity" | "Event" | "Question" | "Research"
        "Buy" = posts where productRef is not null (any category)
country: "All" | "Nigeria" | "Ghana" | "Kenya" | ...
following: true | false (true = posts from followed topics/sections/businesses only)
page: integer (default 1)
```

Response: `{ data: Post[], pagination }`

Notes:
- Pending posts appear in feed ONLY for their author (filter server-side by wawu_user_id)
- Feed is ordered by recency (no algorithmic ranking in v1)
- "Following" feed: posts from topics the user follows (stored in hub_user_profiles.interests) + businesses they follow (hub_follows)

### GET /api/hub/feed/:id
Auth: required
Response: `{ data: Post }` with full body (no clamping)

### POST /api/hub/posts
Auth: required

Request body by category:

**Learn:**
```json
{
  "category": "Learn",
  "title": "Five record-keeping habits that doubled my farm's margins",
  "body": "string (required)",
  "link": "https://... (optional)",
  "tags": ["Agriculture", "Business"],
  "productRef": null | { ...ProductRef }
}
```

**Sell:**
```json
{
  "category": "Sell",
  "title": "Fresh ground egusi — milled to order, 500g packs",
  "body": "Stone-ground daily. Bulk pricing available. (optional caption)",
  "productRef": { ...ProductRef }
}
```
Note: productRef is REQUIRED for Sell. Reject 422 if missing.

**Opportunity:** (gated — status=pending on creation)
```json
{
  "category": "Opportunity",
  "title": "Calling agri-cooperatives: shared cold-storage pilot, Lagos",
  "type": "Job | Grant | Funding | Scholarship | Tender | Procurement | Accelerator | Competition | Partnership",
  "body": "string",
  "deadline": "2026-07-30 (ISO date, optional)",
  "location": "Lagos, Nigeria",
  "applyLink": "https://... (required for gated)",
  "productRef": null | { ...ProductRef }
}
```

**Event:** (gated — status=pending on creation)
```json
{
  "category": "Event",
  "title": "Pan-African Trade & Export Summit",
  "date": "2026-07-18",
  "time": "09:00",
  "location": "Eko Hotel, Lagos",
  "body": "string",
  "eventLink": "https://... (optional)",
  "productRef": null | { ...ProductRef }
}
```

**Question:**
```json
{
  "category": "Question",
  "title": "How do I register a business name with CAC from Lagos?",
  "body": "string",
  "tags": ["Business"],
  "productRef": null | { ...ProductRef }
}
```

**Research:** (gated — status=pending on creation)
```json
{
  "category": "Research",
  "title": "2026 cassava price index — Q1 field data across 40 LGAs",
  "summary": "string (one paragraph abstract)",
  "body": "string (optional if fileUrl provided)",
  "fileUrl": "string (optional — uploaded file path)",
  "sourceLink": "https://...",
  "productRef": null | { ...ProductRef }
}
```

Response:
```json
{
  "data": {
    ...Post,
    "status": "published | pending"
  }
}
```

### POST /api/hub/posts/:id/vote
Auth: required
```json
Request: { "direction": "up | down | none" }
Response: { "data": { "votes": 129, "userVote": "up" } }
```
Note: "none" removes existing vote. Upvoting your own post: 422.

### POST /api/hub/posts/:id/save
Auth: required
```json
Response: { "data": { "isSaved": true } }
```
Calling again toggles (idempotent toggle).

### GET /api/hub/posts/:id/comments
Auth: required
```json
Response:
{
  "data": [{
    "id": "string",
    "author": { ...Author },
    "body": "string",
    "createdAt": "timestamp",
    "replies": [{
      "id": "string",
      "author": { ...Author },
      "body": "string",
      "createdAt": "timestamp"
    }]
  }]
}
```
Nested one level deep (replies to comments; no replies to replies).

### POST /api/hub/posts/:id/comments
Auth: required
```json
Request: { "body": "string" }
Response: { "data": { Comment object } }
```

### POST /api/hub/comments/:id/replies
Auth: required
```json
Request: { "body": "string" }
Response: { "data": { Comment object (the reply) } }
```

---

## 3. OPPORTUNITIES

Source: `lib/opps-data.jsx`, `lib/opps-screens.jsx`

**Opportunity object:**
```json
{
  "id": "string",
  "type": "Grant | Funding | Tender | Scholarship | Accelerator | Competition | Partnership | Job",
  "filter": "Grants | Funding | Tenders | Scholarships | Accelerators | Competitions | Partnerships | Jobs",
  "title": "Agribusiness Growth Grant 2026 — up to ₦5,000,000",
  "org": "Tony Elumelu Foundation",
  "orgDesc": "A pan-African philanthropy...",
  "location": "Nigeria · Ghana · Kenya",
  "country": "Nigeria",
  "deadline": "Closes 30 Jun 2026",
  "closingSoon": false,
  "amount": "Up to ₦5,000,000",
  "salaryLabel": "Grant",
  "eligibility": "Registered agri-SMEs",
  "website": "tefconnect.com",
  "desc": "string",
  "criteria": ["Registered business (CAC or local equivalent)", "Operating for 12+ months"],
  "adminVerified": true,
  "status": "published | pending | rejected",
  "rejectionReason": null | "string",
  "isSaved": false,
  "submittedBy": { "id": "uuid", "name": "string", "tier": "business" },
  "createdAt": "timestamp"
}
```

### GET /api/hub/opportunities
Auth: required

Query:
```
filter: "All" | "Jobs" | "Grants" | "Funding" | "Scholarships" | "Tenders" | "Procurement" | "Accelerators" | "Competitions" | "Partnerships"
country: "All Countries" | "Nigeria" | "Ghana" | "Kenya" | "South Africa" | "Rwanda"
page: integer
```

Response: `{ data: Opportunity[], pagination }`

Notes:
- Jobs filter: if WAWUJobs not launched, return `{ data: [], isComingSoon: true }` — frontend shows Coming Soon panel
- Only published opportunities returned (pending visible only to submitter)
- closingSoon = true when deadline within 7 days

### GET /api/hub/opportunities/:id
Auth: required
Response: `{ data: Opportunity }` (full object including desc, criteria, orgDesc)

### POST /api/hub/opportunities/:id/apply
Auth: required
```json
Request:
{
  "name": "Ada Okeke (pre-filled from profile)",
  "email": "ada@email.com",
  "phone": "+2348012345678",
  "country": "Nigeria",
  "motivation": "string (required)",
  "documentUrl": "string | null (optional — uploaded file)"
}

Response 201:
{ "data": { "message": "Application submitted. The organisation will contact you directly." } }
```

### POST /api/hub/opportunities/:id/save
Auth: required
Response: `{ "data": { "isSaved": true } }`

---

## 4. EVENTS

Source: `lib/ev-data.jsx`, `lib/ev-screens.jsx`

**Event object:**
```json
{
  "id": "string",
  "featured": false,
  "month": "JUL",
  "day": "18",
  "dow": "Saturday",
  "time": "09:00 – 17:00",
  "tz": "WAT",
  "dateActual": "2026-07-18",
  "name": "Pan-African Trade & Export Summit",
  "org": "Lagos Founders",
  "orgBio": "A community of operators and founders...",
  "orgTier": "business",
  "format": "In-Person | Online",
  "type": "Summit | Workshop | Webinar | Meetup | Competition",
  "location": "Eko Hotel, Lagos",
  "address": "1415 Adetokunbo Ademola St, Victoria Island, Lagos",
  "thisWeek": false,
  "going": 128,
  "userGoing": false,
  "going3": ["D", "A", "M"],
  "url": "lagosfounders.africa/summit",
  "desc": "string",
  "speakers": [
    { "initials": "AO", "name": "Ada Okeke", "title": "Founder, AgriLink" }
  ],
  "adminVerified": true,
  "status": "published | pending | rejected",
  "isPast": false,
  "hasRecap": false,
  "recapUrl": null | "string"
}
```

### GET /api/hub/events
Auth: required

Query:
```
filter: "All" | "In-Person" | "Online" | "Workshop" | "Summit" | "Webinar" | "Meetup" | "Competition"
view: "upcoming" | "past"   (default: upcoming)
page: integer
```

Response:
```json
{
  "data": Event[],
  "featured": Event | null,
  "pagination": { ... }
}
```

Notes:
- featured = first admin-pinned upcoming event (featured: true in DB)
- isPast = dateActual < today
- thisWeek = dateActual within 3 days from now
- going3 = initials of 3 hub users who tapped Going (for avatar stack UI)

### GET /api/hub/events/:id
Auth: required
Response: `{ data: Event }` (full object)

### POST /api/hub/events/:id/going
Auth: required
```json
Response: { "data": { "userGoing": true, "going": 129 } }
```
Calling again toggles. This is a hub interest signal ONLY — disclaimer in UI.

---

## 5. MARKETPLACE PROXY

Source: `lib/market-data.jsx`, `lib/market-screens.jsx`

**Product object (unified shape for both platforms):**
```json
{
  "id": "string",
  "name": "Ground Egusi · 500g",
  "price": "₦4,500",
  "currency": "NGN | GHS | KES",
  "platform": "WAWUBasket | WAWUBeauty",
  "seller": {
    "id": "string (platform-specific seller ID)",
    "wawuId": "uuid | null",
    "name": "Mama Nkechi Foods",
    "verificationTier": "business"
  },
  "badge": null | "gold | black",
  "imageUrl": "string | null",
  "description": "string | null",
  "specs": [["Weight", "500g"], ["Origin", "Enugu, NG"], ["Cert.", "NAFDAC"]],
  "moreBySeller": Product[]
}
```

**Category object:**
```json
{ "name": "Fresh Produce", "icon": "Carrot" }
```

### GET /api/hub/marketplace/picks
Auth: required
Response:
```json
{
  "data": [
    { ...Product, "platform": "WAWUBasket" },
    { ...Product, "platform": "WAWUBeauty" }
  ]
}
```
Returns 5 top picks mixed from both platforms.
Basket categories: Fresh Produce, Livestock, Restaurants, Groceries, Farm Inputs, Export Products
Beauty categories: Fashion, Beauty Products, Hair, Art, Handmade Goods, Accessories

### GET /api/hub/marketplace/basket/categories
Auth: required
Response: `{ "data": [{ "name": "Fresh Produce", "icon": "Carrot" }, ...] }`
(6 categories — see BASKET_CATS in market-data.jsx)

### GET /api/hub/marketplace/basket/products
Auth: required
Query: `category? page=1 per_page=20 search?`
Response: `{ data: Product[], pagination }`

### GET /api/hub/marketplace/beauty/categories
Auth: required
Response: `{ "data": [{ "name": "Fashion", "icon": "Shirt" }, ...] }`
(6 categories — see BEAUTY_CATS in market-data.jsx)

### GET /api/hub/marketplace/beauty/products
Auth: required
Query: `category? page=1 per_page=20 search?`
Response: `{ data: Product[], pagination }`

### GET /api/hub/marketplace/search
Auth: required
Query: `q=shea butter platform=All|WAWUBasket|WAWUBeauty category? page=1`
Response: `{ data: Product[], pagination, query: "shea butter" }`

### GET /api/hub/marketplace/products/:platform/:id
Auth: required
Params: `platform = basket | beauty`, `id = product ID in that platform`
Response: `{ data: Product }` (full detail including description, specs, moreBySeller)

### GET /api/hub/marketplace/seller/products
Auth: required (user must be authenticated)
Description: Returns the current user's own product listings from Basket AND Beauty.
Used for the "Attach a product" picker in the Create sheet.
```json
Response:
{
  "data": {
    "WAWUBasket": Product[],
    "WAWUBeauty": Product[]
  }
}
```
Implementation: hub calls Basket `GET /vendor/products/public?wawu_id={sub}` and
Beauty `GET /api/catalog/products/public?seller_id={platformRefs.beautyUserId}` in parallel.

---

## 6. PROFILE

Source: `lib/profile-data.jsx`, `lib/profile-screens.jsx`

**TrustBreakdown object:**
```json
{
  "score": 820,
  "tier": "Gold",
  "nextTier": "Elite",
  "nextTierAt": 1500,
  "progressPercent": 54,
  "earns": [
    { "label": "Course completion", "points": "+50", "icon": "GraduationCap" },
    { "label": "Purchase", "points": "+20", "icon": "ShoppingBag" },
    { "label": "Sale via Basket/Beauty", "points": "+20", "icon": "Tag" },
    { "label": "Helpful contribution", "points": "+10", "icon": "ThumbsUp" },
    { "label": "Positive rating", "points": "+15", "icon": "Star" },
    { "label": "Verified info", "points": "+30", "icon": "ShieldCheck" }
  ],
  "loses": [
    { "label": "Spam", "points": "-100", "icon": "AlertTriangle" },
    { "label": "Fraud", "points": "-200", "icon": "Ban" },
    { "label": "False information", "points": "-100", "icon": "XCircle" },
    { "label": "Offensive language", "points": "-50", "icon": "MessageSquareOff" },
    { "label": "Policy violation", "points": "-150", "icon": "ShieldOff" }
  ]
}
```

Trust tiers (locked — from locked decisions):
- Basic: 0–99
- Verified: 100–499
- Gold: 500–1,499
- Elite: 1,500–4,999
- Trusted Partner: 5,000+

**VerificationLevel object:**
```json
{
  "tier": "basic | verified_user | verified_business | certified_professional | trusted_partner",
  "name": "Basic | Verified User | Verified Business | Certified Professional | Trusted Partner",
  "req": "Phone and email confirmed.",
  "state": "current | next | pending | locked"
}
```

**Own profile shape:**
```json
{
  "id": "uuid",
  "name": "David Adeyemi",
  "occupation": "Agripreneur",
  "country": "Lagos, Nigeria",
  "profileImage": null | "url",
  "verificationTier": "basic",
  "trustScore": 820,
  "trustBreakdown": { ...TrustBreakdown },
  "verificationLevels": [
    { "tier": "basic", "name": "Basic", "req": "Phone and email confirmed.", "state": "current" },
    { "tier": "verified_user", "name": "Verified User", "req": "Government ID + Face-ID liveness check.", "state": "next" },
    { "tier": "verified_business", "name": "Verified Business", "req": "Business documents + website or socials.", "state": "locked" },
    { "tier": "certified_professional", "name": "Certified Professional", "req": "Professional qualifications or licence.", "state": "locked" },
    { "tier": "trusted_partner", "name": "Trusted Partner", "req": "Apply and be approved as a WAWU partner.", "state": "locked" }
  ],
  "interests": ["Agriculture", "Finance", "Technology"],
  "postCount": 28,
  "isFollowing": false
}
```

**Other user profile shape** (public — trust breakdown OMITTED, locked decision):
```json
{
  "id": "uuid",
  "name": "Mama Nkechi Foods",
  "occupation": "Fresh foods vendor",
  "country": "Lagos, Nigeria",
  "profileImage": null | "url",
  "verificationTier": "business",
  "trustScore": 2480,
  "trustTier": "Elite",
  "canFollow": true,
  "isFollowing": false,
  "postCount": 64
}
```
canFollow = true ONLY when verificationTier is `verified_business` or `trusted_partner`.

### GET /api/hub/profile/me
Auth: required
Response: `{ data: OwnProfile }`

### GET /api/hub/profile/:wawuId
Auth: required
Response: `{ data: OtherUserProfile }`

### PATCH /api/hub/profile/me
Auth: required
```json
Request:
{
  "occupation": "string (optional)",
  "country": "string (optional)",
  "state": "string (optional)",
  "interests": ["Agriculture", "Finance"] "(optional — min 3 required if updating)",
  "profileImage": "url (optional)"
}
Response: { data: OwnProfile }
```

### GET /api/hub/profile/me/posts
Auth: required
```json
Response:
{
  "data": [{
    "status": "published | pending | rejected",
    "rejectionReason": null | "Add a verifiable source link before resubmitting.",
    "post": { ...Post }
  }]
}
```

### GET /api/hub/profile/me/activity
Auth: required
```json
Response:
{
  "data": [{
    "icon": "ArrowUp | MessageCircle | Bookmark",
    "verb": "You upvoted | You commented on | You saved | You replied to",
    "ref": "post title string",
    "postId": "string",
    "time": "2h"
  }]
}
```

### GET /api/hub/profile/me/saved
Auth: required
Response: `{ data: Post[], pagination }`

### GET /api/hub/profile/me/orders
Auth: required
Description: Aggregated from Basket + Beauty using platformRefs from WAWU ID token.
```json
Response:
{
  "data": [{
    "name": "Ground Egusi · 500g",
    "platform": "WAWUBasket | WAWUBeauty",
    "status": "Delivered | In transit | Processing | Cancelled",
    "date": "2 Jun 2026",
    "orderId": "platform-specific-order-id",
    "deepLink": "url to open order in the satellite app"
  }]
}
```

### GET /api/hub/profile/me/courses
Auth: required
```json
Response:
{
  "data": [{
    "name": "Diploma in Digital Marketing",
    "provider": "Alison | Coursera | WAWU Academy",
    "progress": 100,
    "status": "Completed | In progress | Enrolled",
    "cert": true | false,
    "enrolledAt": "timestamp"
  }]
}
```

### POST /api/hub/profile/:wawuId/follow
Auth: required
422 if target verificationTier is basic or verified_user (no follow on individuals).
Response: `{ "data": { "isFollowing": true } }`

### DELETE /api/hub/profile/:wawuId/follow
Auth: required
Response: `{ "data": { "isFollowing": false } }`

---

## 7. TRUST SCORE

Source: `lib/trust.jsx`, `lib/profile-data.jsx`

### GET /api/hub/trust/me
Auth: required
Response: `{ data: TrustBreakdown }` (full breakdown — own profile only)

### GET /api/hub/trust/:wawuId
Auth: required
Response:
```json
{ "data": { "score": 2480, "tier": "Elite" } }
```
Public view: score + tier only. No breakdown (locked decision).

### POST /api/hub/trust/event (internal — called by hub itself when trust-worthy actions happen)
Auth: service-key
```json
Request:
{
  "wawuId": "uuid",
  "event": "course_completed | purchase | sale | helpful_contribution | positive_rating | verified_info | spam | fraud | false_info | offensive_language | policy_violation",
  "context": "string (optional — e.g. course name)"
}
```
This endpoint calls WAWU ID `PATCH /internal/users/:id/trust-score` with the appropriate delta.

Point values (implement these server-side):
- course_completed: +50
- purchase: +20
- sale: +20
- helpful_contribution: +10
- positive_rating: +15
- verified_info: +30
- spam: -100
- fraud: -200
- false_info: -100
- offensive_language: -50
- policy_violation: -150

---

## 8. TRAINING

Source: `lib/ts-data.jsx` — TRAINING_FEATURED constant

### GET /api/hub/training
Auth: required
```json
Response:
{
  "data": {
    "featured": {
      "partner": "Alison",
      "title": "Free certified courses for 10 million Africans",
      "body": "The Alison 10 Million Learners Initiative offers free, certified online courses across business, technology, agriculture and personal development. Study at your own pace, earn a recognised certificate, and have your completion recorded on your WAWUAfrica profile.",
      "pills": ["Free", "Certificate included"],
      "enrollUrl": "https://alison.com/..."
    },
    "comingSoon": []
  }
}
```

### POST /api/hub/training/enroll
Auth: required
```json
Request:
{
  "partner": "Alison",
  "courseName": "Diploma in Digital Marketing"
}
Response: { "data": { "message": "Enrollment recorded. Opening Alison now." } }
```
Side effect: creates hub_enrollment record, fires trust event `course_completed` (award after completion, not enroll — track separately or on partner webhook).

---

## 9. SERVICES

Source: `lib/ts-data.jsx` — SERVICES and MENTORS constants

**Service object:**
```json
{
  "id": "easybuy | insurance | pension | banking | grants | mentorship",
  "name": "EasyBuy",
  "provider": "CredPal",
  "icon": "Smartphone",
  "tag": "Device & equipment financing",
  "what": "Spread the cost of phones, laptops, and farm equipment...",
  "eligibility": [
    "Verified WAWUAfrica account",
    "Valid government ID",
    "Proof of income or 3-month bank statement"
  ],
  "benefits": [
    "Pay in 3–12 monthly instalments",
    "No paperwork beyond your WAWU ID",
    "Approved devices delivered to you",
    "Build a repayment track record"
  ],
  "steps": [
    ["Apply", "Submit a short financing request"],
    ["Review", "The partner checks your eligibility"],
    ["Access", "Collect your device and start paying"]
  ],
  "partnerUrl": "https://...",
  "status": "published | draft",
  "isMentorship": false
}
```

**Mentor object:**
```json
{
  "id": "string",
  "wawuId": "uuid",
  "name": "Dr. Bisi Adeyemi",
  "verificationTier": "professional",
  "trustScore": 1320,
  "status": "Taking mentees | Fully booked",
  "expertise": ["Agronomy", "Soil science"],
  "industries": ["Agriculture", "Agri-processing"],
  "availability": "2 mentee slots this month",
  "bio": "Agronomist with 15 years advising smallholder farms..."
}
```

### GET /api/hub/services
Auth: required
Response: `{ data: Service[] }`
Returns 6 services (EasyBuy, Health Insurance, Pension, Banking, Grants & Funding, Mentorship)
in the order defined in ts-data.jsx SERVICES array.

### GET /api/hub/services/:id
Auth: required
Response: `{ data: Service }` (full object)

### GET /api/hub/services/mentors
Auth: required
Query: `expertise? page=1`
Response: `{ data: Mentor[] }`

### GET /api/hub/services/mentors/:id
Auth: required
Response: `{ data: Mentor }`

### POST /api/hub/services/mentors/:id/request
Auth: required
```json
Request:
{
  "workingOn": "I'm scaling my cassava farm to 5 hectares...",
  "supportNeeded": "Help with financial planning and market access",
  "contactMethod": "WhatsApp | Email | In-app message"
}
Response: { "data": { "message": "Your request has been sent. We'll match you and follow up." } }
```
Side effect: creates hub_mentor_requests record with status=pending. Admin matches via admin dashboard.

---

## 10. KNOWLEDGE HUB + COUNTRY INSIGHTS

Source: `lib/k-data.jsx`

**ContentCard object:**
```json
{
  "id": "string",
  "cat": "Article | Report | Guide | Policy | Insight",
  "title": "string",
  "source": "WAWU Research | AgriToday | ...",
  "date": "28 May 2026",
  "meta": "6 min read | PDF · 3.1 MB",
  "author": "string | null",
  "org": "string | null",
  "body": ["paragraph 1", "paragraph 2", "paragraph 3"],
  "fileUrl": "string | null",
  "status": "published | draft | archived"
}
```

**Section object:**
```json
{
  "title": "Articles | Research & Reports | Market Reports | Policy Updates | Industry Insights | Business Guides | Export Guides",
  "items": ContentCard[]
}
```

### GET /api/hub/knowledge
Auth: required
```json
Response:
{
  "data": {
    "featured": { ...ContentCard (full including body) },
    "playbook": {
      "title": "WAWUAfrica Business Playbook",
      "desc": "A practical, end-to-end guide to registering, funding, and scaling a business across African markets — with templates and checklists.",
      "meta": "PDF · 4.2 MB",
      "downloadUrl": "signed-s3-url"
    },
    "sections": Section[]
  }
}
```

### GET /api/hub/knowledge/:id
Auth: required
Response: `{ data: ContentCard }` (full including body array, related items)

### GET /api/hub/countries
Auth: required
Response:
```json
{
  "data": [
    { "name": "Nigeria", "updatedAt": "2 days ago" },
    { "name": "Ghana", "updatedAt": "1 week ago" },
    { "name": "Kenya", "updatedAt": "4 days ago" }
  ]
}
```

### GET /api/hub/countries/:name
Auth: required
```json
Response:
{
  "data": {
    "name": "Nigeria",
    "updatedAt": "2 days ago",
    "sections": [
      { "title": "Business Registration", "content": "string" },
      { "title": "Tax Information", "content": "string" },
      { "title": "Import Regulations", "content": "string" },
      { "title": "Export Regulations", "content": "string" },
      { "title": "Investment Opportunities", "content": "string" },
      { "title": "Government Incentives", "content": "string" },
      { "title": "Sector Opportunities", "content": "string" },
      { "title": "Regulatory Updates", "content": "string" }
    ]
  }
}
```
8 sections always. Content managed by admin only.

---

## 11. ADMIN API

Source: `lib/admin-data.jsx`, `lib/admin-mod.jsx`, `lib/admin-users.jsx`,
        `lib/admin-content.jsx`, `lib/admin-analytics.jsx`, `lib/admin-extra.jsx`

Admin auth: existing Sanctum admin token (not WAWU ID JWT).
All admin routes: `Authorization: Bearer <admin_sanctum_token>`

### QueueItem object:
```json
{
  "id": "string",
  "type": "Opportunity | Event | Research | Business Listing | Partner Announcement",
  "title": "string",
  "by": "Tony Elumelu Foundation",
  "submitterTier": "business | verified | partner | ...",
  "when": "12 min ago",
  "country": "Nigeria",
  "body": "string",
  "fields": [["Type", "Grant"], ["Amount", "Up to ₦5,000,000"]],
  "status": "pending"
}
```

### GET /api/admin/queue
Query: `type? page=1`
```json
Response:
{
  "data": QueueItem[],
  "counts": {
    "Opportunities": 12,
    "Events": 4,
    "Research": 2,
    "Business Listings": 7,
    "Partner Announcements": 1,
    "Verification Requests": 9
  }
}
```

### PATCH /api/admin/queue/:id/approve
```json
Response: { "data": { "id": "string", "status": "published" } }
```
Side effect: notifies submitter, publishes item to public feed.

### PATCH /api/admin/queue/:id/reject
```json
Request: { "reason": "string (required — sent to submitter)" }
Response: { "data": { "id": "string", "status": "rejected", "reason": "string" } }
```

### POST /api/admin/queue/bulk-approve
```json
Request: { "ids": ["q1", "q2", "q3"] }
Response: { "data": { "approved": 3 } }
```

### POST /api/admin/queue/bulk-reject
```json
Request: { "ids": ["q4", "q5"], "reason": "string (required)" }
Response: { "data": { "rejected": 2 } }
```

### VerificationRequest object:
```json
{
  "id": "string",
  "name": "Adaeze Okonkwo",
  "email": "adaeze@email.com",
  "currentTier": "verified",
  "requestedTier": "verified_business",
  "docs": ["ID", "Face ID", "NIN", "Business docs"],
  "docUrls": ["s3-url-1", "s3-url-2"],
  "when": "1 hr ago",
  "country": "Nigeria",
  "trustScore": 1240,
  "history": []
}
```

### GET /api/admin/verifications
Query: `page=1`
Response: `{ data: VerificationRequest[], pagination }`

### PATCH /api/admin/verifications/:id/approve
```json
Response: { "data": { "tier": "verified_business" } }
```
Side effect: calls WAWU ID PATCH /internal/users/:id/verification-tier + notifies user.

### PATCH /api/admin/verifications/:id/reject
```json
Request: { "reason": "string (required)" }
```

### PATCH /api/admin/verifications/:id/request-info
```json
Request: { "message": "Please upload a clearer photo of your business registration." }
```

### User object (admin view):
```json
{
  "id": "string",
  "name": "David Adeyemi",
  "email": "david.adeyemi@email.com",
  "country": "Nigeria",
  "verificationTier": "verified",
  "trustScore": 64,
  "trustTier": "Gold (calculated)",
  "joined": "Jan 2026",
  "status": "Active | Suspended | Banned",
  "posts": 28,
  "purchases": 12,
  "violations": 0
}
```

### GET /api/admin/users
Query: `tier? country? status? joined_from? joined_to? search? page=1`
Response: `{ data: User[], pagination }`

### GET /api/admin/users/:id
Response: `{ data: User }` with full detail + recent posts, activity log

### PATCH /api/admin/users/:id/suspend
```json
Request: { "reason": "string (required)" }
Response: { "data": { "status": "Suspended" } }
```

### PATCH /api/admin/users/:id/ban
```json
Request: { "reason": "string (required)" }
Response: { "data": { "status": "Banned" } }
```

### PATCH /api/admin/users/:id/unsuspend
Response: `{ "data": { "status": "Active" } }`

### GET /api/admin/trust/leaderboard
Query: `page=1`
```json
Response:
{
  "data": [{
    "rank": 1,
    "name": "Kwame Mensah",
    "wawuId": "uuid",
    "verificationTier": "trusted_partner",
    "score": 94,
    "weekDelta": +3,
    "posts": 88,
    "purchases": 24,
    "violations": 0
  }]
}
```

### POST /api/admin/trust/:wawuId/adjust
```json
Request: { "delta": -50, "reason": "Confirmed spam post removed (required, logged)" }
Response: { "data": { "newScore": 820, "newTier": "Gold" } }
```
Side effect: calls WAWU ID PATCH /internal/users/:id/trust-score, creates hub_trust_adjustments record.

### AdminContent object:
```json
{
  "id": "string",
  "title": "The State of African SME Finance 2026",
  "type": "Article | Report | Guide | Policy | Insight",
  "author": "WAWU Research",
  "source": "string",
  "date": "May 2026",
  "status": "Published | Draft | Archived",
  "countryTags": ["Nigeria", "Ghana"],
  "createdAt": "timestamp",
  "updatedAt": "timestamp"
}
```

### GET /api/admin/content
Query: `type? status? page=1`
Response: `{ data: AdminContent[], pagination }`

### POST /api/admin/content
```json
Request:
{
  "title": "string",
  "type": "Article | Report | Guide | Policy | Insight",
  "body": ["paragraph 1", "paragraph 2"],
  "source": "string",
  "author": "string",
  "org": "string",
  "date": "May 2026",
  "meta": "18 min read | PDF · 3.1 MB",
  "fileUrl": "string | null",
  "countryTags": ["Nigeria"],
  "publishImmediately": true
}
```

### PATCH /api/admin/content/:id — same body, all fields optional
### DELETE /api/admin/content/:id — sets status to Archived

### GET /api/admin/countries
Response: `{ data: [{ name, updatedAt, sections: int, status: "Published|Draft" }] }`

### PATCH /api/admin/countries/:name
```json
Request:
{
  "sections": [
    { "title": "Business Registration", "content": "string" },
    ...8 sections total
  ]
}
```

### GET /api/admin/opportunities
Query: `type? country? status? page=1`
Response: `{ data: AdminOpp[], pagination }`
AdminOpp: `{ id, title, type, org, country, deadline, status, submittedBy }`

### POST /api/admin/opportunities — creates and publishes immediately (admin bypass)
Full Opportunity body (same as user create but no approval gate).

### PATCH /api/admin/opportunities/:id
### DELETE /api/admin/opportunities/:id

### GET /api/admin/events
### POST /api/admin/events — creates and publishes immediately
### PATCH /api/admin/events/:id
Body includes: `featured: bool` — when true, pins this event to Events landing top.
### DELETE /api/admin/events/:id

### GET /api/admin/analytics
```json
Response:
{
  "data": {
    "stats": [
      { "label": "Total Users", "value": "24,180", "icon": "Users" },
      { "label": "New this week", "value": "+612", "icon": "UserPlus" },
      { "label": "Active today", "value": "3,940", "icon": "Activity" },
      { "label": "Pending moderation", "value": "35", "icon": "ClipboardList" },
      { "label": "Opportunities this month", "value": "48", "icon": "Briefcase" },
      { "label": "Events this month", "value": "12", "icon": "CalendarDays" }
    ],
    "growthSeries": [0.20, 0.22, ...30 values normalised 0–1],
    "contentBars": [
      ["Articles", 0.9],
      ["Reports", 0.55],
      ["Guides", 0.4],
      ["Policy", 0.3],
      ["Insights", 0.6]
    ]
  }
}
```

### GET /api/admin/analytics/export
Query: `type=users|content|opportunities|events|moderation_log|trust_audit format=csv`
Response: file download

### GET /api/admin/ads
### POST /api/admin/ads
```json
Request:
{
  "advertiser": "CredPal EasyBuy",
  "placement": "Feed pinned | Right rail | Popup",
  "start": "2026-06-01",
  "end": "2026-06-30",
  "country": "Nigeria | Pan-African",
  "creativeUrl": "string | null"
}
```
### PATCH /api/admin/ads/:id
### DELETE /api/admin/ads/:id

### GET /api/admin/reported
Response: `{ data: ReportedItem[], pagination }`
```json
ReportedItem:
{
  "id": "string",
  "title": "string",
  "type": "Business Listing | Comment | Opportunity",
  "by": "submitter name",
  "reporter": "reporter name",
  "reason": "Scam / fraud | Spam | Stolen images | Misinformation",
  "when": "20 min ago",
  "reports": 8,
  "status": "Pending | Reviewing | Resolved"
}
```
### PATCH /api/admin/reported/:id/dismiss
### PATCH /api/admin/reported/:id/remove — removes the reported content from platform

### GET /api/admin/flagged-products
Response: `{ data: FlaggedProduct[] }`
```json
FlaggedProduct:
{
  "id": "string",
  "name": "Slimming Tea — clinically proven",
  "seller": "WellnessPlus",
  "platform": "WAWUBeauty | WAWUBasket",
  "price": "₦7,500",
  "reason": "Unverified health claim | Counterfeit | Missing certification",
  "when": "40 min ago",
  "status": "Pending | Reviewing"
}
```

### GET /api/admin/sellers
Query: `platform=WAWUBasket|WAWUBeauty page=1`
Response: `{ data: [{ id, name, platform, tier, products, rating, country, status }] }`

### GET /api/admin/training
### PATCH /api/admin/training/:id
Body: `{ name?, partner?, type?, status?, featured? }`

### GET /api/admin/services
### PATCH /api/admin/services/:id
Full Service body update (any fields).

### GET /api/admin/mentor-requests
Response: `{ data: [{ id, requester, mentor, workingOn, supportNeeded, contactMethod, status, adminNote }] }`
### PATCH /api/admin/mentor-requests/:id/match
```json
Request: { "note": "string (optional message to include in match notification)" }
Response: { "data": { "status": "matched" } }
```
Side effect: notifies both parties.

### GET /api/admin/announcements
### POST /api/admin/announcements
```json
Request: { "title": "string", "audience": "All users | Learners | ...", "placement": "Banner | Feed pinned | Training banner", "start": "date", "end": "date" }
```
### PATCH /api/admin/announcements/:id
### DELETE /api/admin/announcements/:id

### GET /api/admin/team
Response: `{ data: [{ id, name, email, role: "Super Admin | Moderator | Content Editor", lastActive }] }`

### POST /api/admin/team
```json
Request: { "name": "string", "email": "string", "role": "Super Admin | Moderator | Content Editor", "password": "string" }
```
### DELETE /api/admin/team/:id

### GET /api/admin/settings
```json
Response:
{
  "data": [
    ["Require admin approval for all opportunities", true],
    ["Require admin approval for all events", true],
    ["Auto-flag listings with health or financial claims", true],
    ["Allow user-submitted event recaps", true],
    ["Two-factor authentication for admins", true]
  ]
}
```
### PATCH /api/admin/settings
```json
Request: { "key": "Require admin approval for all opportunities", "value": false }
```

---

## 12. WAWUBEAUTY — NEW ENDPOINTS

Source: confirmed from WAWUBeauty model structure

### GET /api/catalog/products/public
Auth: none (public)
Query: `seller_id=int (beauty user id) category? page=1 per_page=20`
```json
Response:
{
  "data": [{
    "id": "int",
    "name": "Ankara Maxi Dress",
    "price": "₦15,000",
    "currency": "NGN",
    "imageUrl": "string | null",
    "category": "Fashion",
    "status": "active",
    "seller": {
      "id": "int",
      "name": "Lagos Threads",
      "storeName": "string | null",
      "verificationTier": "business"
    },
    "badge": null | "gold | black"
  }]
}
```
Filter: status=active (published) products only.

### GET /api/catalog/products/public/:id
Auth: none (public)
Response: full product detail for hub product detail screen.

---

## 13. WAWUBASKET — NEW ENDPOINTS

Source: confirmed from WAWUBasket vendor controller

### GET /vendor/products/public
Auth: valid WAWU ID JWT or existing Basket JWT
Query: `wawu_id=string (WAWU ID UUID)`
```json
Response:
{
  "data": [{
    "id": "uuid",
    "name": "Ground Egusi · 500g",
    "price": 4500,
    "currency": "NGN",
    "priceFormatted": "₦4,500",
    "imageUrl": "string | null",
    "category": "Groceries",
    "status": "active"
  }]
}
```
Lookup: use `platformRefs.basketUserId` from WAWU ID JWT to find the User,
then return their published products.
Filter: published/active products only.

---

## HOW AGENTS USE THIS DOCUMENT

**Backend agents** (Streams 1–4):
1. Read the relevant section(s) for your stream
2. Build to the exact field names and shapes shown
3. If a field's context is unclear, open the corresponding `lib/*.jsx`
   file from the design ZIP and find the data constant — that IS the spec
4. Do not invent new fields; do not rename fields

**Frontend agent** (Stream 5):
1. Start with mock data shaped exactly like these contracts
2. Wire real API calls progressively (auth first, feed second, etc.)
3. The lib/*.jsx data constants in the design files are pre-built mock data —
   you can import them directly during development
4. Replace with real API calls once each backend stream deploys

