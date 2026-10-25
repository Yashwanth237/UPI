# Configuration & Secret Management Guide

## 1. Environment Parameters Reference

| Variable | Default Value | Description |
| :--- | :--- | :--- |
| `NODE_ENV` | `development` | Runtime environment (`development` or `production`) |
| `CONTROL_CENTER_PORT` | `8090` | Host port for the Local Process Supervisor |
| `PAYMENT_API_PORT` | `6100` | Host port for the central Payment Core REST API |
| `CHECKOUT_PORTAL_PORT` | `7000` | Host port for the customer-facing Checkout page |
| `MERCHANT_ADMIN_PORT` | `6001` | Host port for the Merchant Admin Dashboard |
| `HELP_PORTAL_PORT` | `3000` | Host port for the Customer Payment Help Portal |
| `GMAIL_OBSERVER_PORT` | `6003` | Host port for the Gmail Polling Service & OAuth Callback |
| `SMS_OBSERVER_PORT` | `6002` | Host port for the Google Messages / SMS Web Automator |
| `DATABASE_URL` | unused | **Not read by any code.** SQLite (`node:sqlite`) is the only runtime database; `packages/db/src/schema.sql` is a schema-only PostgreSQL variant kept in parity for a future adapter |
| `USE_SQLITE_FALLBACK` | unused | **Not read by any code** (see `DATABASE_URL`) |
| `SQLITE_DB_PATH` | `./data/youpi_pg.sqlite`| Path to local SQLite database file |
| `ENCRYPTION_MASTER_KEY` | `64-hex chars` | 256-bit key for encrypting OAuth credentials and device keys |
| `JWT_SECRET` | unused | **Not read by any code.** Customer and staff sessions are opaque random tokens stored hashed in the database |
| `PAYMENT_ACTIVE_WINDOW_MS` | `300000` | Duration of active payment slot (5 minutes = 300,000ms) |
| `PAYMENT_PROCESSING_WINDOW_MS` | `30000` | Duration of verification slot (30 seconds = 30,000ms) |
| `LATE_OBSERVATION_WINDOW_MS` | `1800000` | Safety window for matching late observations (30 minutes) |
| `ANDROID_ENROLLMENT_SECRET` | auto-generated | Secret used to authorize device QR pairing. If unset, a random value is created in `data/.secrets/android_enrollment_secret` |
| `ADMIN_API_TOKEN` | auto-generated | Bearer token required by `/api/v1/admin/*` (the Merchant Admin page asks for it once per tab). If unset, a random value is created in `data/.secrets/admin_api_token` |
| `OBSERVER_API_TOKEN` | auto-generated | Bearer token the local Gmail/SMS observers use to submit observations (`data/.secrets/observer_api_token`) |
| `COIN_STORE_WEBHOOK_SECRET` | auto-generated | Webhook secret seeded for the default merchant and used by the demo coin store (`data/.secrets/coin_store_webhook_secret`) |
| `YOUPI_EXPOSE_DEV_OTP` | unset | Set to `true` for local development to get the OTP in the `send-otp` response. Ignored when `NODE_ENV=production` |
| `YOUPI_ALLOW_DEV_TOOLS` | unset | Developer test-mode / simulator endpoints (`/admin/dev/*`, `simulate-observation`) are refused when `NODE_ENV=production` unless this is `true` |
| `GMAIL_REDIRECT_URI` | derived | Gmail OAuth redirect URI. Defaults to `<gmail host from your configured domain>/oauth/callback` |
| `ANDROID_HEARTBEAT_TIMEOUT_MS` | `180000` | Inactivity window before Android device is marked DISCONNECTED |
| `CHECKOUT_FRAME_ANCESTORS` | unset (any origin in development, `'self'` in production) | Merchant origins (comma or space separated, e.g. `https://shop.example.com`) allowed to embed `/checkout/:id`. The `youpi.js` modal is an iframe, so a store on a different origin than the checkout portal must be listed here or the browser blocks the modal. When unset, any site may frame the checkout page in development, while a production deployment (either `NODE_ENV=production` or `YOUPI_MODE=production`) fences the page to its own origin. Only bare `http(s)` origins are accepted — a path, query, embedded credential or wildcard is ignored, so the value cannot widen the CSP or inject another directive |
| `YOUPI_ALLOW_PRIVATE_WEBHOOKS` | unset | Set to `true` to permit merchant webhook URLs on loopback/private networks. Required for self-hosted LAN targets; blocked by default as an SSRF guard |

---

## 1c. Customer verification codes (OTP) — channels and providers

Customer sign-in codes are delivered through `OtpDispatcher` (`packages/core/src/otp-delivery.js`).
The API reports success **only when a provider accepted the message**; otherwise `send-otp` answers
`503 OTP_DELIVERY_UNAVAILABLE` and the code is withdrawn.

