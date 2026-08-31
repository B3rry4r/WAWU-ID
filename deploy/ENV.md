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
| `APP_URL`, `FRONTEND_URL`, `SECURITY_URL`, `MAIL_FROM`, `EMAIL_HEADER_URL` | Links in emails point nowhere useful |
| `WAWUAFRICA_API_URL` | `http://127.0.0.1:3001` — the Hub API over loopback, not through nginx |
| `ALLOWED_ORIGINS` | Browser calls from the web app are blocked by CORS |
