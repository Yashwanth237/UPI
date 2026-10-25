import fs from 'node:fs';
import path from 'node:path';
import { HttpServer } from '../server.js';
import { Permission, PaymentStatus, StaffRole, TicketStatus, SenderType, getAdminToken, toRupeesString } from '@youpi/common';
import { SCHEMA_MIGRATIONS } from '@youpi/db';
import { clientIp, requireStaff, resolveMerchantScope } from '../staff-auth.js';

/**
 * Operations console API (/api/v1/console/*).
 *
 * Every figure is computed from the database at request time; nothing is estimated unless the
 * response says so. Every query is constrained to the caller's merchant scope, and sensitive
 * evidence (raw bank messages, full UTRs, VPAs, phone numbers) is redacted.
 */

const RANGES = Object.freeze({
  '24h': { ms: 24 * 3600 * 1000, bucket: 'hour' },
  '7d': { ms: 7 * 24 * 3600 * 1000, bucket: 'day' },
  '30d': { ms: 30 * 24 * 3600 * 1000, bucket: 'day' },
  '90d': { ms: 90 * 24 * 3600 * 1000, bucket: 'day' }
});
const STATUSES = Object.values(PaymentStatus);
const METHODS = ['UPI', 'COD', 'CASH_COUNTER', 'CARD_COUNTER'];
const MAX_PAGE_SIZE = 100;
const MAX_EXPORT_ROWS = 10000;

export function maskTail(value, visible = 4) {
  const s = String(value || '');
  if (!s) return null;
  return s.length <= visible ? '•'.repeat(s.length) : `${'•'.repeat(Math.min(6, s.length - visible))}${s.slice(-visible)}`;
}

export function maskVpa(vpa) {
  const s = String(vpa || '');
  const at = s.indexOf('@');
  if (at <= 0) return s ? maskTail(s, 2) : null;
  return `${s.slice(0, Math.min(2, at))}•••@${s.slice(at + 1)}`;
}

