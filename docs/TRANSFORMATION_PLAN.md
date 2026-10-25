# YouPI-PG Transformation: Baseline Report and Plan

Status: living document. It records what was found in the repository on 2026-10-25
(branch `feature/enterprise-transformation`, based on `main` @ `d7b0741`), what the
plan is, and what has been delivered. The delivery status is in the last section.

---

## 1. Baseline (Phase 0)

### 1.1 Toolchain and checks

| Check | Result |
| --- | --- |
| Node.js | v24.20.0 (repo requires `>=24`) |
| `npm ci` | OK (needed retries because of network resets; no code issues) |
| `npm run typecheck` | Pass. **Covers only `packages/common`** through `tsconfig.json` references. It does not check any other JavaScript in the repo. |
| `npm test` (`scripts/test-all.js`) | **39/39 suites pass** |
| Side effect | One suite deletes the tracked file `data/test_whatsapp_session.json`. Restore it with `git checkout -- data/test_whatsapp_session.json` after a run. |

### 1.2 Actual stack

* Plain ESM JavaScript, one `node:http` server per app, no framework, and the built-in `node:sqlite`.
* The frontends are server-rendered HTML templates with inline vanilla JavaScript:
  * `merchant-admin/src/views/admin.html`: 7,579 lines in one file.
  * `checkout-portal/src/views/checkout.html` + `public/css/checkout.css`: about 5,900 lines.
  * `control-center/src/views/dashboard.html`
  * `payment-help/src/views/help.html`
* There is no shared design system. Each app repeats its own tokens and fonts.
* Dependency direction `common ← db ← core ← apps` holds. Observers talk to the API over HTTP.
* `packages/db/src/schema.sql` (PostgreSQL) is **schema-only**. No code loads a PostgreSQL
  driver, and `DATABASE_URL` is not read anywhere. SQLite is the only runtime database.

### 1.3 What works (confirmed in code and tests)

* Payment state machine (`packages/common/src/state-transitions.js`), enforced inside the
  repositories and not only documented.
* `acquireSlotAtomic` runs inside `BEGIN IMMEDIATE`, and the partial unique index
  `idx_one_slot_per_receiving_account` also prevents two ACTIVE/PROCESSING sessions on one account.
* Amounts are integer paise (`BigInt`). Observation fingerprints prevent duplicate processing.
  A UTR can be attributed only once (`idx_observations_unique_attributed_bank_ref`).
* Dead sessions (FAILED/EXPIRED/CANCELLED) can never be revived to SUCCESS
  (`recordVerificationSource` guard).
* Webhooks are HMAC-SHA256 over raw bytes, with retries and backoff.
* Customer OTPs are encrypted at rest, have an attempt budget, and are single-use.

### 1.4 Findings (risk-ranked)

| # | Severity | Area | Finding |
| --- | --- | --- | --- |
| F1 | High | AuthZ | All staff access uses **one shared bearer token** (`ADMIN_API_TOKEN`), pasted into the browser. There are no user accounts, roles, per-person audit trail, merchant scoping or revocation. `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD` and `JWT_SECRET` in `.env.example` are **not used by any code**. |
| F2 | High | Payment integrity | **Queue jumping.** When the slot is vacant, `acquireSlotAtomic` activates the caller even if other sessions are QUEUED. A new session created between a slot release and `promoteNext` overtakes customers who were already waiting. |
| F3 | High | Evidence loss | The Android `ApiClient.sendSms` signs with the **SMS receive time** as `X-Timestamp`. The server rejects any request more than 60 s away from that time, so an SMS forwarded late (device offline, retry) is silently dropped. Real payment evidence is lost. |
| F4 | Medium | Auth / privacy | `POST /customer/check-user` returns the account holder's **name and masked email for any mobile number** (60 req/min/IP). This enables enumeration and PII harvesting. |
| F5 | Medium | Auth | `send-otp` answers `success: true, "OTP sent to your WhatsApp"` **even when no provider is loaded and nothing was delivered** (`simulated: true`). |
| F6 | Medium | Vendor / supply chain | `berryprotocol` (0.1.x, Apache-2.0) is an unofficial WhatsApp-Web linked-device client. It carries account-ban risk, is not a business API, and the loader also tries to `import()` from **hardcoded developer paths** (`file:///D:/...`). WhatsApp is the only OTP channel, with no email fallback. |
| F7 | Medium | Honesty in UI | Checkout shows fabricated social proof by default: "500+ orders last month from {merchant}" and "{App} Trusted Business". The mobile header adds "Verified Business", "200+ orders verified" and "256-Bit Bank Encryption". |
| F13 | High | Honesty in UI | A developer "false narrative" switch can make the customer-facing confirmation status show healthy while it is down (or fake an outage); it is reachable in production when developer tools are enabled. |
| F14 | Medium | Accessibility / conversion | Checkout disables pinch-zoom, hides the amount on mobile until sign-in, and offers no UPI intent, so a phone user cannot pay from the same phone. |
| F8 | Medium | Evidence semantics | "Dual Verification" is a label only: SUCCESS is reached on a single matching observation. SMS-family sources are normalised to one channel, so the same SMS seen by two observers does not count twice. But a bank SMS and the same bank's email of the same transaction are correlated (same origin), not independent proof. This is documented in `docs/VERIFICATION_EVIDENCE.md`. |
| F9 | Low | Detection | `FRAUD_PATTERNS` includes very broad words (`/attack/i`, `/exploit/i`, `/malicious/i`) that lead to an **automatic ban**. They are unlikely in genuine bank text, but a ban is a heavy consequence for a keyword match. Flagged for review. No change made without a business decision. |
| F10 | Low | Migrations | There is no migration version table. Schema evolution is a series of idempotent `ALTER ... try/catch` statements. This is safe but unauditable. |
| F11 | Low | Ops | The `payment-help` portal (port 3000) is not started by `start.js`/`dev.js` and is not supervised by the control center. |
| F12 | Low | Docs | AGENTS.md says Node `>=22.5`, while package.json requires `>=24`. ARCHITECTURE.md describes a 60 s device-signature rule, but code allows 5 min of age plus 60 s of forward skew (`device-security.js`). The Android event HMAC path uses ±60 s. |

