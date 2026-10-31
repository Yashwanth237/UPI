import { isAllowedNotificationPackage } from '@youpi/common';

/** How far an observation's sender is established. */
export const SenderTrustStatus = Object.freeze({
  /** On the operator's allow-list (SMS_TRUSTED_SENDERS / GMAIL_TRUSTED_SENDERS). */
  VERIFIED: 'VERIFIED',
  /** A sender is known, but nothing confirms it is the bank. */
  UNVERIFIED: 'UNVERIFIED',
  /** No sender is known (a notification, or an SMS without an originating address). */
  UNKNOWN: 'UNKNOWN'
});

/**
 * Reduces a delivered SMS sender ("VM-HDFCBK", "AD-HDFCBK-S", "hdfcbk") to its DLT header code
 * ("HDFCBK") by dropping the 2-letter operator/circle prefix and the -S/-T/-P/-G category suffix.
 * @param {string} sender
 */
export function smsHeaderCode(sender) {
  return String(sender || '')
    .trim()
    .toUpperCase()
    .replace(/^[A-Z]{2}-/, '')
    .replace(/-[SPTG]$/, '');
}

/** Address part of an email From value ("HDFC Bank <alerts@hdfcbank.bank.in>"). */
function emailAddress(sender) {
  const s = String(sender || '');
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

/**
 * Who an observation came from, as separate fields: the channel, the SMS originating address or
 * email sender, the Android app that posted a notification, and how far the sender is trusted.
 *
 * An Android package is never a sender: a caller that put one in `sender` (older observer
 * builds did) gets it moved to `sourcePackage`. `bankName` is only set where the sender itself
 * names the bank (the registrant label of an RBI `.bank.in` / `.fin.in` email domain); there is
 * no header-to-bank registry, so SMS headers and notifications leave it null rather than guess.
 *
 * @param {{ source?: string, channel?: string, sender?: string | null, sourcePackage?: string | null }} input
 * @param {{ trustedSms?: Set<string> | null, trustedEmails?: Set<string> | null }} [trust]
 * @returns {{ source: 'SMS' | 'GMAIL' | 'NOTIFICATION', sender: string | null, sourcePackage: string | null, bankName: string | null, senderTrustStatus: string }}
 */
export function describeObservationSender(input, { trustedSms = null, trustedEmails = null } = {}) {
  const rawSource = String(input?.source || '').toUpperCase();
  let sender = typeof input?.sender === 'string' && input.sender.trim() ? input.sender.trim() : null;
  let sourcePackage = typeof input?.sourcePackage === 'string' && input.sourcePackage.trim()
    ? input.sourcePackage.trim().toLowerCase()
    : null;
  if (sender && isAllowedNotificationPackage(sender)) {
    sourcePackage = sourcePackage || sender.toLowerCase();
    sender = null;
  }

  if (rawSource.includes('GMAIL') || rawSource.includes('EMAIL')) {
    const address = sender ? emailAddress(sender) : '';
    const domain = address.includes('@') ? address.split('@')[1] : '';
    const label = (domain.match(/(?:^|\.)([a-z0-9-]+)\.(?:bank|fin)\.in$/) || [])[1];
    return {
      source: 'GMAIL',
      sender: address || null,
      sourcePackage: null,
      bankName: label ? label.toUpperCase() : null,
      senderTrustStatus: !address
        ? SenderTrustStatus.UNKNOWN
        : (trustedEmails && trustedEmails.has(address) ? SenderTrustStatus.VERIFIED : SenderTrustStatus.UNVERIFIED)
    };
  }

  const isNotification = Boolean(sourcePackage) || String(input?.channel || '').toUpperCase() === 'NOTIFICATION';
  if (!sender || sender.toUpperCase() === 'UNKNOWN') {
    return {
      source: isNotification ? 'NOTIFICATION' : 'SMS',
      sender: null,
      sourcePackage,
      bankName: null,
      senderTrustStatus: SenderTrustStatus.UNKNOWN
    };
  }
  return {
    source: isNotification ? 'NOTIFICATION' : 'SMS',
    sender,
    sourcePackage,
    bankName: null,
    senderTrustStatus: trustedSms && /[a-zA-Z]/.test(sender) && trustedSms.has(smsHeaderCode(sender))
      ? SenderTrustStatus.VERIFIED
      : SenderTrustStatus.UNVERIFIED
  };
}

/** Reasons meaning the payment was already counted once. */
const DUPLICATE_REASONS = new Set([
  'DUPLICATE_OBSERVATION',
  'DUPLICATE_OBSERVATION_DROPPED',
  'DUPLICATE_PAYMENT_UTR_CONFLICT',
  'REFERENCE_ALREADY_USED'
]);

/** Stage-2 refusals of the sender itself (SMS header, email domain, app package). */
const INVALID_SENDER_REASONS = new Set([
  'PERSONAL_SMS_REJECTED',
  'INVALID_SMS_SENDER',
  'UNTRUSTED_SMS_SENDER',
  'MISSING_SMS_SENDER',
  'INVALID_EMAIL_DOMAIN',
  'UNTRUSTED_EMAIL_SENDER',
  'UNTRUSTED_NOTIFICATION_PACKAGE'
]);

/** Stage-3 refusals that, for a notification, mean the app showed only part of the alert. */
const INCOMPLETE_TEXT_REASONS = new Set(['MISSING_RAW_TEXT', 'MISSING_CREDIT_INDICATOR', 'MISSING_CURRENCY_INDICATOR']);

/**
 * One outcome per observation for display, kept apart so a duplicate copy or an alert with no
 * open checkout is not read as a failed payment: ACCEPTED | DUPLICATE | NO_MATCHING_CHECKOUT |
 * UNVERIFIED_NOTIFICATION_SENDER | INCOMPLETE_NOTIFICATION | INVALID_BANK_SENDER | REJECTED |
 * PENDING_REVIEW. Only a VERIFIED pipeline result is ACCEPTED.
 * @param {{ status?: string, failingCondition?: string, stages?: any, senderIdentity?: { source?: string } } | null | undefined} pipeResult
 * @param {string} [source] SMS | NOTIFICATION | GMAIL; defaults to the result's sender identity
 */
export function classifyObservationOutcome(pipeResult, source = pipeResult?.senderIdentity?.source) {
  if (pipeResult?.status === 'VERIFIED') return 'ACCEPTED';
  const reason = pipeResult?.stages?.stage6?.outcomeStatus || pipeResult?.failingCondition || null;
  if (reason && DUPLICATE_REASONS.has(reason)) return 'DUPLICATE';
  if (reason === 'NO_ACTIVE_SESSION') return 'NO_MATCHING_CHECKOUT';
  if (reason === 'UNVERIFIED_NOTIFICATION_SENDER') return 'UNVERIFIED_NOTIFICATION_SENDER';
  if (reason && INVALID_SENDER_REASONS.has(reason)) return 'INVALID_BANK_SENDER';
  if (source === 'NOTIFICATION' && reason && INCOMPLETE_TEXT_REASONS.has(reason)) return 'INCOMPLETE_NOTIFICATION';
  if (pipeResult?.status === 'REJECTED') return 'REJECTED';
  return 'PENDING_REVIEW';
}
