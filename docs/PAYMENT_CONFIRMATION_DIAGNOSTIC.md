# Payment confirmation diagnostic

Date: 2026-10-29 (IST evening). Branch: `fix/checkout-qr-layout`, local and not pushed.

**Final status: LOCAL TESTS PASS.** The synthetic end-to-end flow works: order → credit alert → SUCCESS stored → checkout shows Payment Successful. Detection of real bank alerts is **unconfirmed**. On this machine no real bank alert has reached the backend since 2026-10-26, because no source is set up that can deliver one for the active UPI ID. A controlled live test is not appropriate yet (see section 11).

## 1. Root cause of the missing success screen

The checkout was not the problem. It never showed success because **the backend never received any bank alert to verify**. The flow stops at step E: no observer delivered an observation for your payments.

| Step | Status on this machine | How it was checked |
|---|---|---|
| A–B Order created and stored | ✅ Works. Sessions were created, activated and bound to the customer | `payment_sessions` rows, audit `PAYMENT_SLOT_ACTIVATED` |
| C Customer pays | Not observed by me. You report paying | n/a |
| D Bank sends a credit alert | Unknown. It goes to the phone/SIM or mailbox the bank uses | n/a |
| **E Observer receives and forwards it** | **❌ Nothing forwarded.** No Android observer is paired (`android_devices` is empty). The Gmail observer is polling (`/health` on :6003 shows `isRunning: true`) but has `observedCount: 0` | DB query and `/health` |
| F–G API records and parses it | ❌ Nothing arrived. The newest row in `payment_observations` is from 2026-10-26T09:01Z | DB query |
| H–I Attribution and SUCCESS | Never reached. Your sessions ended as `CANCELLED` (Cancel pressed) or `EXPIRED` (5-minute window) | `payment_sessions.status` |
| J Webhook | Never reached | `webhook_deliveries` |
| K Checkout shows SUCCESS | ✅ Works whenever the backend says SUCCESS (verified below) | Browser end-to-end run |

There is a likely reason no alert could arrive:

- **SMS.** For a PhonePe `@ybl` UPI ID, the linked bank sends the credit alert by **SMS to the phone registered with that bank account**. Without a paired Android observer on that phone, the gateway never sees it.
- **Gmail.** The Gmail observer only helps if that bank also **emails** credit alerts to the connected Gmail account. Many banks do not email P2P UPI credits, or only do so when email alerts are turned on.
- **"Jeevan" UPI ID.** Two of the tonight's test orders (`bb270c28…` EXPIRED and `9cc36341…` CANCELLED) used the receiving UPI ID `8309601870-5@ybl` (payee "Jeevan"). The credit alert for a payment to that UPI ID goes to that person's phone or email, not to any observer on this machine. It can never auto-confirm here.

The checkout also warned about this. Its health indicator shows **YELLOW** (confirmation "may take longer") when SMS observation is down and only Gmail is up. That is the message you saw.

There was also a gap in diagnosis. Before this change, an observation the pipeline **rejected** left no record anywhere: only a line in the Gmail observer's console. So the backend cannot tell us after the fact whether a bank email arrived and was rejected (wrong sender domain, unparseable, wrong amount) or never arrived at all. That gap is now closed (section 7). Repeat the test with the fix running and the cause will be visible.

## 2. Did the bank notification reach the observer?

- **SMS / Android: No.** No device is paired. Nothing was received.
- **Gmail: Unknown.** The observer polls Gmail with the search `subject:(credit OR credited OR received OR upi OR deposit OR alert)`. It has accepted 0 messages. Messages it rejected went only to its console, so they can't be checked now.

## 3. Did the backend receive and parse an observation?

**No.** No `payment_observations` row has been stored since 2026-10-26, and no rejection record exists for tonight. Before this change, rejections were not recorded at all.

## 4. Did attribution succeed?

**Not reached.** There was nothing to attribute.

## 5. Did the database order status change?

Yes, but never to SUCCESS. Customer cancellation set `CANCELLED`, and the 5-minute window set `EXPIRED`. Both are correct for a payment that was never observed.

## 6. Did the checkout fetch the new status?

**Yes.** The checkout listens to the server-sent event stream (`/api/v1/checkout/:id/stream`) and also polls `/api/v1/checkout/:id/state` every 2 seconds. It showed CANCELLED and EXPIRED as they happened. In a disposable end-to-end run, a synthetic credit turned an open checkout into **Payment Successful** within about 2 seconds, with no page action.

## 7. Files modified and fixes made