/** Neutralises spreadsheet formula injection in exported cells (OWASP CSV injection). */
export function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function isoOrNull(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * @param {HttpServer} server
 * @param {any} ctx
 */
export function registerConsoleRoutes(server, ctx) {
  const db = ctx.db;
  const defaultMerchantId = () => ctx.defaultMerchant?.id || '00000000-0000-0000-0000-000000000001';

  /** Authenticates + scopes. Returns { principal, merchantId } or null (response already sent). */
  function guard(req, res, permission) {
    const principal = requireStaff(req, res, ctx, permission);
    if (!principal) return null;
    const scope = resolveMerchantScope(principal, req.query?.merchantId || null, defaultMerchantId());
    if (scope.error) {
      HttpServer.json(res, scope.error, { error: scope.message, code: 'FORBIDDEN' });
      return null;
    }
    if (!ctx.merchantRepo.findById(scope.merchantId)) {
      HttpServer.json(res, 404, { error: 'Merchant not found.', code: 'NOT_FOUND' });
      return null;
    }
    return { principal, merchantId: scope.merchantId };
  }

  function audit(g, action, entityType, entityId, details, req) {
    ctx.auditRepo?.log({
      merchantId: g.merchantId,
      entityType,
      entityId,
      action,
      actorType: g.principal.kind === 'system' ? 'SYSTEM' : 'STAFF',
      actorId: g.principal.id,
      details,
      ipAddress: clientIp(req)
    });
  }

  /** Builds WHERE clause + params for payment filters from the query string. */
  function paymentFilters(q, merchantId) {
    const where = ['ps.merchant_id = ?'];
    const params = [merchantId];
    if (q.status && STATUSES.includes(q.status)) { where.push('ps.status = ?'); params.push(q.status); }
    if (q.method && METHODS.includes(q.method)) { where.push('ps.method = ?'); params.push(q.method); }
    const from = parseDate(q.from);
    const to = parseDate(q.to);
    if (from) { where.push('ps.created_at >= ?'); params.push(from.toISOString()); }
    if (to) { where.push('ps.created_at < ?'); params.push(to.toISOString()); }
    const term = String(q.q || '').trim().slice(0, 80);
    if (term) {
      // Order id (prefix), payment id (prefix) or exact bank reference (UTR) of attributed evidence.
      where.push(`(ps.order_id LIKE ? ESCAPE '\\' OR ps.id LIKE ? ESCAPE '\\' OR EXISTS (
        SELECT 1 FROM payment_observations po WHERE po.attributed_payment_id = ps.id AND po.bank_reference_number = ?))`);
      const like = `${term.replace(/[\\%_]/g, m => `\\${m}`)}%`;
      params.push(like, like, term);
    }
    return { sql: where.join(' AND '), params };
  }

  function mapPaymentRow(r) {
    return {
      id: r.id,
      orderId: r.order_id,
      status: r.status,
      method: r.method,
      amountPaise: String(r.amount_paise),
      amount: toRupeesString(BigInt(r.amount_paise)),
      currency: r.currency,
      verificationTag: r.verification_tag || 'UNVERIFIED',
      verificationLevel: Number(r.verification_level || 0),
      queuePosition: Number(r.queue_position || 0),
      customer: r.customer_name || r.customer_mobile ? { name: r.customer_name || null, mobile: maskTail(r.customer_mobile) } : null,
      createdAt: isoOrNull(r.created_at),
      completedAt: isoOrNull(r.completed_at),
      expiresAt: isoOrNull(r.expires_at)
    };
  }

  const PAYMENT_SELECT = `
    SELECT ps.*, c.name AS customer_name, c.mobile_number AS customer_mobile
    FROM payment_sessions ps
    LEFT JOIN customers c ON c.id = ps.customer_id`;

  // -------------------------------------------------------------------------------------
  // GET /api/v1/console/overview?range=24h|7d|30d|90d
  // -------------------------------------------------------------------------------------
  server.get('/api/v1/console/overview', async (req, res) => {
    const g = guard(req, res, Permission.DASHBOARD_VIEW);
    if (!g) return;
    const rangeKey = RANGES[req.query.range] ? req.query.range : '7d';
    const range = RANGES[rangeKey];
    const now = new Date();
    const since = new Date(now.getTime() - range.ms).toISOString();

    const byStatus = db.query(`
      SELECT status, method, COUNT(*) AS n, COALESCE(SUM(amount_paise), 0) AS paise
      FROM payment_sessions WHERE merchant_id = ? AND created_at >= ?
      GROUP BY status, method
    `, [g.merchantId, since]);

    const totals = { count: 0 };
    const statusCounts = Object.fromEntries(STATUSES.map(s => [s, 0]));
    let collectedPaise = 0n;
    let codPlacedPaise = 0n;
    let codPlacedCount = 0;
    const upiTerminal = { SUCCESS: 0, FAILED: 0, EXPIRED: 0, CANCELLED: 0 };
    const methodSplit = {};
    for (const r of byStatus) {
      const n = Number(r.n);
      totals.count += n;
      statusCounts[r.status] = (statusCounts[r.status] || 0) + n;
      methodSplit[r.method] = (methodSplit[r.method] || 0) + n;
      if (r.status === PaymentStatus.SUCCESS) {
        if (r.method === 'COD') { codPlacedPaise += BigInt(r.paise); codPlacedCount += n; }
        else collectedPaise += BigInt(r.paise);
      }
      if (r.method === 'UPI' && r.status in upiTerminal) upiTerminal[r.status] += n;
    }
    const upiTerminalTotal = Object.values(upiTerminal).reduce((a, b) => a + b, 0);

    const bucketExpr = range.bucket === 'hour' ? 'substr(created_at, 1, 13)' : 'substr(created_at, 1, 10)';
    const seriesRows = db.query(`
      SELECT ${bucketExpr} AS bucket,
             COUNT(*) AS total,
             SUM(CASE WHEN status = 'SUCCESS' AND method != 'COD' THEN 1 ELSE 0 END) AS succeeded,
             SUM(CASE WHEN status = 'SUCCESS' AND method != 'COD' THEN amount_paise ELSE 0 END) AS collected_paise
      FROM payment_sessions WHERE merchant_id = ? AND created_at >= ?
      GROUP BY bucket ORDER BY bucket
    `, [g.merchantId, since]);
    const seriesMap = new Map(seriesRows.map(r => [r.bucket, r]));
    const series = [];
    const stepMs = range.bucket === 'hour' ? 3600 * 1000 : 24 * 3600 * 1000;
    const start = new Date(now.getTime() - range.ms + stepMs);
    for (let t = start.getTime(); t <= now.getTime(); t += stepMs) {
      const key = new Date(t).toISOString().slice(0, range.bucket === 'hour' ? 13 : 10);
      const r = seriesMap.get(key);
      series.push({ bucket: key, total: Number(r?.total || 0), succeeded: Number(r?.succeeded || 0), collectedPaise: String(r?.collected_paise || 0) });
    }

    const verifyTimes = db.queryOne(`
      SELECT COUNT(*) AS n, AVG((julianday(completed_at) - julianday(slot_acquired_at)) * 86400.0) AS avg_s
      FROM payment_sessions
      WHERE merchant_id = ? AND created_at >= ? AND status = 'SUCCESS' AND method = 'UPI'
        AND completed_at IS NOT NULL AND slot_acquired_at IS NOT NULL
    `, [g.merchantId, since]);

    const evidence = db.query(`
      SELECT verification_tag AS tag, COUNT(*) AS n FROM payment_sessions
      WHERE merchant_id = ? AND created_at >= ? AND status = 'SUCCESS' AND method = 'UPI'
      GROUP BY verification_tag ORDER BY n DESC
    `, [g.merchantId, since]);

    const live = db.queryOne(`
      SELECT SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active,
             SUM(CASE WHEN status = 'PROCESSING' THEN 1 ELSE 0 END) AS processing,
             SUM(CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END) AS queued
      FROM payment_sessions WHERE merchant_id = ? AND status IN ('ACTIVE', 'PROCESSING', 'QUEUED')
    `, [g.merchantId]);

    const webhooks = db.queryOne(`
      SELECT SUM(CASE WHEN is_successful = 0 AND next_retry_at IS NULL THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN is_successful = 0 AND next_retry_at IS NOT NULL THEN 1 ELSE 0 END) AS retrying,
             SUM(CASE WHEN is_successful = 1 THEN 1 ELSE 0 END) AS delivered
      FROM webhook_deliveries WHERE merchant_id = ? AND created_at >= ?
    `, [g.merchantId, since]);

    const lateEvidence = db.queryOne(`
      SELECT COUNT(*) AS n FROM payment_observations po
      JOIN payment_receiving_accounts pra ON pra.id = po.receiving_account_id
      WHERE pra.merchant_id = ? AND po.ingested_at >= ? AND po.attribution_status IN ('UNATTRIBUTED', 'LATE_UNMATCHED')
    `, [g.merchantId, since]);

    HttpServer.json(res, 200, {
      merchantId: g.merchantId,
      range: rangeKey,
      since,
      generatedAt: now.toISOString(),
      totals: {
        payments: totals.count,
        collectedPaise: collectedPaise.toString(),
        collected: toRupeesString(collectedPaise),
        codPlacedCount,
        codPlacedPaise: codPlacedPaise.toString()
      },
      statusCounts,
      methodSplit,
      upiSuccessRate: upiTerminalTotal > 0
        ? { value: upiTerminal.SUCCESS / upiTerminalTotal, numerator: upiTerminal.SUCCESS, denominator: upiTerminalTotal, definition: 'UPI sessions that ended SUCCESS ÷ UPI sessions that ended SUCCESS, FAILED, EXPIRED or CANCELLED' }
        : null,
      averageVerificationSeconds: Number(verifyTimes?.n || 0) > 0 ? Math.round(Number(verifyTimes.avg_s)) : null,
      verificationEvidence: evidence.map(e => ({ tag: e.tag || 'UNVERIFIED', count: Number(e.n) })),
      live: { active: Number(live?.active || 0), processing: Number(live?.processing || 0), queued: Number(live?.queued || 0) },
      webhooks: { failed: Number(webhooks?.failed || 0), retrying: Number(webhooks?.retrying || 0), delivered: Number(webhooks?.delivered || 0) },
      unmatchedEvidence: Number(lateEvidence?.n || 0),
      series
    });
  });

  // -------------------------------------------------------------------------------------
  // Payments
  // -------------------------------------------------------------------------------------
  server.get('/api/v1/console/payments', async (req, res) => {
    const g = guard(req, res, Permission.PAYMENTS_VIEW);
    if (!g) return;
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.pageSize || '25', 10) || 25));
    const f = paymentFilters(req.query, g.merchantId);
    const total = Number(db.queryOne(`SELECT COUNT(*) AS n FROM payment_sessions ps WHERE ${f.sql}`, f.params)?.n || 0);
    const rows = db.query(`${PAYMENT_SELECT} WHERE ${f.sql} ORDER BY ps.created_at DESC LIMIT ? OFFSET ?`, [...f.params, pageSize, (page - 1) * pageSize]);
    HttpServer.json(res, 200, { page, pageSize, total, payments: rows.map(mapPaymentRow) });
  });

  server.get('/api/v1/console/payments/export.csv', async (req, res) => {
    const g = guard(req, res, Permission.PAYMENTS_EXPORT);
    if (!g) return;
    const f = paymentFilters(req.query, g.merchantId);
    const rows = db.query(`${PAYMENT_SELECT} WHERE ${f.sql} ORDER BY ps.created_at DESC LIMIT ?`, [...f.params, MAX_EXPORT_ROWS + 1]);
    const truncated = rows.length > MAX_EXPORT_ROWS;
    const header = ['payment_id', 'order_id', 'created_at', 'completed_at', 'status', 'method', 'amount_inr', 'amount_paise', 'verification', 'customer_name', 'customer_mobile_masked'];
    const lines = [header.join(',')];
    for (const r of rows.slice(0, MAX_EXPORT_ROWS)) {
      const p = mapPaymentRow(r);
      lines.push([p.id, p.orderId, p.createdAt, p.completedAt, p.status, p.method, p.amount, p.amountPaise, p.verificationTag, p.customer?.name, p.customer?.mobile].map(csvCell).join(','));
    }
    audit(g, 'PAYMENTS_EXPORTED', 'MERCHANT', g.merchantId, { rows: Math.min(rows.length, MAX_EXPORT_ROWS), truncated, filters: { status: req.query.status || null, method: req.query.method || null, from: req.query.from || null, to: req.query.to || null, q: req.query.q ? 'set' : null } }, req);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="payments-${stamp}.csv"`,
      'Cache-Control': 'no-store',
      'X-Export-Truncated': truncated ? 'true' : 'false',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end('﻿' + lines.join('\r\n'));
  });

  server.get('/api/v1/console/payments/:id', async (req, res, params) => {
    const g = guard(req, res, Permission.PAYMENTS_VIEW);
    if (!g) return;
    const row = db.queryOne(`${PAYMENT_SELECT} WHERE ps.id = ? AND ps.merchant_id = ?`, [params.id, g.merchantId]);
    if (!row) {
      HttpServer.json(res, 404, { error: 'Payment not found.', code: 'NOT_FOUND' });
      return;
    }
    const payment = mapPaymentRow(row);
    const account = row.receiving_account_id ? db.queryOne('SELECT upi_id, payee_name FROM payment_receiving_accounts WHERE id = ?', [row.receiving_account_id]) : null;

    const observations = db.query(`
      SELECT id, source, amount_paise, observed_at, ingested_at, sender_vpa, bank_reference_number, attribution_status
      FROM payment_observations WHERE attributed_payment_id = ? ORDER BY ingested_at ASC
    `, [row.id]).map(o => ({
      id: o.id,
      source: o.source,
      amount: toRupeesString(BigInt(o.amount_paise)),
      amountMatches: String(o.amount_paise) === String(row.amount_paise),
      observedAt: isoOrNull(o.observed_at),
      ingestedAt: isoOrNull(o.ingested_at),
      payerVpa: maskVpa(o.sender_vpa),
      bankReference: maskTail(o.bank_reference_number),
      attributionStatus: o.attribution_status
    }));

    const webhooks = db.query(`
      SELECT id, event_type, endpoint_url, response_status, attempt_count, is_successful, next_retry_at, created_at
      FROM webhook_deliveries WHERE payment_id = ? AND merchant_id = ? ORDER BY created_at ASC
    `, [row.id, g.merchantId]).map(w => ({
      id: w.id,
      event: w.event_type,
      endpointHost: (() => { try { return new URL(w.endpoint_url).host; } catch { return null; } })(),
      responseStatus: w.response_status,
      attempts: Number(w.attempt_count),
      state: w.is_successful ? 'DELIVERED' : (w.next_retry_at ? 'RETRYING' : 'FAILED'),
      nextRetryAt: isoOrNull(w.next_retry_at),
      createdAt: isoOrNull(w.created_at)
    }));

    const timeline = (ctx.auditRepo?.findByEntity('PAYMENT_SESSION', row.id) || []).map(a => ({
      at: isoOrNull(a.createdAt), action: a.action, actorType: a.actorType
    }));

    let metadata = {};
    try { metadata = JSON.parse(row.metadata || '{}'); } catch {}

    HttpServer.json(res, 200, {
      payment: {
        ...payment,
        attemptId: row.attempt_id,
        receivingAccount: account ? { upiId: maskVpa(account.upi_id), payeeName: account.payee_name } : null,
        slotAcquiredAt: isoOrNull(row.slot_acquired_at),
        processingStartedAt: isoOrNull(row.processing_started_at),
        verificationSources: (() => { try { return JSON.parse(row.verification_sources || '[]'); } catch { return []; } })(),
        metadata
      },
      observations,
      webhooks,
      timeline,
      cancellable: [PaymentStatus.INITIATED, PaymentStatus.QUEUED, PaymentStatus.ACTIVE].includes(row.status)
    });
  });

  // POST /api/v1/console/payments/:id/cancel { reason }
  // Ends a live session that has not entered verification. It never marks anything paid.
  server.post('/api/v1/console/payments/:id/cancel', async (req, res, params) => {
    const g = guard(req, res, Permission.PAYMENTS_CANCEL);
    if (!g) return;
    const body = await HttpServer.parseBody(req).catch(() => ({}));
    const reason = String(body.reason || '').trim().slice(0, 300);
    if (reason.length < 3) {
      HttpServer.json(res, 400, { error: 'Enter a reason for cancelling.', code: 'VALIDATION_ERROR', field: 'reason' });
      return;
    }
    const session = ctx.sessionRepo.findById(params.id);
    if (!session || session.merchantId !== g.merchantId) {
      HttpServer.json(res, 404, { error: 'Payment not found.', code: 'NOT_FOUND' });
      return;
    }
    if (session.status === PaymentStatus.PROCESSING) {
      HttpServer.json(res, 409, { error: 'Bank verification is in progress for this payment. Wait for it to finish.', code: 'SESSION_PROCESSING' });
      return;
    }
    if (![PaymentStatus.INITIATED, PaymentStatus.QUEUED, PaymentStatus.ACTIVE].includes(session.status)) {
      HttpServer.json(res, 409, { error: `This payment already ended (${session.status}).`, code: 'ALREADY_TERMINAL' });
      return;
    }
    const updated = ctx.timingEngine.handleCancel(session.id, {
      actorType: g.principal.kind === 'system' ? 'SYSTEM' : 'STAFF',
      actorId: g.principal.id,
      reason
    });
    server.broadcastSse(session.id, 'status_change', { status: PaymentStatus.CANCELLED });
    audit(g, 'PAYMENT_CANCELLED_BY_STAFF', 'PAYMENT_SESSION', session.id, { reason, previousStatus: session.status }, req);
    HttpServer.json(res, 200, { paymentId: session.id, status: updated?.status || PaymentStatus.CANCELLED });
  });

  // -------------------------------------------------------------------------------------
  // Operations (cashier workspace)
  // -------------------------------------------------------------------------------------
  server.get('/api/v1/console/operations', async (req, res) => {
    const g = guard(req, res, Permission.OPERATIONS_VIEW);
    if (!g) return;
    const now = Date.now();
    const accounts = db.query('SELECT * FROM payment_receiving_accounts WHERE merchant_id = ? ORDER BY is_active DESC, created_at ASC', [g.merchantId]);
    const heartbeatTimeout = Number(process.env.ANDROID_HEARTBEAT_TIMEOUT_MS) || 180000;

    const accountViews = accounts.map(a => {
      const current = db.queryOne(`${PAYMENT_SELECT} WHERE ps.receiving_account_id = ? AND ps.status IN ('ACTIVE', 'PROCESSING') LIMIT 1`, [a.id]);
      const queued = db.query(`${PAYMENT_SELECT} WHERE ps.receiving_account_id = ? AND ps.status = 'QUEUED' ORDER BY ps.queue_position ASC, ps.created_at ASC LIMIT 50`, [a.id]);
      return {
        id: a.id,
        upiId: maskVpa(a.upi_id),
        payeeName: a.payee_name,
        isActive: Boolean(a.is_active),
        isMerchantEnabled: Boolean(a.is_merchant_enabled),
        current: current ? {
          ...mapPaymentRow(current),
          processingExpiresAt: isoOrNull(current.processing_expires_at),
          secondsRemaining: (() => {
            const until = current.status === 'PROCESSING' ? current.processing_expires_at : current.expires_at;
            return until ? Math.max(0, Math.round((new Date(until).getTime() - now) / 1000)) : null;
          })()
        } : null,
        queue: queued.map((q, i) => ({
          ...mapPaymentRow(q),
          position: i + 1,
          waitingSeconds: Math.max(0, Math.round((now - new Date(q.updated_at || q.created_at).getTime()) / 1000)),
          // Upper-bound estimate from the configured windows; labelled as an estimate in the UI.
          estimatedWaitSeconds: ctx.queueEngine?.calculateEstimatedWaitSeconds ? ctx.queueEngine.calculateEstimatedWaitSeconds(a.id, i + 1) : null
        }))
      };
    });

    const devices = db.query('SELECT id, device_name, device_model, is_active, last_heartbeat_at, last_observation_at, created_at FROM android_devices WHERE merchant_id = ? ORDER BY created_at DESC', [g.merchantId]).map(d => {
      const last = d.last_heartbeat_at ? new Date(d.last_heartbeat_at.includes('T') ? d.last_heartbeat_at : `${d.last_heartbeat_at.replace(' ', 'T')}Z`).getTime() : null;
      return {
        id: d.id,
        name: d.device_name,
        model: d.device_model,
        active: Boolean(d.is_active),
        lastHeartbeatAt: last ? new Date(last).toISOString() : null,
        lastObservationAt: isoOrNull(d.last_observation_at),
        connection: !d.is_active ? 'REVOKED' : (last && now - last <= heartbeatTimeout ? 'ONLINE' : 'OFFLINE')
      };
    });

    const exceptions = db.query(`
      SELECT po.id, po.source, po.amount_paise, po.observed_at, po.ingested_at, po.bank_reference_number, po.attribution_status, po.attributed_payment_id
      FROM payment_observations po JOIN payment_receiving_accounts pra ON pra.id = po.receiving_account_id
      WHERE pra.merchant_id = ? AND po.attribution_status IN ('UNATTRIBUTED', 'LATE_UNMATCHED') AND po.ingested_at >= ?
      ORDER BY po.ingested_at DESC LIMIT 50
    `, [g.merchantId, new Date(now - 7 * 24 * 3600 * 1000).toISOString()]).map(o => ({
      id: o.id,
      source: o.source,
      amount: toRupeesString(BigInt(o.amount_paise)),
      observedAt: isoOrNull(o.observed_at),
      ingestedAt: isoOrNull(o.ingested_at),
      bankReference: maskTail(o.bank_reference_number),
      status: o.attribution_status,
      relatedPaymentId: o.attributed_payment_id || null
    }));

    const pendingCounter = db.query(`${PAYMENT_SELECT} WHERE ps.merchant_id = ? AND ps.method IN ('CASH_COUNTER', 'CARD_COUNTER') AND ps.status NOT IN ('SUCCESS', 'FAILED', 'EXPIRED', 'CANCELLED') ORDER BY ps.created_at ASC LIMIT 50`, [g.merchantId]).map(mapPaymentRow);

    HttpServer.json(res, 200, { generatedAt: new Date(now).toISOString(), accounts: accountViews, devices, exceptions, pendingCounter });
  });

  // -------------------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------------------
  server.get('/api/v1/console/webhooks', async (req, res) => {
    const g = guard(req, res, Permission.WEBHOOKS_VIEW);
    if (!g) return;
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.pageSize || '25', 10) || 25));
    const where = ['wd.merchant_id = ?'];
    const params = [g.merchantId];
    if (req.query.state === 'failed') where.push('wd.is_successful = 0 AND wd.next_retry_at IS NULL');
    if (req.query.state === 'retrying') where.push('wd.is_successful = 0 AND wd.next_retry_at IS NOT NULL');
    if (req.query.state === 'delivered') where.push('wd.is_successful = 1');
    const total = Number(db.queryOne(`SELECT COUNT(*) AS n FROM webhook_deliveries wd WHERE ${where.join(' AND ')}`, params)?.n || 0);
    const rows = db.query(`
      SELECT wd.id, wd.payment_id, wd.event_type, wd.endpoint_url, wd.response_status, wd.response_body, wd.attempt_count, wd.is_successful, wd.next_retry_at, wd.created_at, ps.order_id
      FROM webhook_deliveries wd LEFT JOIN payment_sessions ps ON ps.id = wd.payment_id
      WHERE ${where.join(' AND ')} ORDER BY wd.created_at DESC LIMIT ? OFFSET ?
    `, [...params, pageSize, (page - 1) * pageSize]);
    const merchant = ctx.merchantRepo.findById(g.merchantId);
    HttpServer.json(res, 200, {
      page, pageSize, total,
      endpoint: merchant?.webhookUrl ? (() => { try { const u = new URL(merchant.webhookUrl); return `${u.protocol}//${u.host}${u.pathname}`; } catch { return null; } })() : null,
      maxAttempts: ctx.webhookEngine?.maxRetries || null,
      deliveries: rows.map(w => ({
        id: w.id,
        paymentId: w.payment_id,
        orderId: w.order_id,
        event: w.event_type,
        responseStatus: w.response_status,
        responseExcerpt: w.response_body ? String(w.response_body).slice(0, 160) : null,
        attempts: Number(w.attempt_count),
        state: w.is_successful ? 'DELIVERED' : (w.next_retry_at ? 'RETRYING' : 'FAILED'),
        nextRetryAt: isoOrNull(w.next_retry_at),
        createdAt: isoOrNull(w.created_at)
      }))
    });
  });

  // POST /api/v1/console/webhooks/:id/retry: re-sends the ORIGINAL signed payload (same delivery id).
  server.post('/api/v1/console/webhooks/:id/retry', async (req, res, params) => {
    const g = guard(req, res, Permission.WEBHOOKS_RETRY);
    if (!g) return;
    const delivery = db.queryOne('SELECT id, is_successful, attempt_count FROM webhook_deliveries WHERE id = ? AND merchant_id = ?', [params.id, g.merchantId]);
    if (!delivery) {
      HttpServer.json(res, 404, { error: 'Delivery not found.', code: 'NOT_FOUND' });
      return;
    }
    if (delivery.is_successful) {
      HttpServer.json(res, 409, { error: 'This delivery already succeeded.', code: 'ALREADY_DELIVERED' });
      return;
    }
    if (!ctx.webhookEngine) {
      HttpServer.json(res, 503, { error: 'Webhook engine unavailable.', code: 'UNAVAILABLE' });
      return;
    }
    const maxRetries = ctx.webhookEngine.maxRetries || 5;
    // One extra attempt for an exhausted delivery; never resets the count, so history stays truthful.
    db.execute('UPDATE webhook_deliveries SET next_retry_at = ?, attempt_count = MIN(attempt_count, ?) WHERE id = ? AND is_successful = 0', [new Date(Date.now() - 1000).toISOString(), maxRetries - 1, delivery.id]);
    audit(g, 'WEBHOOK_MANUAL_RETRY', 'WEBHOOK_DELIVERY', delivery.id, { previousAttempts: Number(delivery.attempt_count) }, req);
    await ctx.webhookEngine.retryPending();
    const after = db.queryOne('SELECT is_successful, response_status, attempt_count, next_retry_at FROM webhook_deliveries WHERE id = ?', [delivery.id]);
    HttpServer.json(res, 200, {
      id: delivery.id,
      state: after.is_successful ? 'DELIVERED' : (after.next_retry_at ? 'RETRYING' : 'FAILED'),
      responseStatus: after.response_status,
      attempts: Number(after.attempt_count)
    });
  });

  // -------------------------------------------------------------------------------------
  // Support tickets
  // -------------------------------------------------------------------------------------
  server.get('/api/v1/console/tickets', async (req, res) => {
    const g = guard(req, res, Permission.SUPPORT_VIEW);
    if (!g) return;
    const status = Object.values(TicketStatus).includes(req.query.status) ? req.query.status : null;
    const rows = db.query(`
      SELECT t.*, c.name AS customer_name, c.mobile_number AS customer_mobile, ps.order_id,
             (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count
      FROM support_tickets t
      LEFT JOIN customers c ON c.id = t.customer_id
      LEFT JOIN payment_sessions ps ON ps.id = t.payment_id
      WHERE t.merchant_id = ? ${status ? 'AND t.status = ?' : ''}
      ORDER BY t.updated_at DESC LIMIT 200
    `, status ? [g.merchantId, status] : [g.merchantId]);
    HttpServer.json(res, 200, {
      tickets: rows.map(t => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        paymentId: t.payment_id,
        orderId: t.order_id,
        customer: { name: t.customer_name, mobile: maskTail(t.customer_mobile) },
        messageCount: Number(t.message_count),
        createdAt: isoOrNull(t.created_at),
        updatedAt: isoOrNull(t.updated_at)
      }))
    });
  });

  function loadTicket(g, res, id) {
    const ticket = ctx.ticketRepo?.findTicketById(id);
    if (!ticket || ticket.merchantId !== g.merchantId) {
      HttpServer.json(res, 404, { error: 'Ticket not found.', code: 'NOT_FOUND' });
      return null;
    }
    return ticket;
  }

  server.get('/api/v1/console/tickets/:id', async (req, res, params) => {
    const g = guard(req, res, Permission.SUPPORT_VIEW);
    if (!g) return;
    const ticket = loadTicket(g, res, params.id);
    if (!ticket) return;
    const messages = ctx.ticketRepo.findMessagesByTicket(ticket.id).map(m => ({
      id: m.id, senderType: m.senderType, message: m.message, createdAt: isoOrNull(m.createdAt)
    }));
    HttpServer.json(res, 200, { ticket, messages });
  });

  server.post('/api/v1/console/tickets/:id/reply', async (req, res, params) => {
    const g = guard(req, res, Permission.SUPPORT_RESPOND);
    if (!g) return;
    const ticket = loadTicket(g, res, params.id);
    if (!ticket) return;
    const body = await HttpServer.parseBody(req).catch(() => ({}));
    const message = String(body.message || '').trim().slice(0, 4000);
    if (!message) {
      HttpServer.json(res, 400, { error: 'Write a reply first.', code: 'VALIDATION_ERROR' });
      return;
    }
    const saved = ctx.ticketRepo.addMessage({ ticketId: ticket.id, senderType: SenderType.ADMIN, senderId: g.principal.id, message });
    if (ticket.status === TicketStatus.OPEN) ctx.ticketRepo.updateTicketStatus(ticket.id, TicketStatus.IN_PROGRESS);
    audit(g, 'TICKET_REPLIED', 'SUPPORT_TICKET', ticket.id, { messageId: saved?.id }, req);
    HttpServer.json(res, 201, { message: saved });
  });

  server.post('/api/v1/console/tickets/:id/status', async (req, res, params) => {
    const g = guard(req, res, Permission.SUPPORT_RESPOND);
    if (!g) return;
    const ticket = loadTicket(g, res, params.id);
    if (!ticket) return;
    const body = await HttpServer.parseBody(req).catch(() => ({}));
    if (!Object.values(TicketStatus).includes(body.status)) {
      HttpServer.json(res, 400, { error: 'Unknown ticket status.', code: 'VALIDATION_ERROR' });
      return;
    }
    const updated = ctx.ticketRepo.updateTicketStatus(ticket.id, body.status);
    audit(g, 'TICKET_STATUS_CHANGED', 'SUPPORT_TICKET', ticket.id, { from: ticket.status, to: body.status }, req);
    HttpServer.json(res, 200, { ticket: updated });
  });

  // -------------------------------------------------------------------------------------
  // Audit log
  // -------------------------------------------------------------------------------------
  server.get('/api/v1/console/audit', async (req, res) => {
    const g = guard(req, res, Permission.AUDIT_VIEW);
    if (!g) return;
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.pageSize || '50', 10) || 50));
    const where = [];
    const params = [];
    // Platform administrators can include platform-level events (no merchant attached).
    if (g.principal.role === StaffRole.PLATFORM_ADMIN && req.query.scope === 'platform') {
      where.push('(merchant_id = ? OR merchant_id IS NULL)');
    } else {
      where.push('merchant_id = ?');
    }
    params.push(g.merchantId);
    if (req.query.action) { where.push('action = ?'); params.push(String(req.query.action).slice(0, 100)); }
    if (req.query.entityType) { where.push('entity_type = ?'); params.push(String(req.query.entityType).slice(0, 50)); }
    if (req.query.actorType) { where.push('actor_type = ?'); params.push(String(req.query.actorType).slice(0, 50)); }
    const total = Number(db.queryOne(`SELECT COUNT(*) AS n FROM audit_logs WHERE ${where.join(' AND ')}`, params)?.n || 0);
    const rows = db.query(`SELECT * FROM audit_logs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
    const actions = db.query(`SELECT DISTINCT action FROM audit_logs WHERE ${where[0]} ORDER BY action LIMIT 200`, [g.merchantId]).map(r => r.action);
    HttpServer.json(res, 200, {
      page, pageSize, total, actions,
      entries: rows.map(r => {
        let details = {};
        try { details = JSON.parse(r.details || '{}'); } catch {}
        return {
          id: r.id,
          at: isoOrNull(r.created_at),
          action: r.action,
          entityType: r.entity_type,
          entityId: r.entity_id,
          actorType: r.actor_type,
          actorId: r.actor_id,
          ipAddress: r.ip_address,
          details
        };
      })
    });
  });

  // -------------------------------------------------------------------------------------
  // Merchant settings (read-only summary; secrets never leave the server)
  // -------------------------------------------------------------------------------------
  server.get('/api/v1/console/settings', async (req, res) => {
    const g = guard(req, res, Permission.SETTINGS_VIEW);
    if (!g) return;
    const m = ctx.merchantRepo.findById(g.merchantId);
    const accounts = db.query('SELECT id, upi_id, payee_name, is_active, is_merchant_enabled FROM payment_receiving_accounts WHERE merchant_id = ?', [g.merchantId]);
    HttpServer.json(res, 200, {
      merchant: {
        id: m.id,
        businessName: m.businessName,
        slug: m.slug,
        contactEmail: m.contactEmail,
        webhookUrl: m.webhookUrl || null,
        webhookSecretConfigured: Boolean(m.webhookSecret),
        apiKeyConfigured: Boolean(m.apiKeyHash),
        branding: {
          appName: m.branding?.appName || null,
          primaryColor: m.branding?.primaryColor || null,
          logoUrl: m.branding?.logoUrl || null,
          supportEmail: m.branding?.supportEmail || null,
          supportPhone: m.branding?.supportPhone || null
        }
      },
      receivingAccounts: accounts.map(a => ({ id: a.id, upiId: maskVpa(a.upi_id), payeeName: a.payee_name, isActive: Boolean(a.is_active), isMerchantEnabled: Boolean(a.is_merchant_enabled) }))
    });
  });

  // -------------------------------------------------------------------------------------
  // Platform: merchants + system health (platform administrators only)
  // -------------------------------------------------------------------------------------
  server.get('/api/v1/console/merchants', async (req, res) => {
    const principal = requireStaff(req, res, ctx, Permission.MERCHANTS_MANAGE);
    if (!principal) return;
    const merchants = ctx.merchantRepo.findAll().map(m => {
      const stats = db.queryOne("SELECT COUNT(*) AS n, MAX(created_at) AS last_at FROM payment_sessions WHERE merchant_id = ?", [m.id]);
      return { id: m.id, businessName: m.businessName, slug: m.slug, contactEmail: m.contactEmail, payments: Number(stats?.n || 0), lastPaymentAt: isoOrNull(stats?.last_at), createdAt: isoOrNull(m.createdAt) };
    });
    HttpServer.json(res, 200, { merchants });
  });

  async function probe(url, timeoutMs = 1500) {
    const started = Date.now();
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      return { ok: r.ok, status: r.status, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, status: null, latencyMs: null, error: err.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
    }
  }

  server.get('/api/v1/console/system', async (req, res) => {
    const principal = requireStaff(req, res, ctx, Permission.SYSTEM_VIEW);
    if (!principal) return;

    const services = [
      { id: 'payment-api', name: 'Payment API', port: Number(process.env.PAYMENT_API_PORT || 6100), self: true },
      { id: 'checkout-portal', name: 'Checkout portal', port: Number(process.env.CHECKOUT_PORTAL_PORT || 7000) },
      { id: 'merchant-admin', name: 'Merchant console', port: Number(process.env.MERCHANT_ADMIN_PORT || 6001) },
      { id: 'sms-observer', name: 'SMS observer', port: Number(process.env.SMS_OBSERVER_PORT || 6002) },
      { id: 'gmail-observer', name: 'Gmail observer', port: Number(process.env.GMAIL_OBSERVER_PORT || 6003) },
      { id: 'payment-help', name: 'Help portal', port: Number(process.env.HELP_PORTAL_PORT || 3000) },
      { id: 'control-center', name: 'Process supervisor', port: Number(process.env.CONTROL_CENTER_PORT || 8090) }
    ];
    const probed = await Promise.all(services.map(async s => ({
      id: s.id, name: s.name, port: s.port,
      ...(s.self ? { ok: true, status: 200, latencyMs: 0 } : await probe(`http://127.0.0.1:${s.port}/health`))
    })));

    let supervisor = null;
    try {
      const r = await fetch(`http://127.0.0.1:${Number(process.env.CONTROL_CENTER_PORT || 8090)}/api/services`, {
        headers: { Authorization: `Bearer ${getAdminToken()}` }, signal: AbortSignal.timeout(1500)
      });
      if (r.ok) supervisor = await r.json();
    } catch {}

    // Database
    const tables = ['merchants', 'payment_sessions', 'payment_observations', 'webhook_deliveries', 'customers', 'support_tickets', 'audit_logs', 'security_events', 'staff_users', 'staff_sessions'];
    const rowCounts = Object.fromEntries(tables.map(t => [t, Number(db.queryOne(`SELECT COUNT(*) AS n FROM ${t}`)?.n || 0)]));
    const ledger = db.query('SELECT version, name, applied_at FROM schema_migrations ORDER BY version');
    const journal = db.queryOne('PRAGMA journal_mode')?.journal_mode || null;
    const pageCount = Number(db.queryOne('PRAGMA page_count')?.page_count || 0);
    const pageSize = Number(db.queryOne('PRAGMA page_size')?.page_size || 0);
    let integrity = null;
    try { integrity = db.queryOne('PRAGMA quick_check(1)')?.quick_check || null; } catch (err) { integrity = `error: ${err.message}`; }

    // Backups: report what exists on disk; never claim a backup that is not there.
    const backupDir = path.resolve(process.env.YOUPI_BACKUP_DIR || path.join(process.cwd(), 'data', 'backups'));
    let latestBackup = null;
    try {
      const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.sqlite')).map(f => ({ f, s: fs.statSync(path.join(backupDir, f)) }));
      files.sort((a, b) => b.s.mtimeMs - a.s.mtimeMs);
      if (files[0]) latestBackup = { file: files[0].f, sizeBytes: files[0].s.size, at: files[0].s.mtime.toISOString() };
    } catch {}

    const webhookBacklog = db.queryOne(`
      SELECT SUM(CASE WHEN is_successful = 0 AND next_retry_at IS NOT NULL THEN 1 ELSE 0 END) AS retrying,
             SUM(CASE WHEN is_successful = 0 AND next_retry_at IS NULL THEN 1 ELSE 0 END) AS failed
      FROM webhook_deliveries`);

    const warnings = [];
    if (process.env.NODE_ENV !== 'production') warnings.push({ level: 'info', message: `NODE_ENV is "${process.env.NODE_ENV || 'unset'}" (not production).` });
    if (process.env.YOUPI_EXPOSE_DEV_OTP === 'true') warnings.push({ level: process.env.NODE_ENV === 'production' ? 'info' : 'warning', message: 'YOUPI_EXPOSE_DEV_OTP is set (ignored in production).' });
    if (process.env.NODE_ENV === 'production' && process.env.YOUPI_ALLOW_DEV_TOOLS === 'true') warnings.push({ level: 'critical', message: 'Developer tools are enabled in production (YOUPI_ALLOW_DEV_TOOLS=true). They can inject synthetic bank messages.' });
    const otp = ctx.otpDispatcher?.describe ? ctx.otpDispatcher.describe() : null;
    if (otp && !otp.providers.some(p => p.configured && p.name !== 'dev-console')) warnings.push({ level: process.env.NODE_ENV === 'production' ? 'critical' : 'warning', message: 'No real OTP provider is configured; customers cannot sign in.' });
    if (otp && otp.providers.some(p => p.name === 'whatsapp-linked-device' && p.configured)) warnings.push({ level: 'warning', message: 'Customer OTPs use the unofficial linked-device WhatsApp session. Prefer the WhatsApp Cloud API.' });
    if (!latestBackup) warnings.push({ level: 'warning', message: 'No database backup found. Run npm run db:backup and schedule it.' });
    if (rowCounts.staff_users === 0) warnings.push({ level: 'warning', message: 'No staff accounts exist yet. Create one with npm run staff:create.' });

    HttpServer.json(res, 200, {
      generatedAt: new Date().toISOString(),
      runtime: { node: process.version, uptimeSeconds: Math.round(process.uptime()), rssBytes: process.memoryUsage().rss, mode: process.env.YOUPI_MODE || null, nodeEnv: process.env.NODE_ENV || null },
      services: probed,
      supervisor,
      database: {
        engine: 'sqlite (node:sqlite)',
        journalMode: journal,
        sizeBytes: pageCount * pageSize,
        integrity,
        schemaVersion: ledger.length ? Math.max(...ledger.map(l => Number(l.version))) : null,
        expectedSchemaVersion: Math.max(...SCHEMA_MIGRATIONS.map(([v]) => v)),
        migrations: ledger.map(l => ({ version: Number(l.version), name: l.name, appliedAt: isoOrNull(l.applied_at) })),
        rowCounts
      },
      backups: { directory: backupDir, latest: latestBackup },
      otp,
      webhookBacklog: { retrying: Number(webhookBacklog?.retrying || 0), failed: Number(webhookBacklog?.failed || 0) },
      warnings
    });
  });
}
