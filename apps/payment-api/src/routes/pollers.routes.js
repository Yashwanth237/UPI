import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpServer } from '../server.js';
import { ObservationNormalizer, BankSmsParser, BankEmailParser, generateQrSvg } from '@youpi/core';
import { toRupeesString, toPaise, verifyHmac, resolveRuntimeUrls, resolveSecret, safeEqual, hasBearer, getObserverToken, isAllowedNotificationPackage } from '@youpi/common';
import { isAdminRequest } from '../auth-guard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Upper bound on a single bank notification body accepted by the verification pipeline. */
const MAX_OBSERVATION_TEXT_CHARS = 64 * 1024;

/**
 * Pipeline result as returned to an observer. The observer already holds the message it sent,
 * so the response carries reasons and parsed fields only: echoing the bank message body (and the
 * fraud evidence package, which repeats it) put full transaction text into client logs and
 * proxies for no benefit.
 */
function redactPipeline(result) {
  if (!result || typeof result !== 'object') return result;
  const { raw, ...rest } = result;
  const stage5 = rest.stages?.stage5;
  if (stage5 && typeof stage5.details === 'object') {
    rest.stages = { ...rest.stages, stage5: { ...stage5, details: 'redacted' } };
  }
  return rest;
}

/** Audit action for an observation the pipeline did not settle. */
export const OBSERVATION_NOT_SETTLED = 'OBSERVATION_NOT_SETTLED';

/**
 * Records why an observation did not settle a payment, without its message text, so a missing
 * "Payment Successful" can be traced to a stage. Before this, rejected observations left no
 * record at all: only the observer's console line said anything.
 * Kept: source, sender header, stage, reason, parsed amount, last 4 of the reference, text length.
 * @param {any} ctx
 * @param {{ channel: string, source: string, sender?: string, receivingAccountId?: string, rawText?: string, pipeResult: any }} input
 */
function recordObservationNotSettled(ctx, { channel, source, sender, receivingAccountId, rawText, pipeResult }) {
  if (!ctx.auditRepo || !pipeResult || pipeResult.status === 'VERIFIED') return;
  try {
    const account = receivingAccountId && ctx.accountRepo ? ctx.accountRepo.findById(receivingAccountId) : null;
    const reference = String(pipeResult.reference || pipeResult.stages?.stage3?.details?.reference || '');
    ctx.auditRepo.log({
      merchantId: account?.merchantId || null,
      entityType: 'OBSERVATION',
      entityId: pipeResult.messageId || 'unknown',
      action: OBSERVATION_NOT_SETTLED,
      actorType: 'OBSERVER',
      details: {
        channel,
        source,
        sender: typeof sender === 'string' ? sender.slice(0, 80) : null,
        receivingAccountId: receivingAccountId || null,
        status: pipeResult.status || 'UNRESOLVED',
        stage: pipeResult.failingStage ?? null,
        reason: pipeResult.failingCondition || pipeResult.stages?.stage6?.outcomeStatus || 'UNRESOLVED_OBSERVATION',
        amountPaise: pipeResult.amountPaise != null ? String(pipeResult.amountPaise) : null,
        referenceLast4: reference ? reference.slice(-4) : null,
        textLength: typeof rawText === 'string' ? rawText.length : 0
      }
    });
  } catch {
    // Diagnostics must never change the outcome of an observation.
  }
}

/**
 * Whether a paired phone can reach `url`. The observer APK refuses cleartext except to loopback
 * and the emulator host (network_security_config.xml), so a physical phone needs an https:// URL
 * on a host that is not localhost.
 *
 * `allowLanHttp`: the operator set YOUPI_ANDROID_GATEWAY_URL to a private-LAN http:// address,
 * which the phone reaches only with an APK built with that host in YOUPI_ANDROID_LAN_HOSTS.
 * `bindHost`: where the payment API listens; a loopback bind is unreachable from the LAN.
 * @param {string} url
 * @param {{ allowLanHttp?: boolean, bindHost?: string }} [options]
 * @returns {{ ok: boolean, warning: string | null }}
 */
export function assessPhoneReachability(url, { allowLanHttp = false, bindHost } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, warning: 'The gateway API URL is not a valid URL.' }; }
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '[::1]' || host === '0.0.0.0') {
    return { ok: false, warning: `The pairing QR points at ${parsed.origin}, which on the phone means the phone itself. Set YOUPI_ANDROID_GATEWAY_URL to this computer's LAN address, or a public HTTPS API address, before pairing.` };
  }
  if (parsed.protocol !== 'https:') {
    if (!(allowLanHttp && isPrivateLanIPv4(host))) {
      return { ok: false, warning: `The pairing QR uses plain HTTP (${parsed.origin}). The observer app only connects over HTTPS; use an HTTPS address.` };
    }
    if (bindHost && (bindHost === 'localhost' || /^127\./.test(bindHost) || bindHost === '::1')) {
      return { ok: false, warning: `The pairing QR points at ${parsed.origin}, but the payment API listens on ${bindHost} only. Set YOUPI_BIND_HOST=${host} and restart it.` };
    }
    return { ok: true, warning: `Plain HTTP on the local network (${parsed.origin}). The phone connects only if its APK was built with YOUPI_ANDROID_LAN_HOSTS=${host}, and only while it is on this Wi-Fi.` };
  }
  return { ok: true, warning: null };
}

const TELEMETRY_COUNTERS = ['smsReceived', 'smsKeptOnDevice', 'smsQueued', 'duplicatesIgnored', 'uploadAttempts', 'uploadsAccepted', 'uploadsRejected', 'uploadsRetried', 'expiredUnsent'];
const TELEMETRY_TIMES = ['lastSmsReceivedAt', 'lastQueuedAt', 'lastUploadAttemptAt', 'lastUploadAcceptedAt', 'workerStartedAt'];

