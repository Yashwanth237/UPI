/**
 * Provider-independent delivery of customer one-time passcodes (OTP).
 *
 * The gateway never talks to a messaging vendor directly: routes hand a code to an
 * `OtpDispatcher`, which applies the configured channel policy (order + fallback) over a set
 * of providers. Every provider implements the same contract:
 *
 *   provider.channel      'whatsapp' | 'email' | 'dev'
 *   provider.name         stable identifier for logs/config ('whatsapp-cloud-api', ...)
 *   provider.isConfigured() -> boolean
 *   provider.send({ to, code, name, ttlSeconds }) -> Promise<{ messageId?: string }>
 *     resolves only when the vendor accepted the message, throws OtpDeliveryError otherwise.
 *
 * Codes are never logged by this module, except by the development console provider, which
 * refuses to exist when NODE_ENV=production.
 */

export class OtpDeliveryError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, provider?: string, retryable?: boolean, cause?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'OtpDeliveryError';
    this.code = opts.code || 'OTP_DELIVERY_FAILED';
    this.provider = opts.provider || null;
    this.retryable = opts.retryable !== false;
    if (opts.cause) this.cause = opts.cause;
  }
}

/** Masks a destination for display: `+91 ******3210` or `ab***@example.com`. */
export function maskDestination(channel, to) {
  const value = String(to || '');
  if (channel === 'email') {
    const at = value.indexOf('@');
    if (at <= 0) return '***';
    return `${value.slice(0, Math.min(2, at))}***@${value.slice(at + 1)}`;
  }
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 ? `******${digits.slice(-4)}` : '******';
}

/** Placeholder addresses the gateway invents when a customer gave no email. Never deliverable. */
export function isDeliverableEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && !value.endsWith('.youpi.local');
}

function toE164India(mobile) {
  const digits = String(mobile || '').replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  return null;
}

/**
 * Official WhatsApp Business Platform (Cloud API) provider.
 *
 * Sends a pre-approved AUTHENTICATION template:
 *   POST https://graph.facebook.com/{version}/{phone-number-id}/messages
 * Meta requires authentication templates to carry the code both as the body parameter and
 * as the copy-code URL button parameter (button index 0). Set
 * WHATSAPP_CLOUD_OTP_BUTTON=false only if your approved template has no button.
 */
export class WhatsAppCloudApiProvider {
  /**
   * @param {{ accessToken?: string, phoneNumberId?: string, templateName?: string,
   *   templateLanguage?: string, apiVersion?: string, includeButton?: boolean,
   *   fetchImpl?: typeof fetch, timeoutMs?: number }} config
   */
  constructor(config = {}) {
    this.channel = 'whatsapp';
    this.name = 'whatsapp-cloud-api';
    this.official = true;
    this.accessToken = config.accessToken || '';
    this.phoneNumberId = config.phoneNumberId || '';
    this.templateName = config.templateName || '';
    this.templateLanguage = config.templateLanguage || 'en';
    this.apiVersion = config.apiVersion || 'v21.0';
    this.includeButton = config.includeButton !== false;
    this.fetchImpl = config.fetchImpl || globalThis.fetch;
    this.timeoutMs = config.timeoutMs || 10000;
  }

  isConfigured() {
    return Boolean(this.accessToken && this.phoneNumberId && this.templateName);
  }

  async send({ to, code }) {
    if (!this.isConfigured()) {
      throw new OtpDeliveryError('WhatsApp Cloud API is not configured.', { code: 'PROVIDER_NOT_CONFIGURED', provider: this.name, retryable: false });
    }
    const recipient = toE164India(to);
    if (!recipient) {
      throw new OtpDeliveryError('Invalid WhatsApp recipient.', { code: 'INVALID_RECIPIENT', provider: this.name, retryable: false });
    }

    const components = [{ type: 'body', parameters: [{ type: 'text', text: code }] }];
    if (this.includeButton) {
      components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] });
    }

    const url = `https://graph.facebook.com/${encodeURIComponent(this.apiVersion)}/${encodeURIComponent(this.phoneNumberId)}/messages`;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: recipient,
          type: 'template',
          template: { name: this.templateName, language: { code: this.templateLanguage }, components }
        }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (err) {
      throw new OtpDeliveryError('WhatsApp Cloud API request failed.', { code: 'PROVIDER_UNREACHABLE', provider: this.name, cause: err });
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      // Vendor error codes are safe to log; they never contain the OTP.
      const vendorCode = payload?.error?.code;
      throw new OtpDeliveryError(`WhatsApp Cloud API rejected the message (HTTP ${response.status}${vendorCode ? `, code ${vendorCode}` : ''}).`, {
        code: 'PROVIDER_REJECTED',
        provider: this.name,
        retryable: response.status >= 500 || response.status === 429
      });
    }
    return { messageId: payload?.messages?.[0]?.id || null };
  }
}

