import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WhatsAppBerryService } from '../services/whatsapp-berry.service.js';

/** A linked (creds on disk) service whose initialize() reconnects after `delayMs` with `client`. */
function linkedService(dir, client, delayMs = 300) {
  const svc = new WhatsAppBerryService({
    sessionId: 'sess',
    sessionPath: dir,
    databasePath: path.join(dir, 'store.db'),
    metaFile: path.join(dir, 'meta.json')
  });
  svc.forceRealDispatch = true;
  svc.initialize = async () => {
    svc.isInitializing = true;
    setTimeout(() => { svc.client = client; svc.status = 'CONNECTED'; svc.isInitializing = false; }, delayMs);
  };
  return svc;
}

describe('WhatsApp OTP send survives a short connection drop', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-reconnect-'));
    fs.mkdirSync(path.join(dir, 'sess'));
    fs.writeFileSync(path.join(dir, 'sess', 'creds.json'), '{}');
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('a send during an in-progress reconnect waits for it instead of failing', async () => {
    const sent = [];
    const svc = linkedService(dir, { sendText: async (jid, text) => { sent.push({ jid, text }); return { id: 'm1' }; } });
    svc.status = 'DISCONNECTED';
    svc.isInitializing = true; // the 3s auto-reconnect is already running
    setTimeout(() => { svc.client = { sendText: async (jid, text) => { sent.push({ jid, text }); return { id: 'm1' }; } }; svc.status = 'CONNECTED'; svc.isInitializing = false; }, 300);

    const result = await svc.sendOtp('9876543210', '482913', 'Asha');
    assert.equal(result.delivered, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].jid, '919876543210@s.whatsapp.net');
  });

  test('a socket that breaks mid-send is reconnected and the message retried once', async () => {
    let calls = 0;
    const flaky = { sendText: async () => { calls++; if (calls === 1) throw new Error('Connection Closed'); return { id: 'm2' }; } };
    const svc = linkedService(dir, flaky);
    svc.client = flaky;
    svc.status = 'CONNECTED';

    const result = await svc.sendOtp('9876543210', '482913');
    assert.equal(result.delivered, true);
    assert.equal(calls, 2);
  });

  test('a session that never comes back still fails honestly', async () => {
    const svc = linkedService(dir, null, 60_000);
    svc.status = 'DISCONNECTED';
    svc.waitForConnected = async () => false; // skip the real 10s wait
    const result = await svc.sendOtp('9876543210', '482913');
    assert.equal(result.delivered, false);
    assert.equal(result.success, false);
  });
});
