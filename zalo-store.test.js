import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { HISTORY_SEARCH_PAGE, HISTORY_SEARCH_SCAN, openZaloStore } from './zalo-store.js';

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

test('recalled own message stays recalled when the same message is upserted again', (t) => {
  const { store } = withStore(t);
  const own = { ...baseMessage, senderUid: 'account-1', isSelf: true, text: 'định giá tài sản' };
  store.upsertMessage('account-1', own, 'live');
  assert.equal(store.markRecalled('account-1', 'group-1', 1, { msgId: 'm-1', cliMsgId: 'c-1' }), 1);
  store.upsertMessage('account-1', own, 'backfill');
  const [row] = store.getHistory('account-1', 'group-1', 1, 20);
  assert.equal(row.msgType, 'chat.undo');
  assert.equal(row.text, '');
});

test('recalling an own message also blanks its legacy-hermes copy without msgId (and keeps it blank on re-import)', (t) => {
  const { store } = withStore(t);
  const ts = 1_700_000_000_000;
  const live = { ...baseMessage, senderUid: 'account-1', isSelf: true, msgType: 'webchat', text: 'Dạ em gửi sếp bảng giá vàng hôm nay: 1. Vàng nhẫn', ts };
  const legacy = { ...baseMessage, msgId: null, cliMsgId: null, senderUid: 'account-1', isSelf: true, msgType: 'legacy-hermes',
    text: 'Dạ em gửi sếp **bảng giá vàng** hôm nay:\n### 1. Vàng nhẫn', ts: ts - 20_000 };
  const other = { ...legacy, text: 'Một câu trả lời khác của bot', ts: ts - 10_000 };
  store.upsertMessage('account-1', live, 'live');
  store.insertMessages('account-1', [legacy, other], 'legacy-hermes');
  assert.equal(store.markRecalled('account-1', 'group-1', 1, { msgId: 'm-1', cliMsgId: 'c-1' }), 2);
  store.insertMessages('account-1', [legacy], 'legacy-hermes');
  const texts = store.getHistory('account-1', 'group-1', 1, 20).map((m) => m.text);
  assert.ok(texts.every((x) => !x.includes('giá vàng')), JSON.stringify(texts));
  assert.ok(texts.includes('Một câu trả lời khác của bot'));
});

test('legacy copy of a recalled answer imported AFTER the recall is stored blank (tombstone)', (t) => {
  const { store } = withStore(t);
  const ts = 1_700_000_000_000;
  // Tin trực tiếp chỉ là mảnh đầu, ngắn hơn bản Hermes đầy đủ.
  store.upsertMessage('account-1', { ...baseMessage, senderUid: 'account-1', isSelf: true, msgType: 'webchat', text: 'Dạ em gửi sếp bảng giá vàng', ts }, 'live');
  store.markRecalled('account-1', 'group-1', 1, { msgId: 'm-1', cliMsgId: 'c-1' });
  const copy = { ...baseMessage, msgId: null, cliMsgId: null, senderUid: 'account-1', isSelf: true, msgType: 'legacy-hermes',
    text: 'Dạ em gửi sếp **bảng giá vàng** hôm nay và định giá tài sản', ts: ts - 5_000 };
  store.insertMessages('account-1', [copy], 'legacy-hermes');
  const texts = store.getHistory('account-1', 'group-1', 1, 20).map((m) => m.text);
  assert.deepEqual(texts, ['', '']);
});