/**
 * Adapter over the existing linked-device WhatsApp session (`berryprotocol`).
 *
 * That library drives a personal/business WhatsApp account as a linked "WhatsApp Web"
 * device. It is NOT the official Business Platform: Meta may restrict or ban numbers that
 * send automated traffic this way. It is kept for continuity and must be chosen explicitly
 * in production (OTP_WHATSAPP_PROVIDER=linked-device).
 */
export class LinkedDeviceWhatsAppProvider {
  /** @param {{ service: { sendOtp: Function, status?: string } | null, isProduction?: boolean }} config */
  constructor(config = {}) {
    this.channel = 'whatsapp';
    this.name = 'whatsapp-linked-device';
    this.official = false;
    this.service = config.service || null;
    this.isProduction = Boolean(config.isProduction);
  }

  isConfigured() {
    return Boolean(this.service && typeof this.service.sendOtp === 'function');
  }

  async send({ to, code, name }) {
    if (!this.isConfigured()) {
      throw new OtpDeliveryError('Linked-device WhatsApp is not available.', { code: 'PROVIDER_NOT_CONFIGURED', provider: this.name, retryable: false });
    }
    let result;
    try {
      result = await this.service.sendOtp(to, code, name || '');
    } catch (err) {
      throw new OtpDeliveryError('Linked-device WhatsApp send failed.', { code: 'PROVIDER_UNREACHABLE', provider: this.name, cause: err });
    }
    // A simulated send is not a delivery. Outside production the service simulates in tests,
    // which is acceptable there; in production it must never count as delivered.
    const delivered = Boolean(result && result.success && result.delivered && !(this.isProduction && result.simulated));
    if (!delivered) {
      throw new OtpDeliveryError('WhatsApp is not connected or the message was not delivered.', { code: 'PROVIDER_UNAVAILABLE', provider: this.name });
    }
    return { messageId: result.id || null, simulated: Boolean(result.simulated) };
  }
}

/**
 * Email OTP over SMTP (any provider: SES, SendGrid, Postmark, Google Workspace relay, ...).
 * `nodemailer` is loaded lazily so the dependency is only touched when email is configured.
 */
export class SmtpEmailOtpProvider {
  /**
   * @param {{ host?: string, port?: number, secure?: boolean, user?: string, password?: string,
   *   from?: string, brandName?: string, transport?: { sendMail: Function } }} config
   */
  constructor(config = {}) {
    this.channel = 'email';
    this.name = 'email-smtp';
    this.official = true;
    this.config = config;
    this.from = config.from || '';
    this.brandName = config.brandName || 'YouPI';
    this.transport = config.transport || null;
  }

  isConfigured() {
    return Boolean(this.transport || (this.config.host && this.from));
  }

  async getTransport() {
    if (this.transport) return this.transport;
    const { default: nodemailer } = await import('nodemailer');
    const port = Number(this.config.port) || 587;
    this.transport = nodemailer.createTransport({
      host: this.config.host,
      port,
      secure: this.config.secure ?? port === 465,
      requireTLS: !(this.config.secure ?? port === 465),
      auth: this.config.user ? { user: this.config.user, pass: this.config.password } : undefined,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000
    });
    return this.transport;
  }

