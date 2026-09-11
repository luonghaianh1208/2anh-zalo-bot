import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeHealth } from './runtime-health.js';

test('health snapshot combines Zalo, bridge, database, traffic, and backfill state', () => {
  let current = 1_000_000;
  const store = { getHealth: () => ({ ready: true, databaseSizeBytes: 4096, messageCount: 12, auditCount: 8 }) };
  const health = createRuntimeHealth({ store, now: () => current, staleAfterMs: 45_000 });
  health.setZaloState('logged-in', { userId: 'bot-1', displayName: 'Lăng Tiêu' });
  health.bridgeConnected('client-1');
  health.bridgeHeartbeat('client-1');
  health.markInbound();
  current += 250;
  health.markOutbound();
  health.setBackfill({ threadType: 1, status: 'running', pagesFetched: 2, messagesInserted: 30 });

  const snapshot = health.snapshot();
  assert.equal(snapshot.status, 'healthy');
  assert.equal(snapshot.zalo.status, 'logged-in');
  assert.equal(snapshot.bridge.attachedClients, 1);
  assert.equal(snapshot.bridge.heartbeatAgeMs, 250);
  assert.equal(snapshot.database.messageCount, 12);
  assert.equal(snapshot.database.auditCount, 8);
  assert.equal(snapshot.backfill[0].pagesFetched, 2);
  assert.equal(snapshot.traffic.lastInboundAtMs, 1_000_000);
  assert.equal(snapshot.traffic.lastOutboundAtMs, 1_000_250);
});

test('stale bridge clients degrade health and are returned for cleanup', () => {
  let current = 2_000_000;
  const health = createRuntimeHealth({
    store: { getHealth: () => ({ ready: true, messageCount: 0, auditCount: 0, databaseSizeBytes: 0 }) },
    now: () => current,
    staleAfterMs: 45_000,
  });
  health.setZaloState('logged-in');
  health.bridgeConnected('fresh');
  health.bridgeConnected('stale');
  current += 30_000;
  health.bridgeHeartbeat('fresh');
  current += 16_000;

  assert.deepEqual(health.staleClientIds(), ['stale']);
  assert.equal(health.snapshot().status, 'degraded');
});

test('latest error is redacted before reaching the dashboard', () => {
  const health = createRuntimeHealth({
    store: { getHealth: () => ({ ready: true, messageCount: 0, auditCount: 0, databaseSizeBytes: 0 }) },
    now: () => 3_000_000,
  });
  health.recordError('bridge_failure', 'token=very-secret at E:\\Hermes\\private\\file.txt');

  const serialized = JSON.stringify(health.snapshot().lastError);
  assert.equal(serialized.includes('very-secret'), false);
  assert.equal(serialized.includes('E:\\Hermes'), false);
  assert.equal(health.snapshot().lastError.code, 'bridge_failure');
});

test('Zalo listener không kết nối thì health báo degraded dù vẫn đăng nhập', () => {
  const health = createRuntimeHealth({
    store: { getHealth: () => ({ ready: true, messageCount: 0, auditCount: 0, databaseSizeBytes: 0 }) },
    now: () => 5_000_000,
  });
  health.setZaloState('logged-in', { userId: 'bot-1' });
  health.bridgeConnected('client-1');
  health.setListenerState('connected');
  assert.equal(health.snapshot().status, 'healthy');
  assert.equal(health.snapshot().zalo.listener, 'connected');

  health.setListenerState('closed');
  assert.equal(health.snapshot().status, 'degraded');
  assert.equal(health.snapshot().zalo.listener, 'closed');
});

test('database failure marks health unhealthy without throwing from snapshot', () => {
  const health = createRuntimeHealth({
    store: { getHealth: () => { throw new Error('database closed'); } },
    now: () => 4_000_000,
  });
  health.setZaloState('logged-in');

  const snapshot = health.snapshot();
  assert.equal(snapshot.status, 'unhealthy');
  assert.equal(snapshot.database.ready, false);
});