/**
 * Whitelists the delivery counters a phone reports in its signed heartbeat: numbers, epoch-ms
 * times and HTTP status codes only. Message text, senders and phone numbers are never kept, even
 * if a client sent them. Returns null when the heartbeat carried no telemetry (older APKs).
 * @param {any} body
 */
export function sanitizeAndroidTelemetry(body) {
  const src = body && typeof body.telemetry === 'object' && body.telemetry ? body.telemetry : null;
  if (!src) return null;
  const count = v => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  const time = v => (Number.isSafeInteger(v) && v > 0 ? new Date(v).toISOString() : null);
  const out = {};
  for (const k of TELEMETRY_COUNTERS) out[k] = count(src[k]);
  for (const k of TELEMETRY_TIMES) out[k] = time(src[k]);
  out.lastUploadHttpStatus = Number.isInteger(src.lastUploadHttpStatus) && src.lastUploadHttpStatus >= -1 && src.lastUploadHttpStatus < 600 ? src.lastUploadHttpStatus : null;
  out.workerRunning = typeof src.workerRunning === 'boolean' ? src.workerRunning : null;
  out.smsPermissionGranted = typeof src.smsPermissionGranted === 'boolean' ? src.smsPermissionGranted : null;
  out.pendingUploads = count(body.pendingObservations);
  out.appVersion = typeof src.appVersion === 'string' ? src.appVersion.slice(0, 32).replace(/[^\w.+-]/g, '') : null;
  return out;
}