  async send({ to, code, ttlSeconds = 300 }) {
    if (!this.isConfigured()) {
      throw new OtpDeliveryError('Email delivery is not configured.', { code: 'PROVIDER_NOT_CONFIGURED', provider: this.name, retryable: false });
    }
    if (!isDeliverableEmail(to)) {
      throw new OtpDeliveryError('No deliverable email address.', { code: 'INVALID_RECIPIENT', provider: this.name, retryable: false });
    }
    const minutes = Math.max(1, Math.round(ttlSeconds / 60));
    try {
      const transport = await this.getTransport();
      const info = await transport.sendMail({
        from: this.from,
        to,
        subject: `${code} is your ${this.brandName} verification code`,
        text: `Your ${this.brandName} verification code is ${code}.\n\nIt expires in ${minutes} minutes. Do not share this code with anyone, including anyone claiming to be from ${this.brandName}.\n\nIf you did not request this code, you can ignore this email.`
      });
      return { messageId: info?.messageId || null };
    } catch (err) {
      throw new OtpDeliveryError('Email delivery failed.', { code: 'PROVIDER_UNREACHABLE', provider: this.name, cause: err });
    }
  }
}

/**
 * Development-only provider: prints the code to the server console.
 * Construction throws in production so it can never be enabled there by configuration.
 */
export class DevConsoleOtpProvider {
  constructor({ channel = 'dev', env = process.env, logger = console } = {}) {
    if (env.NODE_ENV === 'production') {
      throw new Error('DevConsoleOtpProvider cannot be used when NODE_ENV=production.');
    }
    this.channel = channel;
    this.name = 'dev-console';
    this.official = false;
    this.logger = logger;
  }

  isConfigured() {
    return true;
  }

  async send({ to, code }) {
    this.logger.log(`[DEV ONLY · not delivered] Verification code for ${maskDestination(this.channel, to)}: ${code}`);
    return { messageId: null, simulated: true };
  }
}

/**
 * Applies the channel policy over registered providers.
 *
 * policy.channels: ordered list of enabled channels ('whatsapp', 'email').
 * policy.allowFallback: try the next channel when the preferred one fails.
 */
export class OtpDispatcher {
  /**
   * @param {{ providers: Array<any>, channels?: string[], allowFallback?: boolean, logger?: Console }} options
   */
  constructor({ providers = [], channels = ['whatsapp', 'email'], allowFallback = true, logger = console } = {}) {
    this.providers = providers.filter(Boolean);
    this.channels = channels;
    this.allowFallback = allowFallback;
    this.logger = logger;
  }

  /** Channels that have at least one configured provider, in policy order. */
  availableChannels() {
    return this.channels.filter(ch => this.providers.some(p => p.isConfigured() && (p.channel === ch || p.channel === 'dev')));
  }

  /**
   * Describes the setup for health/admin screens (never includes secrets).
   */
  describe() {
    return {
      channels: this.channels,
      allowFallback: this.allowFallback,
      providers: this.providers.map(p => ({ name: p.name, channel: p.channel, configured: p.isConfigured(), official: p.official !== false }))
    };
  }

  /**
   * @param {{ mobile?: string, email?: string, code: string, name?: string, ttlSeconds?: number, preferredChannel?: string }} request
   * @returns {Promise<{ channel: string, provider: string, destination: string, simulated: boolean, attempts: Array<{ provider: string, channel: string, error: string }> }>}
   */
  async send(request) {
    const order = [...this.channels];
    if (request.preferredChannel && order.includes(request.preferredChannel)) {
      order.splice(order.indexOf(request.preferredChannel), 1);
      order.unshift(request.preferredChannel);
    }

    const attempts = [];
    for (const channel of order) {
      const to = channel === 'email' ? request.email : request.mobile;
      if (!to || (channel === 'email' && !isDeliverableEmail(to))) {
        attempts.push({ provider: null, channel, error: 'NO_DESTINATION' });
        continue;
      }

      const candidates = this.providers.filter(p => p.isConfigured() && (p.channel === channel || p.channel === 'dev'));
      for (const provider of candidates) {
        try {
          const result = await provider.send({ to, code: request.code, name: request.name, ttlSeconds: request.ttlSeconds });
          return {
            channel,
            provider: provider.name,
            destination: maskDestination(channel, to),
            simulated: Boolean(result?.simulated) || provider.channel === 'dev',
            attempts
          };
        } catch (err) {
          const code = err instanceof OtpDeliveryError ? err.code : 'PROVIDER_ERROR';
          attempts.push({ provider: provider.name, channel, error: code });
          this.logger.warn(`[OtpDispatcher] ${provider.name} failed for ${maskDestination(channel, to)}: ${err.message}`);
        }
      }
      if (!this.allowFallback && attempts.some(a => a.channel === channel && a.provider)) break;
    }

    const error = new OtpDeliveryError('No verification channel could deliver the code.', { code: 'OTP_DELIVERY_UNAVAILABLE' });
    error.attempts = attempts;
    throw error;
  }
}

