# WAWU ID — required environment

Lives in `/etc/wawu/wawu-id.env` on the droplet. Root-owned, 0640, readable by
the `wawu` group. Never committed, never in CI.

**Values containing spaces must be quoted.** The RS256 PEM contains
`BEGIN PRIVATE KEY`, and an unquoted value breaks `source` in deploy.sh with
`PRIVATE: command not found`.

## Will not start / will 500 without these

| Key | Note |
|---|---|
| `DATABASE_URL` | `sslmode=verify-full&sslrootcert=/etc/wawu/do-ca.crt` — see the Hub API deploy README on why plain `require` fails |
| `RS256_PRIVATE_KEY` | PEM, single line with `\n` escapes, **quoted** |
| `RS256_PUBLIC_KEY` | ditto |
| `INTERNAL_SERVICE_KEY` | must equal `WAWU_ID_INTERNAL_SERVICE_KEY` in `hub-api.env` |
| `JWT_EXPIRES_IN` | e.g. `15m` |
| `REFRESH_EXPIRES_IN` | e.g. `30d`. **`getOrThrow`, so login 500s without it** — and only on login, so the service starts happily and then fails the first time somebody signs in. |

## Needed for real behaviour

| Key | Without it |
|---|---|
| `RESEND_API_KEY` | Mail is skipped with a warning. Registration returns 500 **after creating the user**, so the account exists but nobody can sign in — the row has to be verified by hand. |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | OTP over WhatsApp does not send |
| `FINTAVA_BASE_URL`, `FINTAVA_API_KEY` | Mobile sign-up (`POST /auth/signup`, `/auth/phone/verify/start`) answers 503 `SMS_NOT_CONFIGURED`: the code is texted through Fintava's `POST /sms/send`, and nothing is sent without both. Use the same values as the Hub (sandbox: `https://dev.fintavapay.com/api/dev`). Fintava charges per text. |
| `PHONE_CODE_TTL_SECONDS`, `PHONE_CODE_MAX_WRONG`, `PHONE_CODE_LOCKOUT_SECONDS`, `PHONE_CODE_RESEND_SECONDS`, `PHONE_CODE_DAILY_WRONG_CAP`, `PENDING_SIGNUP_TTL_SECONDS`, `SIGNUP_ALLOWED_PHONE_PREFIX`, `SMS_LIMIT_IP_PER_HOUR`, `SMS_LIMIT_IP_PER_DAY`, `SMS_LIMIT_PHONE_PER_DAY`, `SMS_LIMIT_GLOBAL_PER_DAY`, `CONFIRM_LIMIT_IP_PER_HOUR` | Optional. Defaults 300, 4, 900, 60, 12, 86400, `+234`, 30, 100, 5, 2000, 120. Everything after the first two is provisional until the owner confirms it (see `src/auth/phone-verification.config.ts`). Client address: nginx must be the first hop and send `X-Real-IP` (it does: `deploy/install-services.sh` in wawu-backend); behind a CDN or load balancer every caller would share one address, and the proxy's own header would have to be trusted instead. IPv6 addresses count as their /64. See the sign-up section of `WAWUAfrica_API_Contracts.md` |
| `APP_URL`, `FRONTEND_URL`, `SECURITY_URL`, `MAIL_FROM`, `EMAIL_HEADER_URL` | Links in emails point nowhere useful |
| `WAWUAFRICA_API_URL` | `http://127.0.0.1:3001` — the Hub API over loopback, not through nginx |
| `ALLOWED_ORIGINS` | Browser calls from the web app are blocked by CORS |
