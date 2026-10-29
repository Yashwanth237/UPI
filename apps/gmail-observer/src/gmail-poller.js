import { PaymentObserverClient } from '@youpi/observer-sdk';
import { getObserverToken } from '@youpi/common';
import { BankEmailParser } from './parser.js';

/** Stays under the verification pipeline's 8192-char scan limit (PAYLOAD_TOO_LARGE). */
export const MAX_RAW_TEXT_CHARS = 8000;

/** How long a NO_ACTIVE_SESSION (UNRESOLVED) email is retried: the payment window plus slack. */
export const UNRESOLVED_RETRY_WINDOW_MS = 10 * 60 * 1000;

const decode = (data) => {
  try { return Buffer.from(data, 'base64url').toString('utf8'); } catch { return ''; }
};

/** HTML bank alerts → plain text: drops style/script/head, tags and common entities, collapses whitespace. */
export function htmlToText(html) {
  return String(html)
    .replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#8377;|&#x20b9;/gi, '₹')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** Finds the first part of a MIME type anywhere in the (possibly nested) multipart tree. */
function findPart(payload, mimeType) {
  if (!payload) return null;
  if (payload.mimeType === mimeType && payload.body?.data) return payload;
  for (const part of payload.parts || []) {
    const hit = findPart(part, mimeType);
    if (hit) return hit;
  }
  return null;
}

/** Plain-text body of a Gmail API message payload, preferring text/plain over (stripped) text/html. */
export function extractBodyFromGmailPayload(payload) {
  if (!payload) return '';
  const plain = findPart(payload, 'text/plain');
  if (plain) return decode(plain.body.data).trim();
  const html = findPart(payload, 'text/html');
  if (html) return htmlToText(decode(html.body.data));
  if (payload.body?.data) return decode(payload.body.data).trim();
  for (const part of payload.parts || []) {
    const text = extractBodyFromGmailPayload(part);
    if (text) return text;
  }
  return '';
}

/**
 * Whether a message that failed submission should be skipped from now on.
 * REJECTED is the pipeline's final verdict (not a credit alert, unknown sender, ...).
 * UNRESOLVED (no matching session yet) is retried while the email is recent, since the alert
 * can land moments before the session is active. Network errors and 5xx are always retried.
 * @param {any} err
 * @param {number} emailTimeMs
 * @param {number} [nowMs]
 */
export function isFinalSubmissionFailure(err, emailTimeMs, nowMs = Date.now()) {
  const status = Number(err?.status);
  if (!(status >= 400 && status < 500)) return false;
  if (err?.body?.status === 'UNRESOLVED') return nowMs - emailTimeMs > UNRESOLVED_RETRY_WINDOW_MS;
  return true;
}

export class GmailPoller {
  /**
   * @param {{
   *   apiBaseUrl?: string,
   *   receivingAccountId?: string,
   *   pollIntervalMs?: number
   * }} options
   */
  constructor(options = {}) {
    this.apiBaseUrl = options.apiBaseUrl || process.env.BASE_PAYMENT_API_URL || 'http://localhost:6100';
    this.receivingAccountId = options.receivingAccountId || '00000000-0000-0000-0000-000000000002';
    this.pollIntervalMs = options.pollIntervalMs || Number(process.env.GMAIL_POLL_INTERVAL_MS || 5000);
    this.observerClient = new PaymentObserverClient({
      apiBaseUrl: this.apiBaseUrl,
      sourceName: 'GMAIL'
    });

    this.isRunning = false;
    this.timer = null;
    this.lastPollAt = null;
    this.observedCount = 0;
    this.credentials = null;
    this.cachedAccessToken = null;
    this.tokenExpiresAt = 0;
    this.processedMessageIds = new Set();
    this.consecutiveFailures = 0;
    this.failingSince = 0;
    // Outcome of the last finished poll: NOT_AUTHORIZED | FAILED | NO_MATCHES | MESSAGES_FOUND.
    this.lastPoll = { outcome: null, at: null, error: null, matched: 0, processed: 0 };
  }

  /** Records a poll outcome for /health; logs once when Gmail is not linked. */
  recordPoll(outcome, { error = null, matched = 0, processed = 0 } = {}) {
    if (outcome === 'NOT_AUTHORIZED' && this.lastPoll.outcome !== 'NOT_AUTHORIZED') {
      console.warn('[Gmail Observer] No Gmail authorization stored; polling is idle. Link Gmail in Merchant Admin.');
    }
    this.lastPoll = { outcome, at: new Date(), error, matched, processed };
  }

  /** Health view of the poller. Never includes tokens or message content. */
  getDiagnostics() {
    return {
      authorized: Boolean(this.credentials?.refreshToken) && this.lastPoll.outcome !== 'NOT_AUTHORIZED',
      lastPollOutcome: this.lastPoll.outcome,
      lastPollCompletedAt: this.lastPoll.at,
      lastPollError: this.lastPoll.error,
      lastMatchCount: this.lastPoll.matched,
      lastProcessedCount: this.lastPoll.processed
    };
  }

  setCredentials(creds) {
    this.credentials = { ...(this.credentials || {}), ...creds };
  }

  async fetchCredentialsFromPaymentApi() {
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/v1/admin/gmail/credentials`, { headers: { Authorization: `Bearer ${getObserverToken()}` } });
      if (res.ok) {
        const data = await res.json();
        const conf = data.gmailConfig || data;
        if (conf.refreshToken || conf.clientId) {
          this.setCredentials({
            clientId: conf.clientId,
            clientSecret: conf.clientSecret,
            refreshToken: conf.refreshToken,
            connectedEmail: conf.connectedEmail
          });
        }
      }
    } catch {}
  }

  /**
   * Restarts polling after a service restart when a Google account is still linked (a stored
   * refresh token). Before this, only the OAuth callback started the poller, so any restart
   * silently stopped Gmail payment confirmation. Retries while the payment API is still booting.
   * Disconnect clears the refresh token, so a deliberately unlinked account stays stopped.
   * @param {{ attempts?: number, delayMs?: number }} [opts]
   * @returns {Promise<boolean>} true when polling was resumed
   */
  async resumeIfConnected({ attempts = 10, delayMs = 3000 } = {}) {
    for (let i = 0; i < attempts; i++) {
      if (this.isRunning) return true;
      await this.fetchCredentialsFromPaymentApi();
      if (this.credentials?.refreshToken) {
        const masked = String(this.credentials.connectedEmail || 'unknown').replace(/^(.{2}).*(@.*)$/, '$1***$2');
        console.log(`[Gmail Observer] Resuming polling for linked account (${masked}).`);
        this.start();
        return true;
      }
      if (i < attempts - 1) await new Promise(r => { const t = setTimeout(r, delayMs); if (t.unref) t.unref(); });
    }
    return false;
  }

  async getAccessToken() {
    if (this.cachedAccessToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedAccessToken;
    }

    if (!this.credentials?.refreshToken || !this.credentials?.clientId || !this.credentials?.clientSecret) {
      await this.fetchCredentialsFromPaymentApi();
    }

    const { clientId, clientSecret, refreshToken } = this.credentials || {};
    if (!clientId || !clientSecret || !refreshToken) return null;

    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token'
        }),
        signal: AbortSignal.timeout(8000)
      });

      if (!tokenRes.ok) {
        // Used to return null silently, which stopped polling with nothing in the logs.
        const body = await tokenRes.json().catch(() => ({}));
        const err = new Error(`Google rejected the stored Gmail authorization (HTTP ${tokenRes.status}${body.error ? `: ${body.error}` : ''}). Re-authorize Gmail in Merchant Admin.`);
        err.permanent = tokenRes.status === 400 || tokenRes.status === 401;
        throw err;
      }

      const tokenData = await tokenRes.json();
      this.cachedAccessToken = tokenData.access_token;
      this.tokenExpiresAt = Date.now() + ((tokenData.expires_in || 3500) - 120) * 1000;
      return this.cachedAccessToken;
    } catch (err) {
      // Network errors and rejections propagate to pollCycle, which reports outages once.
      throw new Error(`Failed to refresh Google access token: ${err.message}`, { cause: err });
    }
  }

  /** Logs the first failure of an outage, an error once it lasts ~1 min, and nothing in between. */
  noteFailure(err) {
    this.consecutiveFailures = (this.consecutiveFailures || 0) + 1;
    const permanent = Boolean(err?.permanent || err?.cause?.permanent);
    if (this.consecutiveFailures === 1) {
      this.failingSince = Date.now();
      if (permanent) console.error(`[Gmail Observer] ${err.message}`);
      else console.warn(`[Gmail Observer] Poll failed, will keep retrying: ${err.message}`);
    } else if (this.consecutiveFailures === Math.max(2, Math.ceil(60000 / this.pollIntervalMs))) {
      const secs = Math.round((Date.now() - this.failingSince) / 1000);
      console.error(`[Gmail Observer] Gmail unreachable for ${secs}s (${this.consecutiveFailures} polls): ${err.message}`);
    }
  }

  noteSuccess() {
    if (this.consecutiveFailures > 0) {
      const secs = Math.round((Date.now() - this.failingSince) / 1000);
      console.log(`[Gmail Observer] Polling recovered after ${this.consecutiveFailures} failed poll(s) (${secs}s).`);
    }
    this.consecutiveFailures = 0;
  }

  async resolveActiveReceivingAccount() {
    try {
      const sessions = await this.observerClient.getActiveWindow();
      if (sessions && sessions.length > 0) {
        return sessions[0].receivingAccountId;
      }
    } catch {}
    return null;
  }

  /**
   * Ingests an email directly (e.g. from webhook, push notification, or manual poll).
   * @param {{ subject: string, body: string, date?: string | Date, from?: string, id?: string }} email
   */
  async processEmail(email) {
    let parsed = null;
    try {
      parsed = BankEmailParser.parse(email);
    } catch {}

    let targetAccountId = this.receivingAccountId;
    try {
      const activeAcct = await this.resolveActiveReceivingAccount();
      if (activeAcct) targetAccountId = activeAcct;
    } catch {}

    const sender = email.from || email.sender || 'alerts@retail.bank.in';
    // Credit details sit at the top of bank alerts; long footers must not push it over the limit.
    const rawContent = `${email.subject || ''}\n${email.body || ''}`.trim().slice(0, MAX_RAW_TEXT_CHARS);

    try {
      const result = await this.observerClient.submitObservation({
        receivingAccountId: targetAccountId,
        amountPaise: parsed ? parsed.amountPaise : undefined,
        amount: parsed ? parsed.amount : undefined,
        observedAt: email.date ? new Date(email.date) : new Date(),
        bankReferenceNumber: parsed?.bankReferenceNumber,
        senderVpa: parsed?.senderVpa,
        sender,
        rawText: rawContent,
        rawPayload: {
          messageId: email.id || email.messageId || `gmail_${Date.now()}`,
          subject: email.subject || '',
          body: email.body || '',
          snippet: parsed?.rawSnippet || (email.body || '').substring(0, 200),
          from: sender,
          sender,
          source: 'GMAIL',
          internalDate: email.internalDate || (email.date ? new Date(email.date).getTime() : Date.now())
        }
      });

      this.observedCount++;
      return result;
    } catch (err) {
      // Final rejections are routine (most matching emails are not credit alerts); the poll loop logs those.
      if (!(Number(err?.status) >= 400 && Number(err?.status) < 500)) {
        console.error('[Gmail Observer] Submission failed:', err.message);
      }
      throw err;
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[Gmail Observer] Poller started (interval: ${this.pollIntervalMs}ms)`);

    // Run first poll cycle immediately
    this.pollCycle().catch(() => {});

    this.timer = setInterval(() => {
      this.pollCycle().catch(() => {});
    }, this.pollIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    this._isPolling = false;
    console.log('[Gmail Observer] Poller stopped.');
  }

  /** Remembers a settled message id (bounded, oldest evicted first). */
  markProcessed(id) {
    this.processedMessageIds.add(id);
    if (this.processedMessageIds.size > 500) {
      const firstKey = this.processedMessageIds.values().next().value;
      this.processedMessageIds.delete(firstKey);
    }
  }

  async pollCycle() {
    if (this._isPolling) return;
    this._isPolling = true;

    try {
      this.lastPollAt = new Date();
      const accessToken = await this.getAccessToken();
      if (!accessToken) {
        this.recordPoll('NOT_AUTHORIZED');
        return;
      }

      const query = encodeURIComponent('subject:(credit OR credited OR received OR upi OR deposit OR alert)');
      const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=${query}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8000)
      });

      if (!listRes.ok) {
        if (listRes.status === 401) {
          this.cachedAccessToken = null;
          this.recordPoll('FAILED', { error: 'Gmail API HTTP 401 (access token expired; refreshing on next poll)' });
          return; // expired access token; the next poll refreshes it
        }
        const listErr = new Error(`Gmail API list request failed (HTTP ${listRes.status}).`);
        this.noteFailure(listErr);
        this.recordPoll('FAILED', { error: listErr.message });
        return;
      }
      this.noteSuccess();

      const listData = await listRes.json();
      const messages = listData.messages || [];
      let processed = 0;

      for (const m of messages) {
        if (this.processedMessageIds.has(m.id)) continue;

        /** @type {Date | null} */
        let emailDate = null;
        try {
          const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, {
            headers: { 'Authorization': `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(8000)
          });
          if (!msgRes.ok) continue;

          const msgData = await msgRes.json();
          const headers = msgData.payload?.headers || [];
          const from = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
          const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
          const dateStr = headers.find(h => h.name.toLowerCase() === 'date')?.value || '';
          const body = extractBodyFromGmailPayload(msgData.payload) || msgData.snippet || '';
          emailDate = dateStr ? new Date(dateStr) : new Date(Number(msgData.internalDate || Date.now()));

          await this.processEmail({
            id: m.id,
            messageId: m.id,
            subject,
            body,
            from,
            date: emailDate
          });

          this.markProcessed(m.id);
          processed++;
        } catch (msgErr) {
          const emailTimeMs = emailDate && !Number.isNaN(emailDate.getTime()) ? emailDate.getTime() : Date.now();
          if (isFinalSubmissionFailure(msgErr, emailTimeMs)) {
            // Settled by the pipeline: skip it from now on instead of re-fetching every poll.
            this.markProcessed(m.id);
            const verdict = msgErr.body ? `${msgErr.body.status || 'REJECTED'} (${msgErr.body.reason || 'no reason'})` : `HTTP ${msgErr.status}`;
            console.log(`[Gmail Observer] Skipped message ${m.id}: ${verdict}`);
          } else {
            console.warn(`[Gmail Observer] Will retry message ${m.id}:`, msgErr.message);
          }
        }
      }
      this.recordPoll(messages.length ? 'MESSAGES_FOUND' : 'NO_MATCHES', { matched: messages.length, processed });
    } catch (err) {
      this.noteFailure(err);
      this.recordPoll('FAILED', { error: err.message });
    } finally {
      this._isPolling = false;
    }
  }
}