| File | Change |
|---|---|
| `apps/payment-api/src/routes/pollers.routes.js` | (1) Every observation the pipeline does not settle now writes an `OBSERVATION_NOT_SETTLED` audit record. The record holds channel, source, sender header, status, stage, reason, parsed amount, the **last 4 digits** of the reference, and the text length. **It never stores the message text.** Routine personal or promo SMS without an amount are skipped. (2) New admin-only `GET /api/v1/admin/observations/diagnostics?limit=N`. It returns those records, the time of the last stored observation, and the Android devices' heartbeat and last-observation times. |
| `apps/payment-api/src/routes/checkout.routes.js` | The terminal checkout state now includes `merchantName`, `method` and `verificationTag`. For SUCCESS it also includes `utr`, `completedAt` and `livemode`, all from the stored session and its attributed observation. This fixes two existing bugs: the terminal screen showed the placeholder "Merchant Name", and a COD order's success screen said "Payment Successful" instead of "Order Placed", because `method` was missing. |
| `apps/checkout-portal/src/views/checkout.html` | (1) `loadState` runs one request at a time: a call made meanwhile re-runs once afterwards. A late pending response can no longer overwrite a terminal state (a race between SSE, the 2-second poll and the queue poll). (2) The 2-second fallback poll now stops on **every** terminal status: SUCCESS, FAILED, EXPIRED, CANCELLED, SUSPICIOUS and BLOCKED. Before, it kept polling CANCELLED and SUSPICIOUS sessions forever. (3) `renderSuccessReceipt` fills the order, UTR and time rows from the backend only, hides any row the backend did not return, and shows a "Test payment" badge when `livemode === false`. |
| `apps/checkout-portal/src/views/partials/payment-methods.html` | Receipt rows and the test-payment badge in the success view. |
| `apps/checkout-portal/public/css/checkout-theme.css` | Styles for the receipt and badge (cache key bumped to `v=5`). |
| `apps/payment-api/src/__tests__/payment-confirmation-diagnostics.test.js` | New, 10 tests. |
| `apps/checkout-portal/src/__tests__/checkout-status-sync.test.js` | New, 10 tests. |
| `scripts/test-all.js` | Registers both new suites. |

No dependencies, environment variables or database schema changed. The diagnostics reuse the existing `audit_logs` table.

## 8. Tests executed

