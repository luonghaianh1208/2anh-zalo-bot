import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { openZaloStore } from './zalo-store.js';

function withStore(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zalo-store-'));
  const path = join(dir, 'history.sqlite');
  const store = openZaloStore({ path, ...options });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, path };
}

const baseMessage = {
  threadId: 'group-1',
  threadType: 1,
  msgId: 'm-1',
  cliMsgId: 'c-1',
  senderUid: 'user-1',
  senderName: 'Người gửi',
  text: 'xin chào',
  msgType: 'chat.text',
  ts: 1_700_000_000_000,
  isSelf: false,
};

test('message upsert deduplicates live and backfill copies', (t) => {
  const { store } = withStore(t);

  assert.equal(store.upsertMessage('account-1', baseMessage, 'live').inserted, true);
  assert.equal(store.upsertMessage('account-1', { ...baseMessage, text: 'bản đầy đủ' }, 'backfill').inserted, false);

  const rows = store.getHistory('account-1', 'group-1', 1, 20);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, 'bản đầy đủ');
  assert.equal(rows[0].msgId, 'm-1');
});

test('message upsert merges a legacy msgId with a later backfill cliMsgId', (t) => {
  const { store } = withStore(t);
  store.upsertMessage('bot', {
    threadId: 'g1', threadType: 1, msgId: 'm1', senderUid: '', senderName: 'Anh',
    text: 'nội dung cũ', msgType: 'legacy', ts: 1000, isSelf: false,
  }, 'legacy-hermes');
  const result = store.upsertMessage('bot', {
    threadId: 'g1', threadType: 1, msgId: 'm1', cliMsgId: 'c1', senderUid: 'u1',
    senderName: 'Anh', text: 'nội dung gốc', msgType: 'webchat', ts: 1000, isSelf: false,
  }, 'backfill');

  assert.equal(result.inserted, false);
  assert.equal(store.getHealth().messageCount, 1);
  assert.deepEqual(store.getHistory('bot', 'g1', 1, 1)[0], {
    threadId: 'g1', threadType: 1, msgId: 'm1', cliMsgId: 'c1', senderUid: 'u1',
    senderName: 'Anh', text: 'nội dung gốc', msgType: 'webchat', ts: 1000,
    isSelf: false, source: 'backfill',
  });
});

test('opening the store repairs duplicate legacy rows that share a Zalo message id', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'zalo-store-repair-'));
  const path = join(dir, 'history.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const initial = openZaloStore({ path });
  initial.close();
  const raw = new DatabaseSync(path);
  raw.exec('DROP INDEX idx_messages_msg_alias; DROP INDEX idx_messages_cli_alias;');
  const insert = raw.prepare(`
    INSERT INTO messages (
      identity_key, account_id, thread_id, thread_type, msg_id, cli_msg_id,
      sender_uid, sender_name, text, msg_type, timestamp_ms, is_self, source,
      created_at_ms, updated_at_ms
    ) VALUES (?, 'bot', 'g1', 1, 'm1', ?, 'bot', '', 'same message', ?, 1000, 1, ?, 1000, 1000)
  `);
  insert.run('legacy-without-cli', null, 'chat.text', 'outbound');
  insert.run('live-with-cli', 'c1', 'webchat', 'live');
  raw.close();

  const repaired = openZaloStore({ path });
  assert.equal(repaired.getHealth().messageCount, 1);
  assert.deepEqual(repaired.getHistory('bot', 'g1', 1, 10)[0], {
    threadId: 'g1', threadType: 1, msgId: 'm1', cliMsgId: 'c1', senderUid: 'bot',
    senderName: '', text: 'same message', msgType: 'webchat', ts: 1000,
    isSelf: true, source: 'live',
  });
  repaired.close();
});

test('history returns the newest requested rows in chronological order', (t) => {
  const { store } = withStore(t);
  for (let index = 1; index <= 4; index += 1) {
    store.upsertMessage('account-1', {
      ...baseMessage,
      msgId: `m-${index}`,
      cliMsgId: `c-${index}`,
      text: `tin ${index}`,
      ts: baseMessage.ts + index,
    }, 'live');
  }

  assert.deepEqual(
    store.getHistory('account-1', 'group-1', 1, 2).map((row) => row.text),
    ['tin 3', 'tin 4'],
  );
});

