# YouPI-PG transformation: delivery report

Branch: `feature/enterprise-transformation` (local, not pushed). Baseline: `main` @ `d7b0741`.
Findings and plan: [TRANSFORMATION_PLAN.md](TRANSFORMATION_PLAN.md).

## Executive summary

The payment engine, customer authentication and staff access were made correct and honest first;
then a shared design system, a new role-aware operations console and a redesigned checkout were
built on top. Every change is test-backed: **46/46 test suites pass** (39 at baseline, 7 new suites,
existing suites extended) and `npm run typecheck` passes (it only covers `packages/common`).

## What was delivered

Status key: **Done** = implemented, tested and checked in a browser where it has UI.
**Partial** = implemented with the limits listed below. **Planned** = not started.

| Area | Status | What changed |
| --- | --- | --- |
| Queue fairness | Done | A vacant slot goes to the head of the queue, never a newcomer |
| Late Android SMS | Done (APK not rebuilt) | Signed with send time; 5 min age / 60 s skew window; device receive time used for matching |
| OTP delivery | Done | Provider-independent dispatcher: WhatsApp Cloud API (official), linked-device WhatsApp (explicit), SMTP email, dev console (never in production); channel order + fallback; 503 instead of fake success |
| Account enumeration | Done | `check-user` no longer returns name/email before OTP |
| Staff identity & RBAC | Done | Staff accounts (scrypt), 6 roles, merchant scoping, lockout, CSRF, revocable sessions, audit trail; admin token kept as system principal |
| Console API | Done | Overview, payments (search/export/detail/cancel), operations, webhooks (retry), support, audit, settings (read-only), merchants, system health |
| Design system | Done | `@youpi/ui`: tokens, components, self-hosted fonts, AA contrast in light and dark |
| Operations console UI | Done | `/console` on merchant-admin, strict CSP, all pages verified against seeded data |
| Checkout redesign | Partial | Theme layer on the existing DOM, zoom re-enabled, amount before sign-in, same-device UPI intent, honest copy. The checkout's DOM/JS was not rewritten |
| Honest UI copy | Done | Removed fake social proof, unearned "verified" badges and encryption marketing; customer status describes what is measured; false-narrative override inert in production |
| Backups | Done | `npm run db:backup` (online, integrity-checked, retention); restore guide in [MIGRATIONS.md](MIGRATIONS.md) |
| Merchant branding editor in console | Planned | Console settings are read-only; editing remains in the legacy hub (platform admins) |
| Support portal (`payment-help`) supervision | Planned | Still not started by `start.js`; the console's Support page covers staff-side tickets |
| Legacy admin hub rewrite | Planned | Still at `/` for WhatsApp pairing, Gmail OAuth, Android pairing and developer tools |

## Commits

```
fix(queue): give a vacant slot to the head of the queue, not a newcomer
fix(observers): stop dropping late-forwarded Android SMS evidence
feat(auth): provider-independent customer OTP delivery with honest results
fix(checkout): remove fabricated social proof and unearned trust badge
feat(staff): staff accounts, RBAC, merchant-scoped console API, backups
feat(ui): shared YouPI design system package (@youpi/ui)
fix(otp): keep local development usable when WhatsApp is not linked
feat(console): role-aware operations console at /console
feat(checkout): design-system theme, same-device UPI intent, honest status
```

## Getting started (after pulling this branch)

```bash
npm ci
npm run staff:create -- --email you@company.in --name "Your Name"
npm start            # or: npm run dev for localhost mode
```

Open `http://localhost:6001/console` and sign in with the printed temporary password, then change it
under **Account**. Add team members from **Team**. Configure OTP delivery (see
[CONFIGURATION.md §1c](CONFIGURATION.md)) and schedule `npm run db:backup`.

## Database migrations

Migration 2 adds `schema_migrations`, `staff_users`, `staff_sessions` (both schema variants). It is
additive and tested by upgrading an existing database with data (`migration-ledger.test.js`).
Rollback and restore: [MIGRATIONS.md](MIGRATIONS.md).

## Tests executed (actual results)

`npm test`: **46/46 suites pass**. New suites:

| Suite | Tests | Covers |
| --- | --- | --- |
| `packages/core/.../queue-fairness.test.js` | 4 | queue order, idempotent activation |
| `packages/core/.../otp-delivery.test.js` | 15 | Cloud API payload, failures, fallback, no OTP in logs, prod lock |
| `packages/db/.../migration-ledger.test.js` | 2 | upgrade with data preserved, scrypt storage |
| `apps/payment-api/.../otp-channels.test.js` | 5 | 503 on failure, code withdrawn, email fallback, single use |
| `apps/payment-api/.../staff-console-rbac.test.js` | 14 | lockout, cookies, CSRF, merchant isolation, roles, no force-success, last admin, CSV injection, logout revocation, rate limit |
| `apps/merchant-admin/.../console-shell.test.js` | 3 | strict CSP, asset allow-list, no innerHTML |
| `apps/checkout-portal/.../checkout-ux-honesty.test.js` | 5 | zoom, no fabricated claims, assets, UPI intent, status copy |

Existing tests changed and why (no assertion was weakened):

* Queue fixtures in three suites now clear leftover QUEUED sessions; they relied on queue jumping.
* The Android drift test asserts the new window on both sides.
* `check-user` tests now assert that no profile data is returned.
* Label/copy assertions updated where customer wording changed deliberately.

Known flake: one `payment-api.test.js` run failed once at baseline-plus-F2 and passed on every rerun.

## Browser verification

Built-in browser against a throwaway preview database seeded with fictional data:
console sign-in, every console page (desktop and tablet widths, dark theme), payment drawer;
checkout at 375 px: sign-in, OTP, QR screen, UPI intent link. Not covered: real devices, iOS Safari,
screen-reader testing, the legacy admin hub.

## Security findings

Fixed: F1 shared admin token (now real accounts), F2 queue jumping, F3 lost SMS evidence, F4
enumeration, F5 fake OTP success, F6 hardcoded module paths and unofficial-provider default,
F7/F7b fabricated trust claims, false-narrative override in production, disabled zoom.

Remaining (need a decision or more work):

* Android device signing keys are stored unencrypted in `android_devices.signing_key_hash`
  (the column holds the key itself). Encrypt at rest with a migration.
* `FRAUD_PATTERNS` auto-bans on broad words (`attack`, `exploit`, `malicious`). Review the policy.
* Abandoned QUEUED sessions never expire on their own; each is eventually promoted and holds the
  slot for a full payment window.
* The checkout page and legacy admin still need `'unsafe-inline'` scripts (large inline JS).
* `merchant.branding.primaryColor` should be validated as a hex colour on save.

## External prerequisites before production

These are not engineering decisions. Confirm them with qualified advisers:

* The permitted payment model under RBI/NPCI rules for collecting into the receiving accounts,
  and documented ownership/authorisation for every receiving account and bank-alert mailbox/phone.
* Customer disclosures and privacy notice (DPDP Act 2023), data-retention periods for payments,
  bank notifications and audit logs, and grievance contact.
* A WhatsApp Business Platform account and approved authentication template, or an SMTP relay.
* TLS termination, backups shipped off-host, and monitoring on the System health checks.
