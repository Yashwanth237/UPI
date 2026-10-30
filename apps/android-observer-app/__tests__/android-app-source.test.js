import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BankSmsParser } from '@youpi/core';
import { parseLanHosts, applyLanHosts } from '../../../scripts/android-network-config.js';

// Checks on the Android app's Java sources and build inputs that need no Android toolchain:
// the on-device SMS privacy filter (run here through the same regular expressions the Java code
// compiles), the permissions it asks for, and the build-time LAN cleartext exception.
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app/src/main');
const JAVA_DIR = path.join(APP_DIR, 'java/com/youpi/observer');
const read = rel => fs.readFileSync(path.join(APP_DIR, rel), 'utf8');
const javaSource = name => fs.readFileSync(path.join(JAVA_DIR, name), 'utf8');

/** Value of a `static final String NAME = "..." + "...";` constant, Java escapes decoded. */
function javaStringConstant(source, name) {
  const decl = new RegExp(`static final String ${name}\\s*=([\\s\\S]*?);`).exec(source);
  assert.ok(decl, `${name} not found`);
  return [...decl[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => JSON.parse(`"${m[1]}"`)).join('');
}

/** SmsFilter.isEligible, evaluated with the Java source's own patterns. */
function makeFilter() {
  const src = javaSource('SmsFilter.java');
  const creditKeywords = new RegExp(javaStringConstant(src, 'CREDIT_KEYWORDS_REGEX'), 'i');
  const debitWord = new RegExp(javaStringConstant(src, 'DEBIT_WORD_REGEX'), 'i');
  const creditWord = new RegExp(javaStringConstant(src, 'CREDIT_WORD_REGEX'), 'i');
  const maxChars = Number(/MAX_BODY_CHARS\s*=\s*(\d+)/.exec(src)[1]);
  return body => {
    const text = String(body ?? '').trim();
    if (!text || text.length > maxChars) return false;
    if (!creditKeywords.test(text) || !/\d/.test(text)) return false;
    const debitIdx = text.search(debitWord);
    if (debitIdx !== -1) {
      const creditIdx = text.search(creditWord);
      if (creditIdx === -1 || debitIdx < creditIdx) return false;
    }
    return true;
  };
}

// Synthetic credit alerts in the formats the gateway's own tests use.
const CREDIT_ALERTS = [
  'Rs.165.00 credited to a/c XX1234 (UPI Ref No 512345678901).',
  'Dear SBI user, A/C 1234 credited by Rs 499.00 on 08Sep26 by UPI/CR/667788/buyer@okhdfcbank Ref: 667788.',
  'Dear Customer, A/C *4321 credited by Rs 450.00 on 30-Sep-26 by UPI/9876543210/REF99887766 - HDFC Bank',
  'Dear Customer, your ac no. XXXXX12345 has been credited with Rs 500.00 on 18-Oct-26.',
  'Rs 1200.00 received in your account via UPI 987654321012 on 18/10.',
  'Avl Bal Rs 15,000.00. Rs 500.00 credited to A/c XX1234 for UPI txn Ref 123456789012.',
  'Payment received: INR 750.00 ref: 998877665544 credited to merchant account',
  '₹500.00 credited to a/c via UPI/CR/123456789099',
  'Rs 500 credited. Rs 10 debited for SMS charges. Ref 612345678901',
  'INR 1,250.00 deposited in A/c XX9876 on 29-10-26 Ref 401234567890'
];

const MUST_STAY_ON_PHONE = [
  ['OTP', '483920 is your OTP for login. Do not share it with anyone.'],
  ['transaction OTP', 'OTP for your txn of Rs 2,000.00 at AMAZON is 771204. Valid for 3 mins.'],
  ['personal chat', 'Reached home, will call you in 10 mins'],
  ['promotion', 'Get flat 50% off on your next order! Use code SAVE50. T&C apply'],
  ['debit alert', 'Rs 340.00 debited from A/c XX1234 on 29-10-26 to VPA shop@okicici. Not you? Call 1800'],
  ['debit with later credit wording', 'Your a/c XX1234 is debited for Rs 99.00; amount will be credited back in 48 hrs if failed'],
  ['no number', 'Your payment was received, thank you'],
  ['oversized', 'credited Rs 1 '.repeat(400)]
];

describe('Android app sources', () => {
  const isEligible = makeFilter();

  test('the on-device filter uploads every credit alert the gateway parser accepts', () => {
    for (const sms of CREDIT_ALERTS) {
      assert.ok(BankSmsParser.parse({ text: sms, sender: 'VM-HDFCBK', timestamp: new Date() }), `parser should accept: ${sms}`);
      assert.equal(isEligible(sms), true, `filter dropped a credit alert: ${sms}`);
    }
  });

  test('personal SMS, OTPs, promotions and debit alerts never leave the phone', () => {
    for (const [label, sms] of MUST_STAY_ON_PHONE) {
      assert.equal(isEligible(sms), false, `${label} would be uploaded`);
    }
  });

  test('nothing the filter drops could have been verified by the gateway', () => {
    for (const [label, sms] of MUST_STAY_ON_PHONE) {
      if (label === 'oversized') continue;
      assert.equal(BankSmsParser.parse({ text: sms, sender: 'VM-HDFCBK', timestamp: new Date() }), null, `${label} is parseable but filtered`);
    }
  });

  test('the filter keeps the parser\'s exact credit-phrase pattern', () => {
    const parserSource = fs.readFileSync(path.resolve(APP_DIR, '../../../../../packages/core/src/bank-sms-parser.js'), 'utf8');
    const block = /const creditKeywords = new RegExp\(([\s\S]*?),\s*'i'\s*\)/.exec(parserSource);
    assert.ok(block, 'creditKeywords not found in bank-sms-parser.js');
    const parserPattern = [...block[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(m => m[1].replace(/\\\\/g, '\\')).join('');
    assert.equal(javaStringConstant(javaSource('SmsFilter.java'), 'CREDIT_KEYWORDS_REGEX'), parserPattern);
  });

  test('the receiver filters, persists, then forwards; it never sends straight from the broadcast', () => {
    const receiver = javaSource('SmsReceiver.java');
    assert.match(receiver, /SmsFilter\.isEligible\(body\)/);
    assert.match(receiver, /SmsOutbox\.enqueue\(/);
    assert.match(receiver, /goAsync\(\)/);
    assert.doesNotMatch(receiver, /client\.sendSms\(/);
    assert.doesNotMatch(receiver, /Log\.\w\(TAG, [^;]*\+ body[^.]/, 'SMS text must not be logged');
  });

  test('every SMS broadcast is counted at each step, so a stop can be located', () => {
    const receiver = javaSource('SmsReceiver.java');
    for (const counter of ['SMS_RECEIVED', 'SMS_KEPT_ON_DEVICE', 'SMS_QUEUED', 'DUPLICATES_IGNORED']) {
      assert.match(receiver, new RegExp(`DeliveryStats\\.${counter}`), counter);
    }
    const outbox = javaSource('SmsOutbox.java');
    for (const counter of ['recordUploadAttempt', 'UPLOADS_ACCEPTED', 'UPLOADS_REJECTED', 'UPLOADS_RETRIED', 'EXPIRED_UNSENT']) {
      assert.match(outbox, new RegExp(counter), counter);
    }
    const stats = javaSource('DeliveryStats.java');
    assert.doesNotMatch(stats, /getMessageBody|getOriginatingAddress/, 'stats hold counts only');
    // The only string kept is the gateway's reason code, and only when it is an UPPER_SNAKE code.
    assert.deepEqual([...stats.matchAll(/putString\((\w+)/g)].map(m => m[1]), ['LAST_UPLOAD_REASON']);
    assert.match(stats, /reasonCode\.matches\("\[A-Z\]\[A-Z0-9_\]\{2,63\}"\)/);
  });

  test('"PAIRED & ACTIVE" is shown only with a running worker and a recent good heartbeat', () => {
    const activity = javaSource('MainActivity.java');
    const active = activity.indexOf('"● STATUS: PAIRED & ACTIVE"');
    assert.ok(active > activity.indexOf('ForegroundService.isRunning()') && active > activity.indexOf('gatewayOk'));
    assert.match(activity, /PAIRED, BACKGROUND WORKER STOPPED/);
    assert.match(activity, /PAIRED, GATEWAY NOT REACHED/);
  });

  test('the foreground service declares only the dataSync type it needs', () => {
    const manifest = read('AndroidManifest.xml');
    assert.match(manifest, /android:foregroundServiceType="dataSync"/);
    assert.doesNotMatch(manifest, /specialUse|FOREGROUND_SERVICE_SPECIAL_USE/);
    assert.equal(fs.readFileSync(path.join(APP_DIR, 'AndroidManifest.xml'))[0], 0x3c, 'no byte-order mark before <?xml');
  });

  test('re-pairing sends a proof for the previous registration instead of leaving it active', () => {
    const client = javaSource('ApiClient.java');
    assert.match(client, /body\.put\("previousProof", calculateHmacSha256\("replace:" \+ oldDeviceId \+ ":" \+ enrollmentToken, oldKey\)\)/);
  });

  test('asks for RECEIVE_SMS only, never the whole inbox', () => {
    const manifest = read('AndroidManifest.xml');
    assert.match(manifest, /android\.permission\.RECEIVE_SMS/);
    assert.doesNotMatch(manifest, /android\.permission\.READ_SMS/);
    assert.doesNotMatch(javaSource('MainActivity.java'), /READ_SMS/);
  });

  test('no button injects a made-up bank credit into the real observation route', () => {
    const activity = javaSource('MainActivity.java');
    assert.doesNotMatch(activity, /credited to your A\/C/i);
    assert.doesNotMatch(activity, /apiClient\.sendSms\(/);
  });

  test('heartbeats are signed with the device key', () => {
    const client = javaSource('ApiClient.java');
    const heartbeat = /public int sendHeartbeatStatus[\s\S]*?\n    }\n/.exec(client)[0];
    assert.match(heartbeat, /calculateHmacSha256\(/);
    assert.match(heartbeat, /postJsonStatus\(endpoint, bodyString, deviceId, tsStr, signature\)/);
  });

  test('the committed network config allows cleartext only to the emulator and loopback', () => {
    const xml = read('res/xml/network_security_config.xml').replace(/<!--[\s\S]*?-->/g, '');
    const domains = [...xml.matchAll(/<domain[^>]*>([^<]+)<\/domain>/g)].map(m => m[1].trim()).sort();
    assert.deepEqual(domains, ['10.0.2.2', '127.0.0.1', 'localhost']);
    assert.match(xml, /<base-config cleartextTrafficPermitted="false">/);
  });

  test('YOUPI_ANDROID_LAN_HOSTS adds exact private LAN hosts to the build copy only', () => {
    assert.deepEqual(parseLanHosts(''), []);
    assert.deepEqual(parseLanHosts(' 192.168.1.128 , 192.168.1.128,10.0.0.4'), ['192.168.1.128', '10.0.0.4']);
    for (const bad of ['8.8.8.8', 'pay.example.com', '192.168.1.300', '172.32.0.1', '0.0.0.0']) {
      assert.throws(() => parseLanHosts(bad), /not a private LAN IPv4/, bad);
    }
    const xml = read('res/xml/network_security_config.xml');
    const built = applyLanHosts(xml, ['192.168.1.128']);
    assert.match(built, /<domain includeSubdomains="false">192\.168\.1\.128<\/domain>/);
    assert.match(built, /<base-config cleartextTrafficPermitted="false">/);
    assert.equal(applyLanHosts(xml, []), xml);
  });
});
