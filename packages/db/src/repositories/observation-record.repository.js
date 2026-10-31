/**
 * One row per bank alert the verification pipeline processed, keyed by the pipeline's
 * observation id (the same id the Android phone, the hub, the audit log and, when the alert was
 * attributed, payment_observations use). Holds outcomes and masked fields only, never message text.
 */
export class ObservationRecordRepository {
  /**
   * @param {import('../database.js').Database} db
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Inserts a record. An id that is already recorded is left as it was: a record describes the
   * first processing of that observation and is never rewritten.
   * @param {{
   *   id: string, merchantId?: string | null, deviceId?: string | null, entryPoint: string,
   *   source: string, sender?: string | null, sourcePackage?: string | null, bankName?: string | null,
   *   senderTrustStatus?: string, isSimulated?: boolean, receivedAt?: string | null, processedAt?: string,
   *   processingStatus: string, outcome: string, rejectionReason?: string | null, failingStage?: number | null,
   *   stages?: any, amountPaise?: bigint | number | string | null, referenceLast4?: string | null,
   *   paymentObservationId?: string | null, targetSessionId?: string | null, sessionId?: string | null,
   *   orderId?: string | null, customerId?: string | null, paymentStatus?: string | null
   * }} data
   */
  create(data) {
    const now = new Date().toISOString();
    this.db.execute(`
      INSERT OR IGNORE INTO observation_records (
        id, merchant_id, device_id, entry_point, source, sender, source_package, bank_name,
        sender_trust_status, is_simulated, received_at, processed_at, processing_status, outcome,
        rejection_reason, failing_stage, stages, amount_paise, reference_last4, payment_observation_id,
        target_session_id, session_id, order_id, customer_id, payment_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      data.id,
      data.merchantId || null,
      data.deviceId || null,
      data.entryPoint,
      data.source,
      data.sender || null,
      data.sourcePackage || null,
      data.bankName || null,
      data.senderTrustStatus || 'UNKNOWN',
      data.isSimulated ? 1 : 0,
      data.receivedAt || null,
      data.processedAt || now,
      data.processingStatus,
      data.outcome,
      data.rejectionReason || null,
      data.failingStage ?? null,
      JSON.stringify(data.stages || {}),
      data.amountPaise != null && data.amountPaise !== '' ? Number(data.amountPaise) : null,
      data.referenceLast4 || null,
      data.paymentObservationId || null,
      data.targetSessionId || null,
      data.sessionId || null,
      data.orderId || null,
      data.customerId || null,
      data.paymentStatus || null,
      now
    ]);
    return this.findById(data.id);
  }

  findById(id) {
    const row = this.db.queryOne('SELECT * FROM observation_records WHERE id = ?', [id]);
    return row ? this.mapRow(row) : null;
  }

  /**
   * Newest first, for one merchant.
   * @param {string} merchantId
   * @param {{ limit?: number, source?: string, outcome?: string, simulated?: boolean, entryPoint?: string }} [filter]
   */
  listForMerchant(merchantId, { limit = 50, source, outcome, simulated, entryPoint } = {}) {
    let sql = 'SELECT * FROM observation_records WHERE merchant_id = ?';
    const params = [merchantId];
    if (source) { sql += ' AND source = ?'; params.push(source); }
    if (outcome) { sql += ' AND outcome = ?'; params.push(outcome); }
    if (entryPoint) { sql += ' AND entry_point = ?'; params.push(entryPoint); }
    if (simulated === true || simulated === false) { sql += ' AND is_simulated = ?'; params.push(simulated ? 1 : 0); }
    sql += ' ORDER BY processed_at DESC LIMIT ?';
    params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
    return this.db.query(sql, params).map(r => this.mapRow(r));
  }

  /**
   * Records that settled, or were checked against, any of these sessions, oldest first.
   * @param {string[]} sessionIds
   */
  findForSessions(sessionIds) {
    if (!sessionIds.length) return [];
    const marks = sessionIds.map(() => '?').join(', ');
    return this.db.query(
      `SELECT * FROM observation_records WHERE session_id IN (${marks}) OR target_session_id IN (${marks}) ORDER BY processed_at ASC`,
      [...sessionIds, ...sessionIds]
    ).map(r => this.mapRow(r));
  }

  /**
   * Keeps the payment status shown with a session's records current when the session settles or
   * ends after the alert was processed (an SMS-only payment completes after a short grace period).
   * @param {string} sessionId
   * @param {string} status
   */
  updatePaymentStatus(sessionId, status) {
    this.db.execute(
      'UPDATE observation_records SET payment_status = ? WHERE session_id = ? OR target_session_id = ?',
      [status, sessionId, sessionId]
    );
  }

  mapRow(row) {
    let stages = {};
    try { stages = typeof row.stages === 'string' ? JSON.parse(row.stages) : (row.stages || {}); } catch {}
    return {
      observationId: row.id,
      merchantId: row.merchant_id,
      deviceId: row.device_id,
      entryPoint: row.entry_point,
      source: row.source,
      sender: row.sender,
      sourcePackage: row.source_package,
      bankName: row.bank_name,
      senderTrustStatus: row.sender_trust_status,
      isSimulated: Boolean(row.is_simulated),
      receivedAt: row.received_at,
      processedAt: row.processed_at,
      processingStatus: row.processing_status,
      outcome: row.outcome,
      rejectionReason: row.rejection_reason,
      failingStage: row.failing_stage == null ? null : Number(row.failing_stage),
      stages,
      amountPaise: row.amount_paise == null ? null : String(row.amount_paise),
      referenceLast4: row.reference_last4,
      paymentObservationId: row.payment_observation_id,
      targetSessionId: row.target_session_id,
      sessionId: row.session_id,
      orderId: row.order_id,
      customerId: row.customer_id,
      paymentStatus: row.payment_status
    };
  }
}