| Command | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm run build` (`tsc -b`) | Passed |
| `npm test` | **53/53 suites passed, 0 failed, 0 skipped.** In earlier runs today, `payment-api.test.js` › "A delivery that failed is sent again by the retry daemon" failed intermittently, 2 times out of 4. The test reads `is_successful` before the webhook engine records the retry's 200 response. It is unrelated to this change, and that file passes when run on its own. |
| New: payment-confirmation-diagnostics | 10/10 |
| New: checkout-status-sync | 10/10 |
| Browser end-to-end on a disposable in-memory stack (API :6295, portal :7098, synthetic SMS) | Pending checkout survived a refresh and stayed pending, with the QR shown. After the synthetic credit it switched to Payment Successful automatically, showing order, UTR and time. The fallback poll made **0** state requests in the 7 seconds after success. After a refresh it still showed SUCCESS with the same UTR. |

Coverage of the 28 requested cases. "New" means added today; the rest were already covered by existing suites, with names given.

| # | Case | Where |
|---|---|---|
| 1 | Pending order created | payment-detection-scenarios "payment request…starts pending"; new "pending order" |
| 2–5 | Valid synthetic credit, amount, UTR, delivered to backend | payment-detection-scenarios "valid notification settles…"; new "settled order" |
| 6–7 | SUCCESS stored, status endpoint returns it | new "settled order" (DB row and `/state` agree) |
| 8 | Frontend renders success after the backend changes | new checkout-status-sync "then SUCCESS once the backend reports it"; browser end-to-end |
| 9 | Stays pending while the backend is pending | new checkout-status-sync; payment-detection-scenarios "pending payment stays pending" |
| 10 | Invalid or unreachable status endpoint | new checkout-status-sync "never renders success" |
| 11 | Wrong amount | payment-detection-scenarios "incorrect amount"; new (recorded as `AMOUNT_MISMATCH`) |
| 12 | Debit | payment-detection-scenarios; observation-security "transaction direction"; new |
| 13 | Refund or reversal | payment-detection-scenarios "reversal"; new (`REVERSAL_OR_REFUND`) |
| 14 | Ambiguous direction | observation-security; new |
| 15 | Duplicate UTR | payment-detection-scenarios "reused UTR"; new |
| 16 | Duplicate observation | payment-detection-scenarios "duplicate notification" |
| 17 | Expired order | payment-detection-scenarios "expired and cancelled orders"; new |
| 18 | Unmatched transaction | payment-detection-scenarios "no open order"; new |
| 19 | Invalid observer authentication | payment-detection-scenarios "untrusted sources"; observation-security "bad signature"; new |
| 20 | Stale timestamp | observation-security "stale timestamp…refused" |
| 21 | Multipart SMS assembly | **NOT RUN.** The joining happens in the APK (`SmsReceiver.java`, commit 7d30e90). That code has no automated test and could not be compiled here (section 10). The backend accepts a joined message the same as any other text. |
| 22 | Database failure | payment-detection-scenarios "database unavailable" |
| 23–24 | Concurrent matching orders, two orders with the same amount | observation-security "same-amount orders queue…"; payment-detection-scenarios "arrives during verification settles once" |
| 25 | Refresh while pending | browser end-to-end |
| 26 | Refresh after success | new "settled order" (repeat `/state` identical); browser end-to-end |
| 27 | Polling stops after a terminal state | new checkout-status-sync; browser end-to-end (0 requests) |
| 28 | Webhook idempotency | observation-security "exactly one signed SUCCESS webhook despite duplicate…" |

Every bank message in these tests is synthetic, marked `[TEST DATA]`, and runs against an in-memory database. The tests cannot reach `data/youpi_pg.sqlite`. Admin test observations (`isTest`) are honoured only with the admin credential, and settle with `livemode: false`.

## 9. Commands

Start everything (restart after pulling these changes, because the API and portal code changed):

```powershell
npm run dev
```

Health checks (no secrets needed):

```powershell
curl http://localhost:6100/health   # payment API
curl http://localhost:6003/health   # Gmail observer: isRunning, lastPollAt, observedCount
curl http://localhost:6002/health   # SMS observer service
```

For admin endpoints, the admin token lives in `data/.secrets/admin_api_token`, or the `ADMIN_API_TOKEN` env variable. Never paste it into chat or logs:

```powershell
$t = Get-Content data/.secrets/admin_api_token -Raw
# Observer diagnostics: what arrived, where it stopped (no message text)
curl -H "Authorization: Bearer $($t.Trim())" "http://localhost:6100/api/v1/admin/observations/diagnostics?limit=20"
# Paired phones and heartbeats
curl -H "Authorization: Bearer $($t.Trim())" http://localhost:6100/api/v1/admin/sms-gateway/devices
```

Order status (what the checkout polls):

```powershell
curl http://localhost:6100/api/v1/checkout/<paymentId>/state
```

Payment-flow tests:

```powershell
node --test apps/payment-api/src/__tests__/payment-confirmation-diagnostics.test.js
node --test apps/payment-api/src/__tests__/payment-detection-scenarios.test.js
node --test apps/checkout-portal/src/__tests__/checkout-status-sync.test.js
npm test
```

Disposable test order: use the store at http://localhost:5000 (Buy Now). Every order is a real session in your local database, but it only settles if a verified credit alert arrives. For a fully isolated run, use the in-memory pattern from `payment-confirmation-diagnostics.test.js`.

**Finding the stage where a real alert stops.** Pay a small amount only once you have decided to, and only after section 11 is in place. Then:

1. Open `/api/v1/admin/observations/diagnostics`.
2. **Nothing new and `lastStoredObservationAt` unchanged** → the alert never reached the backend. Check the phone: is it paired, is its heartbeat current, does it have an HTTPS URL? Or check Gmail: did the email arrive, does its subject match the search above?
3. **A `notSettled` entry** → read its `stage` and `reason`:
   - stage 2: sender or domain (`INVALID_EMAIL_DOMAIN`, `INVALID_SMS_SENDER`, `MISSING_SMS_SENDER`). `UNVERIFIED_NOTIFICATION_SENDER` is a Google Messages / Samsung Messages / Truecaller notification: it carries no SMS originating address, so it never settles a payment; the SMS broadcast copy of the same message does.
   - stage 3: text and direction (`MISSING_RAW_TEXT`, `MISSING_CREDIT_INDICATOR`, `DEBIT_NOTIFICATION`, `REVERSAL_OR_REFUND`)
   - stage 4: matching (`NO_ACTIVE_SESSION`, `AMOUNT_MISMATCH`)
   - duplicates: a reused UTR
4. **Session SUCCESS but the screen did not change** → check the browser console and network for `/state`. This did not happen in testing.

## 10. Real-device path

| Check | Result |
|---|---|
| Android observer build | **NOT RUN.** No JDK or Android SDK on this PC (`java` not found). The committed APK predates both the 2026-10-25 signing change and the multipart-SMS fix (7d30e90), so it needs rebuilding before use. |
| Install, pairing, heartbeat | **NOT RUN.** No device paired. |
| HTTPS connectivity | **NOT RUN.** The pairing QR points at localhost, which a phone cannot use. You need a public HTTPS URL, for example a Cloudflare Tunnel. |
| Synthetic delivery through an isolated environment | ✅ Ran against the disposable in-memory stack (observer route, real pipeline, real checkout). |
| Real bank alert to checkout | **NOT RUN.** It needs a real transfer, which you have not authorised. |

## 11. Remaining security risks and missing integrations

- **No authoritative verification.** Confirmation infers payment from bank SMS or email text. HMAC and signatures prove *which observer* sent an alert, **not that the alert text is genuine**. A compromised phone or mailbox can submit fabricated text. **This is not production-secure.** For production, use a regulated payment provider or acquiring bank that offers a signed webhook or a transaction-status API, with your order ID carried through as the transaction reference.
- **Weak order correlation.** UPI credit alerts usually do not include the payer's note or `tr`, so attribution relies on the amount, the time window and a single active session per UPI ID. Same-amount orders are queued, so only one can be open at a time. An unmatched or late credit is held for manual review (`LATE_UNMATCHED` support ticket), never assigned to an arbitrary order.
- **Gmail sender trust.** The pipeline treats `sender === 'gmail-browser-automator'` as a valid email domain. That path deserves review.
- **Stale device identity in the browser.** If the API database is reset while a browser still holds a device ID in IndexedDB, the checkout shows "Duplicate session" for every order on that browser, because it never re-registers. I hit this in testing; clearing site data fixes it. Not changed here.
- **Flaky test.** The webhook-retry test is timing-dependent (section 8).

**Is a controlled live test appropriate?** **Not yet.** Before a small test that you explicitly authorise:

1. Rebuild the APK with a JDK and Android SDK, install it on the phone that receives the bank's SMS, and pair it over a public HTTPS URL. Or confirm that your bank emails credit alerts to the connected Gmail account.
2. Make sure the active receiving UPI ID belongs to the account whose alerts that phone or mailbox receives. Do not use `8309601870-5@ybl` ("Jeevan").
3. Restart `npm run dev`, so that `/api/v1/admin/observations/diagnostics` is live and you can see where the alert stops.

---

## Issue B: blank "Device Security Verification" panel (2026-10-30)

**CHECKOUT UI ROOT CAUSE:** Confirmed. When the first `/state` response is the API's 409 `DUPLICATE_SESSION_DETECTED`, `renderDuplicateSession()` changes the title and unhides `#viewDuplicateSessionContent`. That view sits inside `#paymentGatewayInterface`, which starts hidden with `display: none !important`, and nothing had shown it yet. The view rendered at 0×0. `renderBlockedState()` had the same flaw. This is not a regression from earlier work and is unrelated to the SMS observer or payment API.

