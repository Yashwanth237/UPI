import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  Database,
  runMigrations,
  PaymentSessionRepository,
  ReceivingAccountRepository
} from '@youpi/db';
import { QueueEngine } from '../index.js';
import { PaymentStatus } from '@youpi/common';

const ACCOUNT_ID = '00000000-0000-0000-0000-000000000002';

describe('Queue fairness: a vacant slot goes to the head of the queue, never to a newcomer', () => {
  let db;
  let sessionRepo;
  let queueEngine;
  let merchantId;
  let events;

  function newSession(orderId) {
    return sessionRepo.create({ merchantId, orderId, amountPaise: 10000n, receivingAccountId: ACCOUNT_ID });
  }

  beforeEach(() => {
    db = new Database({ inMemory: true });
    merchantId = runMigrations(db).defaultMerchant.id;
    sessionRepo = new PaymentSessionRepository(db);
    events = [];
    queueEngine = new QueueEngine({
      sessionRepo,
      accountRepo: new ReceivingAccountRepository(db),
      eventEmitter: { emit: (event, payload) => events.push({ event, payload }) }
    });
  });

  test('a newcomer arriving after the slot frees (but before promotion) queues behind waiting customers', () => {
    const first = newSession('FAIR-1');
    const waiting = newSession('FAIR-2');
    assert.equal(queueEngine.enqueueOrActivate(first.id, ACCOUNT_ID).status, PaymentStatus.ACTIVE);
    assert.equal(queueEngine.enqueueOrActivate(waiting.id, ACCOUNT_ID).status, PaymentStatus.QUEUED);

    // The slot is released without promoteNext having run yet (the race window).
    sessionRepo.transitionToTerminal(first.id, PaymentStatus.CANCELLED);

    const newcomer = newSession('FAIR-3');
    const result = queueEngine.enqueueOrActivate(newcomer.id, ACCOUNT_ID);

    assert.equal(result.status, PaymentStatus.QUEUED, 'newcomer must not overtake a waiting customer');
    assert.equal(sessionRepo.findById(waiting.id).status, PaymentStatus.ACTIVE, 'the waiting customer is promoted instead');
    assert.equal(sessionRepo.findById(newcomer.id).queuePosition, 1, 'newcomer is now first in line');
    assert.ok(events.some(e => e.event === 'SESSION.ACTIVATED' && e.payload.sessionId === waiting.id));
  });

  test('the head of the queue itself may take the vacant slot', () => {
    const first = newSession('FAIR-A');
    const head = newSession('FAIR-B');
    queueEngine.enqueueOrActivate(first.id, ACCOUNT_ID);
    queueEngine.enqueueOrActivate(head.id, ACCOUNT_ID);
    sessionRepo.transitionToTerminal(first.id, PaymentStatus.CANCELLED);

    assert.equal(queueEngine.enqueueOrActivate(head.id, ACCOUNT_ID).status, PaymentStatus.ACTIVE);
  });

  test('with an empty queue a vacant slot is granted immediately', () => {
    const only = newSession('FAIR-SOLO');
    assert.equal(queueEngine.enqueueOrActivate(only.id, ACCOUNT_ID).status, PaymentStatus.ACTIVE);
  });

  test('re-activating an already ACTIVE session is idempotent and does not demote it', () => {
    const s = newSession('FAIR-IDEMP');
    queueEngine.enqueueOrActivate(s.id, ACCOUNT_ID);
    assert.equal(queueEngine.enqueueOrActivate(s.id, ACCOUNT_ID).status, PaymentStatus.ACTIVE);
  });
});
