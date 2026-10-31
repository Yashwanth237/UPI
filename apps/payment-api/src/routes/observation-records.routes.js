import { HttpServer } from '../server.js';
import { toRupeesString } from '@youpi/common';

/**
 * Processed bank alerts for the merchant dashboard (Incoming Bank Credit Alerts, Simulation
 * History, Processing Result Inspector, Customer & Session Inspector). Admin only, via the
 * /api/v1/admin/ guard, and scoped to one merchant. Never the message text of a real alert.
 * @param {import('../server.js').HttpServer} server
 * @param {any} ctx
 */
export function registerObservationRecordRoutes(server, ctx) {
  /** The merchant a request is for: x-merchant-id / ?merchantId, else the default merchant. */
  const merchantFor = req => {
    const id = req.headers['x-merchant-id'] || req.query?.merchantId || null;
    if (id) return ctx.merchantRepo.findById(id);
    return ctx.merchantRepo.getDefault
      ? ctx.merchantRepo.getDefault()
      : (ctx.merchantRepo.findById('00000000-0000-0000-0000-000000000001') || ctx.merchantRepo.findAll()[0]);
  };

  const deviceNames = () => new Map((ctx.db.query('SELECT id, device_name, device_model FROM android_devices') || [])
    .map(d => [d.id, d.device_name || d.device_model || null]));

  // GET /api/v1/admin/observations?limit=&source=&outcome=&entryPoint=&simulated=
  server.get('/api/v1/admin/observations', async (req, res) => {
    const merchant = merchantFor(req);
    if (!merchant) {
      HttpServer.json(res, 404, { error: 'Merchant not found.' });
      return;
    }
    const q = req.query || {};
    const simulated = q.simulated === 'true' ? true : (q.simulated === 'false' ? false : undefined);
    const names = deviceNames();
    const observations = ctx.observationRecordRepo.listForMerchant(merchant.id, {
      limit: q.limit,
      source: q.source ? String(q.source).toUpperCase() : undefined,
      outcome: q.outcome ? String(q.outcome).toUpperCase() : undefined,
      entryPoint: q.entryPoint ? String(q.entryPoint).toUpperCase() : undefined,
      simulated
    }).map(r => ({ ...r, deviceName: r.deviceId ? names.get(r.deviceId) || null : null }));
    HttpServer.json(res, 200, { merchantId: merchant.id, observations });
  });

  // GET /api/v1/admin/observations/:id — one record with its stage results and checkout.
  server.get('/api/v1/admin/observations/:id', async (req, res, params) => {
    const merchant = merchantFor(req);
    const record = merchant ? ctx.observationRecordRepo.findById(params.id) : null;
    // Another merchant's record is reported as missing, not as forbidden.
    if (!record || record.merchantId !== merchant.id) {
      HttpServer.json(res, 404, { error: 'Observation not found.' });
      return;
    }

    const sessionId = record.sessionId || record.targetSessionId;
    const session = sessionId ? ctx.sessionRepo.findById(sessionId) : null;
    const customerId = record.customerId || null;
    const customer = customerId && ctx.customerRepo ? ctx.customerRepo.findById(customerId) : null;

    // Evidence: a real alert's text stays protected in payment_observations and is not returned.
    // An operator-typed simulator message is returned, as the simulator showed it when sent.
    const evidenceRow = record.paymentObservationId
      ? ctx.db.queryOne('SELECT id, ingested_at FROM payment_observations WHERE id = ?', [record.paymentObservationId])
      : null;
    let simulatedText = null;
    if (record.isSimulated) {
      const audit = ctx.db.queryOne(
        "SELECT details FROM audit_logs WHERE entity_type = 'PAYMENT_SIMULATION' AND entity_id = ? ORDER BY created_at ASC LIMIT 1",
        [record.observationId]
      );
      try { simulatedText = audit ? JSON.parse(audit.details).exactRawMessage ?? null : null; } catch {}
    }

    HttpServer.json(res, 200, {
      observation: {
        ...record,
        deviceName: record.deviceId ? deviceNames().get(record.deviceId) || null : null
      },
      session: session ? {
        id: session.id,
        orderId: session.orderId,
        status: session.status,
        amount: toRupeesString(session.amountPaise),
        amountPaise: session.amountPaise?.toString(),
        settledByThisObservation: record.sessionId === session.id
      } : null,
      customer: customer ? { id: customer.id, name: customer.name } : null,
      evidence: {
        paymentObservationId: evidenceRow?.id || null,
        preserved: Boolean(evidenceRow),
        storedAt: evidenceRow?.ingested_at || null,
        simulatedText
      }
    });
  });
}