function parseChannels(value) {
  const allowed = new Set(['whatsapp', 'email']);
  const list = String(value || 'whatsapp,email').split(',').map(s => s.trim().toLowerCase()).filter(s => allowed.has(s));
  return list.length ? [...new Set(list)] : ['whatsapp', 'email'];
}

/**
 * Builds the dispatcher from environment configuration.
 *
 * WhatsApp provider selection (OTP_WHATSAPP_PROVIDER):
 *   cloud-api      official WhatsApp Business Platform (WHATSAPP_CLOUD_* variables)
 *   linked-device  existing berryprotocol session (unofficial)
 *   unset          cloud-api when its variables are present, otherwise linked-device
 *                  (keeps existing installations working; a warning is logged in production)
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {{ linkedDeviceService?: any, fetchImpl?: typeof fetch, emailTransport?: any, logger?: Console }} [deps]
 */
export function createOtpDispatcherFromEnv(env = process.env, deps = {}) {
  const logger = deps.logger || console;
  const isProduction = env.NODE_ENV === 'production';
  const providers = [];

  const cloud = new WhatsAppCloudApiProvider({
    accessToken: env.WHATSAPP_CLOUD_ACCESS_TOKEN,
    phoneNumberId: env.WHATSAPP_CLOUD_PHONE_NUMBER_ID,
    templateName: env.WHATSAPP_CLOUD_OTP_TEMPLATE,
    templateLanguage: env.WHATSAPP_CLOUD_TEMPLATE_LANGUAGE,
    apiVersion: env.WHATSAPP_CLOUD_API_VERSION,
    includeButton: String(env.WHATSAPP_CLOUD_OTP_BUTTON || 'true').toLowerCase() !== 'false',
    fetchImpl: deps.fetchImpl
  });
  const linked = new LinkedDeviceWhatsAppProvider({ service: deps.linkedDeviceService, isProduction });

  const whatsappChoice = String(env.OTP_WHATSAPP_PROVIDER || '').trim().toLowerCase();
  if (whatsappChoice === 'cloud-api') {
    providers.push(cloud);
  } else if (whatsappChoice === 'linked-device') {
    providers.push(linked);
  } else if (whatsappChoice === 'none') {
    // WhatsApp disabled explicitly.
  } else if (cloud.isConfigured()) {
    providers.push(cloud);
  } else if (linked.isConfigured()) {
    providers.push(linked);
    if (isProduction) {
      logger.warn('[OtpDispatcher] Using the unofficial linked-device WhatsApp session for OTPs. Configure WHATSAPP_CLOUD_* (official API) or set OTP_WHATSAPP_PROVIDER=linked-device to acknowledge this choice.');
    }
  }

  providers.push(new SmtpEmailOtpProvider({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT ? Number(env.SMTP_PORT) : undefined,
    secure: env.SMTP_SECURE === undefined ? undefined : String(env.SMTP_SECURE).toLowerCase() === 'true',
    user: env.SMTP_USER,
    password: env.SMTP_PASSWORD,
    from: env.OTP_EMAIL_FROM,
    brandName: env.OTP_BRAND_NAME || env.DEFAULT_APP_NAME,
    transport: deps.emailTransport
  }));

  // Development fallback: explicit opt-in, or automatic when nothing real is configured.
  // Never in production (the constructor refuses).
  const anyReal = providers.some(p => p.isConfigured());
  if (!isProduction && (String(env.OTP_DEV_CONSOLE || '').toLowerCase() === 'true' || !anyReal)) {
    providers.push(new DevConsoleOtpProvider({ env, logger }));
  }

  return new OtpDispatcher({
    providers,
    channels: parseChannels(env.OTP_CHANNELS),
    allowFallback: String(env.OTP_ALLOW_FALLBACK || 'true').toLowerCase() !== 'false',
    logger
  });
}