**CHECKOUT FILES CHANGED:**
- `apps/checkout-portal/src/views/checkout.html`: `setGatewayAuthMode(false)` is now called in both renderers, 2 lines plus comments.
- `apps/checkout-portal/src/__tests__/checkout-status-sync.test.js`: 2 tests that fail without the fix.

**ICONS AND VERIFICATION CONTENT:** With a mocked 409 at http://localhost:5000, the badge, warning icon (inline SVG), title, explanation and "End session & start new payment" button render at 670×413 px. There were no failed CSS, font, image or JS requests. The icons are inline SVG, so no icon library is involved.

**SMS OBSERVER STATUS:** Investigated separately (Issue A above). No shared cause. Uncommitted `apps/sms-observer/*` changes in the working tree belong to other work; I left them alone and did not commit them.

**REGRESSION TESTS:** `npm test`: 53/53 suites passed. `npm run typecheck`: passed. checkout-status-sync: 12/12.

**PAYMENT SECURITY:** Device binding, duplicate-session detection and fraud blocking are unchanged. Only the visibility of their screens was fixed. No verification result is faked.

**NEXT STEP:** Restart `npm run dev`, then reopen the checkout. If the duplicate screen appears, press "End session & start new payment". It means this browser's saved device ID is not registered with the API, or the order is open on another device.