## 2. Plan (Phase 1)

Confirmed requirements come from the brief. Assumptions are marked (A).

### 2.1 Priorities for this delivery

1. **Correctness and security first:** F2 (queue fairness), F3 (late SMS evidence), F4, F5, F7.
2. **Staff identity and RBAC** (F1): real staff accounts, roles, merchant scoping, revocable
   sessions, lockout, and an audit trail. The legacy admin token stays valid as a
   machine/break-glass credential so integrations and tests keep working.
3. **Provider-independent OTP delivery:** a WhatsApp Cloud API (official) adapter, an email (SMTP)
   adapter, the existing linked-device adapter behind an explicit opt-in, a dev-only console
   adapter that refuses to run in production, and channel policy with fallback.
4. **Design system** shared by all apps, then:
   * a new role-aware **Operations Console** (`/console` on merchant-admin) for merchants, cashiers,
     support and admins, backed by real database queries.
   * a checkout visual refresh on the shared tokens, without changing the verified DOM contract.
5. Docs: configuration, the evidence model, and the delivery report.

### 2.2 Roles (A: role names chosen to match the brief)

| Role | Scope | Can |
| --- | --- | --- |
| `platform_admin` | all merchants | everything, including staff management and system health |
| `merchant_admin` | one merchant | dashboards, payments, exports, webhooks, branding, team |
| `cashier` | one merchant | live sessions, queue, receiving-account status, cancel with reason |
| `support` | one merchant | payments (read), tickets, audit (read) |
| `developer` | one merchant | payments (read), webhooks, API settings (read) |
| `viewer` | one merchant | dashboards (read) |

**No role can mark a payment SUCCESS.** There is no such endpoint. SUCCESS comes only from the verification engine.

### 2.3 Schema changes (forward-only, additive)

* `schema_migrations(version, name, applied_at)`: versioned migration ledger.
* `staff_users`: staff identity with an scrypt password hash, role, merchant scope, lockout counters.
* `staff_sessions`: hashed opaque session tokens and CSRF token hashes, with expiry and revocation.

Both schema files are updated, and the parity test covers them. No existing table or row changes.
Rollback: the new tables are independent. Dropping them restores the previous behaviour. See
`docs/MIGRATIONS.md`.

### 2.4 Deliberately out of scope for this pass

* Rewriting the 7.5k-line legacy admin. It stays at `/` for WhatsApp pairing, Gmail OAuth,
  Android pairing and developer tools, and the console links to it.
* A PostgreSQL runtime adapter (there is no driver today).
* Building the Android APK (needs the Android SDK, which is not available here). The Java fix
  is made, but the APK is not rebuilt.
* Legal and compliance decisions (RBI/NPCI, DPDP Act retention, receiving-account ownership).
  These are listed in the delivery report as external prerequisites.

## 3. Delivery status

See `docs/DELIVERY_REPORT.md`.
