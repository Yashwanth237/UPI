import { generateHmac } from '@youpi/common';

/**
 * Android Observer Simulator / Driver.
 * Emulates the native Android Kotlin application for headless testing,
 * CI/CD verification, and local development.
 */
export class AndroidObserverDriver {
  /**
   * @param {{
   *   apiBaseUrl?: string,
   *   deviceName?: string,
   *   deviceModel?: string
   * }} options
   */
  constructor(options = {}) {
    this.apiBaseUrl = (options.apiBaseUrl || process.env.BASE_PAYMENT_API_URL || 'http://localhost:6100').replace(/\/+$/, '');
    this.deviceName = options.deviceName || 'Pixel 8 Pro';
    this.deviceModel = options.deviceModel || 'Google Pixel';

    this.deviceId = null;
    this.signingKey = null;
    this.heartbeatTimer = null;
  }

  /**
   * Pairs device with self-hosted gateway using enrollment token.
   * @param {string} enrollmentToken
   * @param {string} [merchantId]
   */
  async pair(enrollmentToken, merchantId = null) {
    const url = `${this.apiBaseUrl}/api/v1/pollers/android/pair`;
    const payload = {
      enrollmentToken,
      deviceName: this.deviceName,
      deviceModel: this.deviceModel,
      merchantId
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Device pairing failed [HTTP ${res.status}]: ${err}`);
    }

    const data = await res.json();
    this.deviceId = data.deviceId;
    this.signingKey = data.signingKey;

    return data;
  }

  /**
   * Submits a signed payment observation to backend.
   * @param {{
   *   amount: string | number,
   *   amountPaise?: bigint | number,
   *   receivingAccountId?: string,
   *   observedAt?: Date | string,
   *   utr?: string,
   *   senderVpa?: string,
   *   notificationText?: string,
   *   timestampOverride?: number
   * }} obs
   */
  async submitObservation(obs) {
    if (!this.deviceId || !this.signingKey) {
      throw new Error('Device must be paired before submitting observations.');
    }

    const url = `${this.apiBaseUrl}/api/v1/pollers/android/events`;
    const timestamp = (obs.timestampOverride !== undefined ? obs.timestampOverride : Date.now()).toString();

    const bodyObj = {
      deviceId: this.deviceId,
      receivingAccountId: obs.receivingAccountId || '00000000-0000-0000-0000-000000000002',
      amount: obs.amount,
      amountPaise: obs.amountPaise !== undefined ? obs.amountPaise.toString() : undefined,
      observedAt: (obs.observedAt instanceof Date ? obs.observedAt : new Date(obs.observedAt || Date.now())).toISOString(),
      bankReferenceNumber: obs.utr,
      senderVpa: obs.senderVpa,
      rawNotification: obs.rawNotification !== undefined ? obs.rawNotification : {
        title: obs.notificationTitle || 'Payment Received',
        text: obs.notificationText || `Received Rs ${obs.amount} via UPI`,
        package: obs.package !== undefined ? obs.package : 'com.phonepe.app'
      }
    };

    const bodyString = JSON.stringify(bodyObj);
    const sigPayload = `${bodyString}:${timestamp}`;
    const signature = generateHmac(sigPayload, this.signingKey);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': this.deviceId,
        'X-Timestamp': timestamp,
        'X-Signature': signature
      },
      body: bodyString
    });

    const respText = await res.text();
    let respJson;
    try {
      respJson = JSON.parse(respText);
    } catch {
      respJson = { raw: respText };
    }

    return {
      status: res.status,
      body: respJson
    };
  }

  /**
   * Forwards a raw SMS exactly as the APK's ApiClient.sendSmsStatus does: body fields in the same
   * order, signed over `${body}:${sendTime}`, posted to the SMS-broadcast route.
   * @param {{ sender: string, body: string, receivedAt?: number, timestampOverride?: number }} sms
   */
  async submitSms(sms) {
    if (!this.deviceId || !this.signingKey) {
      throw new Error('Device must be paired before forwarding SMS.');
    }
    const timestamp = String(sms.timestampOverride ?? Date.now());
    const bodyString = JSON.stringify({
      deviceId: this.deviceId,
      sender: sms.sender ?? 'UNKNOWN',
      body: sms.body ?? '',
      timestamp: sms.receivedAt ?? Number(timestamp)
    });
    const res = await fetch(`${this.apiBaseUrl}/api/v1/observers/sms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Device-Id': this.deviceId,
        'X-Timestamp': timestamp,
        'X-Signature': generateHmac(`${bodyString}:${timestamp}`, this.signingKey)
      },
      body: bodyString
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return { status: res.status, body };
  }

  /**
   * Submits heartbeat to backend.
   */
  async sendHeartbeat() {
    if (!this.deviceId || !this.signingKey) throw new Error('Cannot send heartbeat: device not paired.');
    const url = `${this.apiBaseUrl}/api/v1/pollers/android/heartbeat`;
    const timestamp = Date.now().toString();
    const bodyString = JSON.stringify({ deviceId: this.deviceId, timestamp: Number(timestamp) });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': this.deviceId,
        'X-Timestamp': timestamp,
        'X-Signature': generateHmac(`${bodyString}:${timestamp}`, this.signingKey)
      },
      body: bodyString
    });

    return await res.json();
  }

  startHeartbeat(intervalMs = 60000) {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat().catch(() => {});
    }, intervalMs);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