test('history survives closing and reopening the SQLite file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'zalo-store-reopen-'));
  const path = join(dir, 'history.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = openZaloStore({ path });
  first.upsertMessage('account-1', baseMessage, 'live');
  first.close();

  const second = openZaloStore({ path });
  assert.equal(second.getHistory('account-1', 'group-1', 1, 10)[0].text, 'xin chào');
  second.close();
});

test('findOwnMessage never selects another sender message', (t) => {
  const { store } = withStore(t);
  store.upsertMessage('account-1', baseMessage, 'live');
  store.upsertMessage('account-1', {
    ...baseMessage,
    msgId: 'm-self',
    cliMsgId: 'c-self',
    senderUid: 'account-1',
    isSelf: true,
    ts: baseMessage.ts + 10,
  }, 'outbound');

  assert.equal(store.findOwnMessage('account-1', 'group-1', 1).msgId, 'm-self');
  assert.equal(store.findOwnMessage('account-1', 'group-1', 1, {
    msgId: 'm-1', cliMsgId: 'c-1',
  }), null);
});

test('retention prunes messages older than 365 days but leaves audit records', (t) => {
  const day = 24 * 60 * 60 * 1000;
  const now = 2_000_000_000_000;
  const { store } = withStore(t, { now: () => now, retentionDays: 365 });
  store.upsertMessage('account-1', {
    ...baseMessage, msgId: 'old', cliMsgId: 'old-c', ts: now - 366 * day,
  }, 'live');
  store.upsertMessage('account-1', {
    ...baseMessage, msgId: 'kept', cliMsgId: 'kept-c', ts: now - 364 * day,
  }, 'live');
  store.beginAudit({ requestId: 'r-1', accountId: 'account-1', actorUid: 'owner', action: 'send', category: 'send' });
  store.finishAudit('r-1', 'succeeded');

  assert.equal(store.pruneMessages(), 1);
  assert.deepEqual(store.getHistory('account-1', 'group-1', 1, 10).map((row) => row.msgId), ['kept']);
  assert.equal(store.getAuditTrail('r-1').length, 2);
});

test('audit trail stores attempted and one terminal result with the same request id', (t) => {
  const { store } = withStore(t);
  store.beginAudit({
    requestId: 'req-7', accountId: 'account-1', actorUid: 'owner-1', actorRole: 'owner',
    action: 'removeUserFromGroup', category: 'admin', threadId: 'group-1', threadType: 1,
    targetSummary: { userCount: 2 },
  });
  store.finishAudit('req-7', 'failed', { error: 'network unavailable' });

  const rows = store.getAuditTrail('req-7');
  assert.deepEqual(rows.map((row) => row.status), ['attempted', 'failed']);
  assert.equal(rows[0].actorUid, 'owner-1');
  assert.deepEqual(rows[0].targetSummary, { userCount: 2 });
  assert.equal(rows[1].error, 'network unavailable');
});

test('backfill checkpoint persists progress and failure details', (t) => {
  const { store } = withStore(t);
  store.saveBackfillState({
    accountId: 'account-1', threadType: 1, cursorMsgId: 'm-90', status: 'failed',
    pagesFetched: 3, messagesInserted: 42, error: 'timeout',
  });

  const state = store.getBackfillState('account-1', 1);
  assert.deepEqual({ ...state, updatedAtMs: 0 }, {
    accountId: 'account-1', threadType: 1, cursorMsgId: 'm-90', status: 'failed',
    pagesFetched: 3, messagesInserted: 42, error: 'timeout', updatedAtMs: 0,
  });
  assert.equal(Number.isFinite(state.updatedAtMs), true);
});

test('health counts messages and audit rows without exposing message content', (t) => {
  const { store } = withStore(t);
  store.upsertMessage('account-1', baseMessage, 'live');
  store.beginAudit({ requestId: 'r-health', accountId: 'account-1', actorUid: 'owner', action: 'send', category: 'send' });

  const health = store.getHealth();
  assert.equal(health.ready, true);
  assert.equal(health.messageCount, 1);
  assert.equal(health.auditCount, 1);
  assert.equal(JSON.stringify(health).includes('xin chào'), false);
});