/** RFC 1918 private IPv4 address (10/8, 172.16/12, 192.168/16). */
export function isPrivateLanIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host || ''));
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some(n => n > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * The API address the pairing QR hands to the phone: YOUPI_ANDROID_GATEWAY_URL when set (a LAN
 * address for local testing), otherwise the canonical runtime API URL.
 * @param {string} runtimeApiUrl
 * @returns {{ url: string, overridden: boolean }}
 */
export function resolveAndroidGatewayUrl(runtimeApiUrl) {
  const configured = String(process.env.YOUPI_ANDROID_GATEWAY_URL || '').trim().replace(/\/+$/, '');
  if (configured && /^https?:\/\/[^/\s]+$/i.test(configured)) {
    return { url: configured, overridden: true };
  }
  return { url: runtimeApiUrl, overridden: false };
}

/** Android observer request limits: signed-timestamp window and raw body size. */
export const ANDROID_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
export const ANDROID_SIGNATURE_MAX_SKEW_MS = 60 * 1000;
const ANDROID_MAX_BODY_BYTES = 128 * 1024;
/** How long a pairing QR / token minted by the admin page stays usable. */
export const PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * Registers observation intake routes for SMS Gateway (Android Native Observer)
 * and Automated Observers (Gmail Direct API / Web Observers).
 * @param {HttpServer} server
 * @param {{
 *   attributionEngine: import('@youpi/core').AttributionEngine,
 *   db: import('@youpi/db').Database,
 *   auditRepo: import('@youpi/db').AuditLogRepository,
 *   sessionRepo?: import('@youpi/db').PaymentSessionRepository,
 *   accountRepo?: import('@youpi/db').ReceivingAccountRepository,
 *   merchantRepo?: import('@youpi/db').MerchantRepository
 * }} ctx
 */
export function registerPollerRoutes(server, ctx) {
  // No public fallback: env value, else a random secret persisted in data/.secrets/.
  const enrollmentSecret = resolveSecret('android_enrollment_secret', 'ANDROID_ENROLLMENT_SECRET');

  // Pairing tokens: `yp1.<expiresAtMs>.<hmac>` where hmac = HMAC(enrollmentSecret, merchantId:expiresAt).
  // The phone treats the token as opaque, so the existing APK pairs with it unchanged (QR or typed).
  const mintPairingToken = (merchantId, expiresAt) =>
    `yp1.${expiresAt}.${crypto.createHmac('sha256', enrollmentSecret).update(`${merchantId}:${expiresAt}`).digest('hex')}`;
  const verifyPairingToken = (token, merchantId) => {
    const match = /^yp1\.(\d{13})\.([0-9a-f]{64})$/.exec(token);
    if (!match) return false;
    const expiresAt = Number(match[1]);
    const now = Date.now();
    if (now > expiresAt || expiresAt - now > PAIRING_TOKEN_TTL_MS) return false;
    return safeEqual(token, mintPairingToken(merchantId, expiresAt));
  };
  /** Fingerprints of pairing tokens already used (also recorded in the pairing audit row). */
  const usedPairingTokens = new Set();
  /** Delivery counters from each device's last signed heartbeat, since this API started. */
  const deviceTelemetry = new Map();

  // GET /api/v1/pollers/active-window (Enables deep intelligent DOM scanning for active amounts and dual-layer verification)
  server.get('/api/v1/pollers/active-window', async (req, res) => {
    // Observer-only. This returns every in-flight session with its exact amount and VPA,
    // which is precisely the oracle needed to craft a matching synthetic bank observation.
    if (!isAdminRequest(req) && !hasBearer(req, getObserverToken())) {
      HttpServer.json(res, 401, { error: 'Unauthorized', code: 'AUTH_REQUIRED' });
      return;
    }
    const sixtySecsAgo = new Date(Date.now() - 60000).toISOString();
    const activeSessions = ctx.db.query(`
      SELECT id, order_id, receiving_account_id, amount_paise, status, verification_level, expires_at, processing_expires_at, completed_at
      FROM payment_sessions
      WHERE status IN ('ACTIVE', 'PROCESSING')
         OR (status = 'SUCCESS' AND verification_level < 2 AND completed_at >= ?)
      ORDER BY created_at DESC
    `, [sixtySecsAgo]);

    const sessions = activeSessions.map(s => ({
      id: s.id,
      orderId: s.order_id,
      receivingAccountId: s.receiving_account_id,
      amount: toRupeesString(s.amount_paise),
      amountPaise: Number(s.amount_paise),
      status: s.status,
      verificationLevel: s.verification_level || 0,
      expiresAt: s.expires_at,
      processingExpiresAt: s.processing_expires_at
    }));

    HttpServer.json(res, 200, {
      hasActivePayment: sessions.length > 0,
      sessions
    });
  });

  // POST /api/v1/pollers/events (Universal Observation Ingest for Gmail / SMS 2-Layer Observers)
  server.post('/api/v1/pollers/events', async (req, res) => {
    const body = await HttpServer.parseBody(req);

    if (!body.receivingAccountId || !body.source) {
      HttpServer.json(res, 400, { error: 'Missing required fields: receivingAccountId and source.' });
      return;
    }

    // Evaluate through Security & Fraud Verification Pipeline
    const rawText = body.rawText || body.text || body.message || body.sms || body.body || (typeof body.rawPayload === 'string' ? body.rawPayload : (body.rawPayload?.text || body.rawPayload?.body));
    const sender = body.sender || body.from || body.rawPayload?.sender || body.rawPayload?.from;

    // Reject missing or blank observation rawText
    if (!rawText || (typeof rawText === 'string' && !rawText.trim())) {
      HttpServer.json(res, 400, {
        accepted: false,
        status: 'REJECTED',
        reason: 'MISSING_RAW_TEXT',
        error: 'Observation rawText is required for verification.'
      });
      return;
    }

    // Bank notifications are small. Reject oversized bodies outright so no single observation
    // can be used to burn CPU or memory on the verification path.
    if (typeof rawText === 'string' && rawText.length > MAX_OBSERVATION_TEXT_CHARS) {
      HttpServer.json(res, 413, { error: `Observation body too large (max ${MAX_OBSERVATION_TEXT_CHARS} characters).` });
      return;
    }

    if (!ctx.pipeline) {
      HttpServer.json(res, 500, { error: 'Verification pipeline is not configured on this server.' });
      return;
    }

    const pipeResult = ctx.pipeline.process({
      source: body.source,
      rawText,
      sender,
      receivingAccountId: body.receivingAccountId,
      paymentSessionId: body.paymentSessionId,
      bankReferenceNumber: body.bankReferenceNumber || body.utr,
      // Test flags relax verification: honour them only for the admin credential, never for observers.
      isTest: Boolean(body.isTest) && isAdminRequest(req),
      testModeActive: Boolean(body.testModeActive) && isAdminRequest(req),
      isSimulated: Boolean(body.isTest) && isAdminRequest(req)
    });
    recordObservationNotSettled(ctx, {
      channel: 'POLLER_EVENTS', source: body.source, sender, receivingAccountId: body.receivingAccountId, rawText, pipeResult
    });

    if (pipeResult.status === 'REJECTED' && pipeResult.failingCondition === 'FRAUDULENT_PAYMENT_INJECTION') {
      HttpServer.json(res, 403, {
        accepted: false,
        status: 'REJECTED',
        reason: 'FRAUDULENT_PAYMENT_INJECTION',
        threatDetected: true,
        banned: true,
        error: 'FRAUDULENT_PAYMENT_INJECTION: Positive identification of fake payment message. Customer account banned and session terminated.'
      });
      return;
    }

    if (pipeResult.status === 'VERIFIED') {
      HttpServer.json(res, 200, {
        accepted: true,
        observationId: pipeResult.messageId || pipeResult.stages?.stage6?.details?.observationId,
        attribution: pipeResult.stages?.stage6?.details || pipeResult,
        pipeline: redactPipeline(pipeResult)
      });
      return;
    }

    if (pipeResult.status === 'REJECTED') {
      HttpServer.json(res, 400, {
        accepted: false,
        status: 'REJECTED',
        reason: pipeResult.failingCondition,
        error: pipeResult.failingReason || pipeResult.details,
        pipeline: redactPipeline(pipeResult)
      });
      return;
    }

    // A credit that arrives after its session has ended still has to be reconciled: the
    // pipeline verified the message but found no live session (stage 4). Hand it to the
    // attribution engine's late-match path so a LATE_UNMATCHED support ticket is raised
    // for the merchant instead of the payment being silently dropped.
    //
    // This is NOT a settlement route. It is only taken when the pipeline failed specifically
    // at stage 4 (i.e. the filter and parser stages passed) and no live session exists for
    // the account, and the engine's late path only flags the observation for manual review.
    if (
      pipeResult.failingStage === 4 &&
      pipeResult.failingCondition === 'NO_ACTIVE_SESSION' &&
      ctx.sessionRepo && ctx.attributionEngine
    ) {
      const liveSession = ctx.sessionRepo.findCurrentActiveOrProcessing(body.receivingAccountId);
      if (!liveSession) {
        try {
          const lateResult = ctx.attributionEngine.processObservation({
            source: body.source,
            receivingAccountId: body.receivingAccountId,
            amountPaise: pipeResult.amountPaise,
            bankReferenceNumber: pipeResult.reference || body.utr || body.bankReferenceNumber,
            observedAt: new Date(body.observedAt || Date.now()),
            sender,
            rawPayload: body.rawPayload || { text: rawText }
          });
          HttpServer.json(res, 200, {
            accepted: false,
            status: lateResult?.outcomeStatus || 'LATE_UNMATCHED',
            reason: 'LATE_OBSERVATION_NO_ACTIVE_SESSION',
            observationId: lateResult?.observationId || pipeResult.messageId,
            error: 'Payment credit was received after the session ended and has been queued for manual reconciliation.',
            pipeline: redactPipeline(pipeResult)
          });
        } catch (err) {
          HttpServer.json(res, 400, {
            accepted: false,
            status: 'UNRESOLVED',
            reason: pipeResult.failingCondition || 'UNRESOLVED_OBSERVATION',
            error: 'Payment observation could not be verified or attributed.'
          });
        }
        return;
      }
    }

    // Invert check: if status is not VERIFIED, return 4xx and NEVER fall through to direct attribution
    HttpServer.json(res, 400, {
      accepted: false,
      status: pipeResult.status || 'UNRESOLVED',
      reason: pipeResult.stages?.stage6?.outcomeStatus || pipeResult.failingCondition || 'UNRESOLVED_OBSERVATION',
      observationId: pipeResult.messageId || pipeResult.stages?.stage6?.details?.observationId,
      error: pipeResult.failingReason || 'Payment observation could not be verified or attributed.',
      pipeline: redactPipeline(pipeResult)
    });
  });

  // --- ANDROID SMS GATEWAY PAIRING HANDLER ---
  const handleAndroidPair = async (req, res) => {
    const body = await HttpServer.parseBody(req);
    const token = body.enrollmentToken || body.token;
    const merchantId = body.merchantId || '00000000-0000-0000-0000-000000000001';
    const deviceName = body.deviceName || 'Android SMS Gateway';
    const deviceModel = body.deviceModel || 'Android Device';

    // The token must be a pairing token minted by GET pair-qr: bound to this merchant and expiring.
    // Accepting the long-lived enrollment secret itself let anyone who had ever seen a pairing QR
    // (a screenshot, a shoulder-surf) pair a new "phone" months later and post signed bank SMS.
    if (!token || !verifyPairingToken(String(token), merchantId)) {
      HttpServer.json(res, 401, { error: 'Invalid or expired device pairing enrollment token.' });
      return;
    }

    if (body.expiresAt && Date.now() > Number(body.expiresAt)) {
      HttpServer.json(res, 400, { error: 'PAIRING QR EXPIRED' });
      return;
    }

    if (body.version && body.version !== 'v1') {
      HttpServer.json(res, 400, { error: 'INVALID YOUPI PAIRING QR' });
      return;
    }

    // Single use: each pairing QR registers one device. Re-scanning, or tapping "Update
    // Configuration" with the token still filled in, used to add another active registration
    // every time (five RMX5110 rows in ten minutes), and a leaked QR could be replayed until it
    // expired. Only a fingerprint of the token is stored.
    const pairingTokenId = crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32);
    const alreadyUsed = usedPairingTokens.has(pairingTokenId) || Boolean(ctx.db.queryOne(
      "SELECT 1 AS used FROM audit_logs WHERE action = 'SMS_GATEWAY_DEVICE_PAIRED' AND json_extract(details, '$.pairingTokenId') = ? LIMIT 1",
      [pairingTokenId]
    ));
    if (alreadyUsed) {
      HttpServer.json(res, 409, { error: 'This pairing QR was already used. Open Merchant Admin for a new QR.' });
      return;
    }
    usedPairingTokens.add(pairingTokenId);

    const deviceId = crypto.randomUUID();
    const signingKey = crypto.randomBytes(32).toString('hex');
    const nowIso = new Date().toISOString();

    // Re-pairing replaces the phone's previous registration, but only when the phone proves it
    // holds that registration's key: HMAC(previous key, "replace:<previousDeviceId>:<token>").
    // Without a valid proof nothing is deactivated, so a stranger cannot unpair someone else.
    let replacedDeviceId = null;
    if (body.previousDeviceId && body.previousProof) {
      const previous = ctx.db.queryOne(
        'SELECT id, merchant_id, signing_key_hash FROM android_devices WHERE id = ? AND is_active = 1',
        [String(body.previousDeviceId)]
      );
      if (previous && previous.merchant_id === merchantId && previous.signing_key_hash &&
          verifyHmac(`replace:${previous.id}:${token}`, previous.signing_key_hash, String(body.previousProof))) {
        replacedDeviceId = previous.id;
      }
    }

    try {
      ctx.db.execute(`
        INSERT INTO android_devices (id, merchant_id, device_name, device_model, signing_key_hash, is_active, last_heartbeat_at, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `, [deviceId, merchantId, deviceName, deviceModel, signingKey, nowIso, nowIso]);
      if (replacedDeviceId) {
        ctx.db.execute('UPDATE android_devices SET is_active = 0 WHERE id = ?', [replacedDeviceId]);
        deviceTelemetry.delete(replacedDeviceId);
      }

      if (ctx.auditRepo) {
        ctx.auditRepo.log({
          merchantId,
          entityType: 'ANDROID_DEVICE',
          entityId: deviceId,
          action: 'SMS_GATEWAY_DEVICE_PAIRED',
          actorType: 'ADMIN',
          details: { deviceName, deviceModel, pairingTokenId, replacedDeviceId }
        });
        if (replacedDeviceId) {
          ctx.auditRepo.log({
            merchantId,
            entityType: 'ANDROID_DEVICE',
            entityId: replacedDeviceId,
            action: 'SMS_GATEWAY_DEVICE_REPLACED',
            actorType: 'SYSTEM',
            details: { replacedBy: deviceId }
          });
        }
      }

      HttpServer.json(res, 200, {
        paired: true,
        deviceId,
        signingKey,
        merchantId,
        replacedDeviceId,
        message: 'Android SMS Gateway paired successfully.'
      });
    } catch (err) {
      HttpServer.json(res, 500, { error: `Failed to register Android device: ${err.message}` });
    }
  };

  server.post('/api/v1/pollers/android/pair', handleAndroidPair);
  server.post('/api/v1/observers/sms/pair', handleAndroidPair);

  // --- ANDROID DEVICE REQUEST AUTHENTICATION ---
  // Reads the raw body (the HMAC covers its exact bytes) and checks the paired device's signature.
  // Responds and returns null on any failure; otherwise returns { device, deviceId, body, rawBodyText }.
  const authenticateAndroidDevice = async (req, res) => {
    const rawBodyText = await new Promise(resolve => {
      let data = '';
      let tooLarge = false;
      req.on('data', chunk => {
        if (tooLarge) return;
        data += chunk;
        if (data.length > ANDROID_MAX_BODY_BYTES) { tooLarge = true; data = null; }
      });
      req.on('end', () => resolve(data));
    });
    if (rawBodyText === null) {
      HttpServer.json(res, 413, { error: 'Payload Too Large' });
      return null;
    }

    let body = {};
    try {
      body = JSON.parse(rawBodyText || '{}');
    } catch {
      HttpServer.json(res, 400, { error: 'Invalid JSON payload.' });
      return null;
    }

    const deviceId = req.headers['x-device-id'] || body.deviceId;
    if (!deviceId) {
      HttpServer.json(res, 400, { error: 'Missing required X-Device-Id header or deviceId.' });
      return null;
    }

    // Verify registered device
    const device = ctx.db.queryOne('SELECT * FROM android_devices WHERE id = ? AND is_active = 1', [deviceId]);
    if (!device) {
      HttpServer.json(res, 403, { error: 'Device not authorized or inactive.' });
      return null;
    }

    // Verify HMAC Signature & Replay Drift Protection
    const timestampStr = req.headers['x-timestamp'];
    const signature = req.headers['x-signature'];

    // Signature is mandatory: omitting the headers must not skip verification.
    if (!device.signing_key_hash || !timestampStr || !signature) {
      HttpServer.json(res, 401, { error: 'Missing X-Timestamp / X-Signature headers.' });
      return null;
    }

    // Same policy as device-security.js: up to 5 minutes old, at most 60 s in the future.
    // A symmetric ±60 s window dropped genuine bank SMS whenever the phone forwarded them
    // late (offline, retry). Replays inside the window are absorbed by the observation
    // fingerprint and the one-attribution-per-UTR index.
    const ts = Number(timestampStr);
    const now = Date.now();
    if (isNaN(ts) || now - ts > ANDROID_SIGNATURE_MAX_AGE_MS || ts - now > ANDROID_SIGNATURE_MAX_SKEW_MS) {
      HttpServer.json(res, 401, { error: 'Timestamp drift exceeded validity window (replay protection triggered).' });
      return null;
    }

    const sigPayload = `${rawBodyText}:${timestampStr}`;
    if (!verifyHmac(sigPayload, device.signing_key_hash, signature)) {
      HttpServer.json(res, 401, { error: 'Invalid cryptographic HMAC signature.' });
      return null;
    }

    return { device, deviceId, body, rawBodyText };
  };

  // --- ANDROID SMS GATEWAY OBSERVATION INGESTION ---
  const handleAndroidSmsEvents = async (req, res, { requirePackage = false } = {}) => {
    const auth = await authenticateAndroidDevice(req, res);
    if (!auth) return;
    const { device, deviceId, body } = auth;

    // Resolve Receiving Account for this merchant
    let receivingAccountId = body.receivingAccountId;
    if (!receivingAccountId) {
      const activeAccount = ctx.accountRepo
        ? ctx.accountRepo.findActiveForMerchant(device.merchant_id)
        : ctx.db.queryOne('SELECT id FROM payment_receiving_accounts WHERE merchant_id = ? AND is_active = 1 LIMIT 1', [device.merchant_id]);
      receivingAccountId = activeAccount?.id || '00000000-0000-0000-0000-000000000002';
    }

    // Extract amount and details: either pre-parsed or from raw bank SMS
    let amountPaise = body.amountPaise ? BigInt(body.amountPaise) : undefined;
    let bankRef = body.bankReferenceNumber || body.utr;
    let senderVpa = body.senderVpa;
    // When the bank message reached the phone. The body is HMAC-signed by the paired device, so
    // its receive time is used rather than the arrival time here: a late-forwarded SMS must be
    // judged against the session that was open when it was received, not the one open now.
    let observedAt = new Date();
    const deviceObservedAt = body.observedAt ?? body.timestamp;
    if (deviceObservedAt !== undefined && deviceObservedAt !== null && deviceObservedAt !== '') {
      const candidate = new Date(typeof deviceObservedAt === 'string' && /^\d+$/.test(deviceObservedAt) ? Number(deviceObservedAt) : deviceObservedAt);
      if (!isNaN(candidate.getTime()) && candidate.getTime() <= Date.now() + ANDROID_SIGNATURE_MAX_SKEW_MS) {
        observedAt = candidate;
      }
    }

    // Security Invariant (Issues #24, #61): the notification package must be declared and
    // must be on the allowlist. Validating it only when `rawNotification` was present let a
    // caller omit the field entirely and still reach the verification pipeline.
    //
    // The package is required on the notification-listener route, which is where the
    // allowlist is the control. The plain SMS-broadcast route has no package to report (the
    // broadcast only carries the sender address) and is authenticated by the device HMAC
    // instead, so requiring one there would break the observer.
    const rawPkg = body.rawNotification?.package;
    if (requirePackage) {
      if (!rawPkg || typeof rawPkg !== 'string' || !rawPkg.trim()) {
        HttpServer.json(res, 400, {
          accepted: false,
          error: 'Android notification observation must specify a valid package name in rawNotification.package'
        });
        return;
      }
    }

    if (rawPkg && typeof rawPkg === 'string' && rawPkg.trim()) {
      const notificationPackage = rawPkg.trim().toLowerCase();
      if (!isAllowedNotificationPackage(notificationPackage)) {
        HttpServer.json(res, 400, {
          accepted: false,
          error: `Untrusted Android notification package: ${notificationPackage}`
        });
        return;
      }
    }

    // Check for raw SMS text inside body or rawNotification
    const rawText = body.body || body.sms || body.rawSms || body.message || body.text || body.rawNotification?.text;
    if (!rawText || (typeof rawText === 'string' && !rawText.trim())) {
      HttpServer.json(res, 400, {
        accepted: false,
        status: 'REJECTED',
        reason: 'MISSING_RAW_TEXT',
        error: 'Observation rawText is required for verification.'
      });
      return;
    }

    if (rawText && (!amountPaise || !bankRef)) {
      const parsedSms = BankSmsParser.parse({
        text: rawText,
        sender: body.sender || body.rawNotification?.package,
        timestamp: observedAt
      });

      if (parsedSms) {
        if (!amountPaise) amountPaise = parsedSms.amountPaise;
        if (!bankRef && parsedSms.bankReferenceNumber) bankRef = parsedSms.bankReferenceNumber;
        if (!senderVpa && parsedSms.senderVpa) senderVpa = parsedSms.senderVpa;
      }
    }

    if (!amountPaise && body.amount) {
      try {
        amountPaise = toPaise(body.amount);
      } catch {}
    }

    // Evaluate through Security & Fraud Verification Pipeline for Android Ingest
    if (!ctx.pipeline) {
      HttpServer.json(res, 500, { error: 'Verification pipeline is not configured on this server.' });
      return;
    }

    const pipeResult = ctx.pipeline.process({
      source: 'SMS',
      rawText,
      sender: body.sender || req.headers['x-sender'] || body.rawNotification?.package,
      receivingAccountId,
      paymentSessionId: body.paymentSessionId,
      bankReferenceNumber: bankRef,
      isTest: false, // device-supplied flags must never relax verification
      deviceInfo: device ? `${device.device_name} (${device.device_model})` : 'Android SMS Gateway'
    });
    // Personal and promotional SMS (no amount, unresolved) are routine and not worth a record.
    if (amountPaise || pipeResult.status !== 'UNRESOLVED') {
      recordObservationNotSettled(ctx, {
        channel: 'ANDROID', source: 'SMS', sender: body.sender || req.headers['x-sender'] || body.rawNotification?.package, receivingAccountId, rawText, pipeResult
      });
    }

    if (pipeResult.status === 'REJECTED' && pipeResult.failingCondition === 'FRAUDULENT_PAYMENT_INJECTION') {
      HttpServer.json(res, 403, {
        accepted: false,
        status: 'REJECTED',
        reason: 'FRAUDULENT_PAYMENT_INJECTION',
        threatDetected: true,
        banned: true,
        error: 'FRAUDULENT_PAYMENT_INJECTION: Fake SMS detected. Associated customer identity banned and session terminated.'
      });
      return;
    }

    if (pipeResult.status === 'VERIFIED') {
      ctx.db.execute("UPDATE android_devices SET last_observation_at = datetime('now') WHERE id = ?", [deviceId]);
      HttpServer.json(res, 200, {
        accepted: true,
        observationId: pipeResult.messageId || pipeResult.stages?.stage6?.details?.observationId,
        attribution: pipeResult.stages?.stage6?.details || pipeResult,
        pipeline: redactPipeline(pipeResult)
      });
      return;
    }

    if (pipeResult.status === 'REJECTED') {
      ctx.db.execute("UPDATE android_devices SET last_observation_at = datetime('now') WHERE id = ?", [deviceId]);
      HttpServer.json(res, 400, {
        accepted: false,
        status: 'REJECTED',
        reason: pipeResult.failingCondition,
        error: pipeResult.failingReason || pipeResult.details,
        pipeline: redactPipeline(pipeResult)
      });
      return;
    }

    // Transport Only Contract (Part D): The Android observer forwards all raw SMS.
    // If no monetary amount is extracted (e.g. personal, promotional, non-bank SMS),
    // update observation timestamp on device and return 200 PROCESSED_NON_BANK.
    if (!amountPaise && pipeResult.status === 'UNRESOLVED') {
      ctx.db.execute("UPDATE android_devices SET last_observation_at = datetime('now') WHERE id = ?", [deviceId]);
      HttpServer.json(res, 200, {
        accepted: true,
        status: 'PROCESSED_NON_BANK',
        bankMatch: false,
        message: 'Raw SMS observation ingested and evaluated by server pipeline.'
      });
      return;
    }

    // Invert check: if status is not VERIFIED, return 4xx and NEVER fall through to direct attribution
    ctx.db.execute("UPDATE android_devices SET last_observation_at = datetime('now') WHERE id = ?", [deviceId]);
    HttpServer.json(res, 400, {
      accepted: false,
      status: pipeResult.status || 'UNRESOLVED',
      reason: pipeResult.stages?.stage6?.outcomeStatus || pipeResult.failingCondition || 'UNRESOLVED_OBSERVATION',
      observationId: pipeResult.messageId || pipeResult.stages?.stage6?.details?.observationId,
      error: pipeResult.failingReason || 'Payment observation could not be verified or attributed.',
      pipeline: redactPipeline(pipeResult)
    });
  };

  // The notification-listener route must declare its package; the SMS-broadcast route has none.
  server.post('/api/v1/pollers/android/events', (req, res) => handleAndroidSmsEvents(req, res, { requirePackage: true }));
  server.post('/api/v1/observers/sms', (req, res) => handleAndroidSmsEvents(req, res, { requirePackage: false }));

  // --- ANDROID HEARTBEAT HANDLER ---
  // Signed like an observation. Unsigned, anyone on the network could keep any paired device
  // looking "online" in Merchant Admin after the phone itself had gone silent.
  const handleAndroidHeartbeat = async (req, res) => {
    const auth = await authenticateAndroidDevice(req, res);
    if (!auth) return;

    ctx.db.execute('UPDATE android_devices SET last_heartbeat_at = datetime(\'now\') WHERE id = ?', [auth.deviceId]);
    const telemetry = sanitizeAndroidTelemetry(auth.body);
    if (telemetry) deviceTelemetry.set(auth.deviceId, { ...telemetry, reportedAt: new Date().toISOString() });

    HttpServer.json(res, 200, {
      status: 'HEARTBEAT_ACK',
      timestamp: Date.now()
    });
  };

  server.post('/api/v1/pollers/android/heartbeat', handleAndroidHeartbeat);
  server.post('/api/v1/pollers/heartbeat', handleAndroidHeartbeat);
  server.post('/api/v1/observers/heartbeat', handleAndroidHeartbeat);

  // --- MERCHANT ADMIN: SMS GATEWAY PAIRING QR CODE & STATUS ---
  server.get('/api/v1/admin/sms-gateway/pair-qr', async (req, res) => {
    let merchant = req.query.merchantId ? (ctx.merchantRepo ? ctx.merchantRepo.findById(req.query.merchantId) : null) : null;
    if (!merchant && ctx.merchantRepo) merchant = ctx.merchantRepo.getDefault ? ctx.merchantRepo.getDefault() : (ctx.merchantRepo.findById('00000000-0000-0000-0000-000000000001') || ctx.merchantRepo.findAll()[0]);
    const merchantId = merchant ? merchant.id : (req.query.merchantId || '00000000-0000-0000-0000-000000000001');

    // Canonical runtime URL derivation (Part C2)
    const runtime = resolveRuntimeUrls(merchant?.branding || {});
    const gateway = resolveAndroidGatewayUrl(runtime.apiUrl);
    const baseUrl = gateway.url;
    const sessionId = crypto.randomUUID();
    const expiresAt = Date.now() + PAIRING_TOKEN_TTL_MS;
    const token = mintPairingToken(merchantId, expiresAt);

    const pairingPayloadObj = {
      version: 'v1',
      type: 'YOUPI_SMS_GATEWAY_PAIR',
      serverUrl: baseUrl,
      gatewayUrl: baseUrl,
      apiBaseUrl: baseUrl,
      sessionId,
      token,
      enrollmentToken: token,
      merchantId,
      createdAt: Date.now(),
      expiresAt
    };

    // The observer app only speaks HTTPS to anything but the emulator/loopback, and the phone's
    // own "localhost" is the phone. Say so here instead of letting pairing fail on the device.
    const phoneReach = assessPhoneReachability(baseUrl, {
      allowLanHttp: gateway.overridden,
      bindHost: process.env.YOUPI_BIND_HOST || '127.0.0.1'
    });

    const pairingPayload = JSON.stringify(pairingPayloadObj);
    const qrSvg = generateQrSvg(pairingPayload, 260);

    const rawDevices = ctx.db.query(`
      SELECT id, device_name, device_model, is_active, last_heartbeat_at, last_observation_at, created_at
      FROM android_devices
      WHERE merchant_id = ? OR merchant_id = '00000000-0000-0000-0000-000000000001'
      ORDER BY created_at DESC
    `, [merchantId]);

    const devices = (rawDevices || []).map(d => ({
      id: d.id,
      deviceId: d.id,
      deviceName: d.device_name || d.device_model || 'Android Observer',
      device_name: d.device_name || d.device_model || 'Android Observer',
      deviceModel: d.device_model,
      device_model: d.device_model,
      isActive: Boolean(d.is_active),
      is_active: d.is_active,
      lastHeartbeatAt: d.last_heartbeat_at,
      last_heartbeat_at: d.last_heartbeat_at,
      lastObservationAt: d.last_observation_at,
      last_observation_at: d.last_observation_at,
      createdAt: d.created_at,
      created_at: d.created_at,
      pairedAt: d.created_at,
      telemetry: deviceTelemetry.get(d.id) || null
    }));

    HttpServer.json(res, 200, {
      qrSvg,
      pairingQrSvg: qrSvg,
      pairingPayload,
      payload: pairingPayloadObj,
      sessionId,
      expiresAt,
      version: 'v1',
      token,
      enrollmentToken: token,
      gatewayUrl: baseUrl,
      serverUrl: baseUrl,
      phoneReachable: phoneReach.ok,
      phoneReachabilityWarning: phoneReach.warning,
      devices
    });
  });

  // GET /api/v1/admin/observations/diagnostics (admin only, via the /api/v1/admin/ guard)
  // The most recent observations that did not settle a payment, with stage and reason but
  // never the bank message text. Answers "did the alert arrive, and where did it stop?".
  server.get('/api/v1/admin/observations/diagnostics', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const rows = ctx.db.query(
      'SELECT id, entity_id, details, created_at FROM audit_logs WHERE action = ? ORDER BY created_at DESC LIMIT ?',
      [OBSERVATION_NOT_SETTLED, limit]
    );
    const lastObservation = ctx.db.queryOne('SELECT MAX(ingested_at) AS at FROM payment_observations');
    const devices = ctx.db.query('SELECT id, is_active, last_heartbeat_at, last_observation_at FROM android_devices ORDER BY created_at DESC');
    HttpServer.json(res, 200, {
      lastStoredObservationAt: lastObservation?.at || null,
      // telemetry: the phone's own delivery counters from its last signed heartbeat since this API
      // started (null until one arrives); lastObservationAt: the last SMS this server processed.
      androidDevices: devices.map(d => ({
        id: d.id, isActive: Boolean(d.is_active), lastHeartbeatAt: d.last_heartbeat_at, lastObservationAt: d.last_observation_at,
        telemetry: deviceTelemetry.get(d.id) || null
      })),
      notSettled: rows.map(r => {
        let details = {};
        try { details = JSON.parse(r.details || '{}'); } catch {}
        return { id: r.id, observationId: r.entity_id, at: r.created_at, ...details };
      })
    });
  });

  // GET /api/v1/admin/sms-gateway/devices
  server.get('/api/v1/admin/sms-gateway/devices', async (req, res) => {
    let merchant = req.query.merchantId ? (ctx.merchantRepo ? ctx.merchantRepo.findById(req.query.merchantId) : null) : null;
    if (!merchant && ctx.merchantRepo) merchant = ctx.merchantRepo.getDefault ? ctx.merchantRepo.getDefault() : (ctx.merchantRepo.findById('00000000-0000-0000-0000-000000000001') || ctx.merchantRepo.findAll()[0]);
    const merchantId = merchant ? merchant.id : (req.query.merchantId || '00000000-0000-0000-0000-000000000001');

    const rawDevices = ctx.db.query(`
      SELECT id, device_name, device_model, is_active, last_heartbeat_at, last_observation_at, created_at
      FROM android_devices
      WHERE merchant_id = ? OR merchant_id = '00000000-0000-0000-0000-000000000001'
      ORDER BY created_at DESC
    `, [merchantId]);

    const devices = (rawDevices || []).map(d => ({
      id: d.id,
      deviceId: d.id,
      deviceName: d.device_name || d.device_model || 'Android Observer',
      device_name: d.device_name || d.device_model || 'Android Observer',
      deviceModel: d.device_model,
      device_model: d.device_model,
      isActive: Boolean(d.is_active),
      is_active: d.is_active,
      lastHeartbeatAt: d.last_heartbeat_at,
      last_heartbeat_at: d.last_heartbeat_at,
      lastObservationAt: d.last_observation_at,
      last_observation_at: d.last_observation_at,
      createdAt: d.created_at,
      created_at: d.created_at,
      pairedAt: d.created_at,
      telemetry: deviceTelemetry.get(d.id) || null
    }));

    HttpServer.json(res, 200, { devices });
  });

  // DELETE /api/v1/admin/sms-gateway/devices/:deviceId
  server.delete('/api/v1/admin/sms-gateway/devices/:deviceId', async (req, res, params) => {
    const deviceId = params.deviceId;
    ctx.db.execute('DELETE FROM android_devices WHERE id = ?', [deviceId]);
    HttpServer.json(res, 200, { success: true, message: 'Device unlinked.' });
  });

  // GET /api/v1/admin/sms-gateway/download-apk & GET /youpi-sms-gateway.apk
  const serveApk = async (req, res) => {
    const apkLocations = [
      path.resolve(__dirname, '../../public/youpi-sms-gateway.apk'),
      path.resolve(__dirname, '../../../merchant-admin/public/youpi-sms-gateway.apk'),
      path.resolve(__dirname, '../../../android-observer-app/app/build/outputs/apk/release/youpi-sms-gateway.apk'),
      path.resolve(__dirname, '../../../android-observer-app/youpi-sms-gateway.apk')
    ];

    let foundPath = null;
    for (const p of apkLocations) {
      if (fs.existsSync(p)) {
        foundPath = p;
        break;
      }
    }

    if (!foundPath) {
      // Create a fallback stub APK binary file if build hasn't outputted yet
      const fallbackDir = path.resolve(__dirname, '../../public');
      if (!fs.existsSync(fallbackDir)) fs.mkdirSync(fallbackDir, { recursive: true });
      foundPath = path.join(fallbackDir, 'youpi-sms-gateway.apk');
      if (!fs.existsSync(foundPath)) {
        fs.writeFileSync(foundPath, Buffer.from('PK\x03\x04YOUPI_SMS_GATEWAY_STANDALONE_APK_PACKAGE'));
      }
    }

    const stat = fs.statSync(foundPath);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': 'attachment; filename="youpi-sms-gateway.apk"',
      'Content-Length': stat.size,
      'Access-Control-Allow-Origin': '*'
    });
    fs.createReadStream(foundPath).pipe(res);
  };

  server.get('/api/v1/admin/sms-gateway/download-apk', serveApk);
  server.get('/youpi-sms-gateway.apk', serveApk);
}