| Variable | Default | Description |
| :--- | :--- | :--- |
| `OTP_CHANNELS` | `whatsapp,email` | Enabled channels in priority order. Unknown values are ignored |
| `OTP_ALLOW_FALLBACK` | `true` | Try the next channel when the preferred one fails. Email fallback needs a real email on the customer record |
| `OTP_WHATSAPP_PROVIDER` | auto | `cloud-api` (official WhatsApp Business Platform), `linked-device` (existing `berryprotocol` session, unofficial), or `none`. When unset: `cloud-api` if its variables are set, else `linked-device` if a session exists (a warning is logged in production) |
| `WHATSAPP_CLOUD_ACCESS_TOKEN` | unset | System-user access token for the WhatsApp Cloud API. Secret |
| `WHATSAPP_CLOUD_PHONE_NUMBER_ID` | unset | Sender phone-number ID from WhatsApp Manager |
| `WHATSAPP_CLOUD_OTP_TEMPLATE` | unset | Name of an approved **Authentication** template with one body variable (the code) |
| `WHATSAPP_CLOUD_TEMPLATE_LANGUAGE` | `en` | Template language code |
| `WHATSAPP_CLOUD_API_VERSION` | `v21.0` | Graph API version |
| `WHATSAPP_CLOUD_OTP_BUTTON` | `true` | Send the code as the copy-code button parameter too (required for authentication templates with a button) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | unset / `587` / auto | SMTP relay for email codes. Port 465 implies TLS; other ports require STARTTLS |
| `SMTP_USER` / `SMTP_PASSWORD` | unset | SMTP credentials. Secret |
| `OTP_EMAIL_FROM` | unset | Sender, e.g. `YouPI <no-reply@pay.example.com>`. Email is disabled until this and `SMTP_HOST` are set |
| `OTP_BRAND_NAME` | `DEFAULT_APP_NAME` | Brand used in the email subject and text |
| `OTP_DEV_CONSOLE` | unset | Development only: print codes to the server console instead of sending them. Also used automatically when nothing else is configured outside production. **Cannot be enabled when `NODE_ENV=production`** |

Notes:

* The linked-device WhatsApp mode drives a normal WhatsApp account as a "WhatsApp Web" device. It is not
  the official Business Platform and the number may be restricted by Meta for automated traffic. Prefer
  the Cloud API for production.
* Codes are 6 digits, valid for 5 minutes, encrypted at rest, single-use, limited to 5 wrong attempts,
  and rate-limited per mobile number (`OTP_RESEND_COOLDOWN_MS`, default 30 s). Codes never appear in
  logs or audit records (the development console provider excepted).
* `check-user` only discloses whether an account exists; name and email are returned after OTP verification.

---

## 1a. `returnUrl` requirements

`POST /api/v1/payments` accepts a `returnUrl` that is echoed back to the customer's
browser as a redirect target after the payment completes, so the gateway stores only
**absolute** `http:` / `https:` URLs. A relative value, a `javascript:` URL or any other
scheme is rejected with `400`.

The official SDK resolves a relative `data-success-url` (for example `/success`) against
the storefront's own origin before sending it, so relative storefront paths keep working
without any change to merchant code. If you call the API directly, send an absolute URL.

---

## 1b. Merchant API Authentication (`X-Merchant-Key`)

Endpoints that expose merchant-private or customer-contact data require the caller to
prove which merchant it is. There are three accepted credentials:

| Credential | Header | Grants |
| :--- | :--- | :--- |
| Merchant webhook secret | `X-Merchant-Key: <merchant webhook secret>` | Full merchant-private view of that merchant's own sessions: `metadata`, `internalStatus`, `verificationLevel` / `verificationSources` / `verificationTag`, `returnUrl`, and customer contact details |
| Admin bearer token | `Authorization: Bearer <ADMIN_API_TOKEN>` | Full access to every merchant's data (operator tooling) |
| Observer bearer token | `Authorization: Bearer <OBSERVER_API_TOKEN>` | Full access to every merchant's data (local observer processes) |

Affected routes: `GET /api/v1/payments/:id`, `GET /api/v1/payments/:id/cod`,
`GET /api/v1/orders/:orderId/cod` and `GET /api/v1/checkout/:id/state`.

### On `POST /api/v1/payments`

`X-Merchant-Key` is **optional** here, and the request is refused with
`401 MISSING_MERCHANT_KEY` only when it names a merchant other than the gateway's
default one. The public one-script integration (the browser SDK) cannot carry a
merchant secret — a secret in browser JavaScript is public — so the default-merchant
path has to stay open. Use `X-Merchant-Key` (or `X-Order-Token`) whenever a request
targets a specific tenant, and reuse an `orderId` only with the same amount: a
mismatch is rejected with `409 ORDER_AMOUNT_MISMATCH`.

`autoActivate: true` is restricted to admin-authenticated requests or to
`NODE_ENV=test`; elsewhere it is refused with `403 AUTOACTIVATE_FORBIDDEN`.

**Without a credential these routes return a redacted public view** — status, amount,
currency, method and order id only. Customer name, email and phone number are never
disclosed to an anonymous caller that merely holds a payment id.

The official SDK sends `X-Merchant-Key` automatically when the merchant secret is
configured, so existing integrations receive the full view with no code change:

```javascript
const client = new YoupiPaymentClient({
  apiUrl: 'https://pay-api.example.com',
  merchantId: '00000000-0000-0000-0000-000000000001',
  webhookSecret: 'your-merchant-webhook-secret'   // enables the merchant-scoped view
});
```

A customer browsing the checkout page sees their own profile because the checkout client
sends the customer session token (`x-customer-token`), not because the payment id is
enough to unlock it.

---

## 2. Cryptographic Secret Generation

Generate strong 256-bit encryption and HMAC keys using Node.js native crypto:

```bash
# Generate 256-bit Master Key (64 hex characters)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Never commit production `.env` files to source code repositories.