test('legacy import never overwrites a message captured live', (t) => {
  const { store } = withStore(t);
  store.upsertMessage('account-1', { ...baseMessage, text: 'thu hồi đi em' }, 'live');
  store.insertMessages('account-1', [{ ...baseMessage, msgType: 'legacy-hermes', text: '[Replying to: "bí mật"]\nthu hồi đi em' }], 'legacy-hermes');
  const [row] = store.getHistory('account-1', 'group-1', 1, 20);
  assert.equal(row.text, 'thu hồi đi em');
  assert.equal(row.msgType, 'chat.text');
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

test('audit retention drops audit rows older than auditRetentionDays', (t) => {
  const day = 24 * 60 * 60 * 1000;
  let now = 2_000_000_000_000;
  const { store } = withStore(t, { now: () => now, auditRetentionDays: 90 });
  store.beginAudit({ requestId: 'cu', accountId: 'account-1', actorUid: 'owner', action: 'send', category: 'send' });
  now += 91 * day;
  store.beginAudit({ requestId: 'moi', accountId: 'account-1', actorUid: 'owner', action: 'send', category: 'send' });
  assert.equal(store.pruneAudit(), 1);
  assert.deepEqual([store.getAuditTrail('cu').length, store.getAuditTrail('moi').length], [0, 1]);
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

test('getRange đọc theo khoảng thời gian và lật trang không sót, không lặp', (t) => {
  const { store } = withStore(t);
  const stamps = [1000, 2000, 3000, 3000, 3000, 4000, 9000];
  stamps.forEach((ts, i) => store.upsertMessage('account-1', {
    ...baseMessage, msgId: `m-${i}`, cliMsgId: `c-${i}`, text: `tin ${i}`, ts,
  }, 'live'));
  // Hội thoại khác không được lẫn vào.
  store.upsertMessage('account-1', { ...baseMessage, threadId: 'group-2', msgId: 'x', cliMsgId: 'x', ts: 2500 }, 'live');

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = store.getRange('account-1', 'group-1', 1, { sinceMs: 1500, untilMs: 8000, cursor, limit: 2 });
    seen.push(...page.messages.map((m) => m.text));
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor && pages < 10);

  assert.deepEqual(seen, ['tin 1', 'tin 2', 'tin 3', 'tin 4', 'tin 5']);
  assert.equal(pages, 3);
  assert.equal(store.getRange('account-1', 'group-1', 1, { sinceMs: 99_999 }).messages.length, 0);
});

test('searchHistory: đúng một hội thoại, khớp không dấu, lọc người gửi, bỏ mã đăng nhập và tin thu hồi, giới hạn 40', (t) => {
  const { store } = withStore(t);
  const put = (i, over) => store.upsertMessage('account-1', {
    ...baseMessage, msgId: `s-${i}`, cliMsgId: `sc-${i}`, ts: 1_000 + i, ...over,
  }, 'live');
  put(1, { senderName: 'Cô Lan', text: 'Báo cáo tháng 9.docx\nhttps://f.zdn.vn/x', msgType: 'share.file' });
  put(2, { senderName: 'Minh', text: 'ai gửi bao cao chưa?' });
  put(3, { senderName: 'Bot', isSelf: true, text: 'Mã đăng nhập dashboard: 123456' });
  put(4, { senderName: 'Minh', text: 'báo cáo đây', msgType: 'chat.undo' });
  store.upsertMessage('account-1', { ...baseMessage, threadId: 'group-2', msgId: 'o', cliMsgId: 'o', text: 'Báo cáo nhóm khác', ts: 1_005 }, 'live');

  const hits = store.searchHistory('account-1', 'group-1', 1, { query: 'BAO CAO' });
  assert.deepEqual(hits.messages.map((m) => m.msgId), ['s-1', 's-2']);
  assert.deepEqual(store.searchHistory('account-1', 'group-1', 1, { query: 'bao cao', sender: 'lan' }).messages.map((m) => m.msgId), ['s-1']);
  assert.equal(JSON.stringify(store.searchHistory('account-1', 'group-1', 1, {})).includes('123456'), false);
  assert.deepEqual(store.searchHistory('account-1', 'group-1', 1, { sinceMs: 1_003 }).messages.map((m) => m.msgId), [], "mốc thời gian: chỉ còn tin mã và tin thu hồi — đều bị bỏ");

  for (let i = 10; i < 70; i += 1) put(i, { text: `tin ${i}` });
  const capped = store.searchHistory('account-1', 'group-1', 1, { limit: 999 });
  assert.equal(capped.messages.length, 40);
  assert.equal(capped.messages.at(-1).text, 'tin 69', 'giữ 40 tin MỚI NHẤT, xếp cũ trước');
});

test('searchHistory: quét theo trang, đủ tin thì dừng; không thấy thì dừng ở trần HISTORY_SEARCH_SCAN', (t) => {
  const { store } = withStore(t);
  const n = HISTORY_SEARCH_SCAN + 700;
  store.insertMessages('account-1', Array.from({ length: n }, (_, i) => ({
    ...baseMessage, msgId: `p-${i}`, cliMsgId: `pc-${i}`, ts: 10_000 + Math.floor(i / 3), text: i === 5 ? 'kim trong đáy bể' : `tin ${i}`,
  })));
  const recent = store.searchHistory('account-1', 'group-1', 1, { limit: 10 });
  assert.equal(recent.messages.length, 10);
  assert.ok(recent.scanned <= HISTORY_SEARCH_PAGE, `đủ 10 tin trong trang đầu thì dừng (quét ${recent.scanned})`);
  assert.equal(recent.messages.at(-1).msgId, `p-${n - 1}`);
  const none = store.searchHistory('account-1', 'group-1', 1, { query: 'không có đâu' });
  assert.deepEqual([none.messages.length, none.scanned, none.truncated], [0, HISTORY_SEARCH_SCAN, true]);
  // Cùng mốc giờ nhiều tin (ts trùng): phân trang theo rowid không bỏ sót, không lặp.
  const all = store.searchHistory('account-1', 'group-1', 1, { query: 'tin 4', limit: 40 });
  assert.equal(new Set(all.messages.map((m) => m.msgId)).size, all.messages.length);
  const old = store.searchHistory('account-1', 'group-1', 1, { query: 'kim', sinceMs: 0 });
  assert.deepEqual(old.messages, [], 'tin quá xa ngoài trần quét');
});
