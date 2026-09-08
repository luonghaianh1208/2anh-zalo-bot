import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openZaloStore } from './zalo-store.js';
import { importLegacyHermesHistory } from './legacy-history-import.js';

function legacyDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT, session_key TEXT, chat_id TEXT,
      chat_type TEXT, user_id TEXT, display_name TEXT, origin_json TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
      platform_message_id TEXT, timestamp REAL
    );
    CREATE TABLE delivery_obligations (
      platform TEXT, state TEXT, session_key TEXT, chat_id TEXT, content TEXT
    );
  `);
  db.prepare(`INSERT INTO sessions VALUES (?, 'zalo', ?, ?, ?, ?, ?, ?)`)
    .run('s1', 'agent:main:zalo:group:g1', 'g1', 'group', 'last-user', 'Nhóm Một', '{}');
  db.prepare(`INSERT INTO sessions VALUES (?, 'telegram', ?, ?, ?, ?, ?, ?)`)
    .run('s2', 'agent:main:telegram:dm:t1', 't1', 'dm', 'tg-user', 'Telegram', '{}');
  return db;
}

test('legacy import keeps real Zalo dialogue and excludes internal or undelivered rows', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'zalo-legacy-import-'));
  const sourcePath = join(dir, 'state.db');
  const source = legacyDatabase(sourcePath);
  const insert = source.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)');
  insert.run(1, 's1', 'user', '[Ngữ cảnh gần nhất trong nhóm Zalo]\n- cũ\n\n[New message]\n[Anh] đọc file này', '101', 1_788_000_001);
  insert.run(2, 's1', 'assistant', 'Bản trả lời đã giao', null, 1_788_000_002);
  insert.run(3, 's1', 'assistant', 'Bản trả lời bị lỗi', null, 1_788_000_003);
  insert.run(4, 's1', 'assistant', '', null, 1_788_000_004);
  insert.run(5, 's1', 'tool', '{"secret":"internal"}', null, 1_788_000_005);
  insert.run(6, 's2', 'user', '[Anh] telegram không được nhập', '201', 1_788_000_006);
  source.prepare("INSERT INTO delivery_obligations VALUES ('zalo','delivered',?,?,?)")
    .run('agent:main:zalo:group:g1', 'g1', 'Bản trả lời đã giao');
  source.prepare("INSERT INTO delivery_obligations VALUES ('zalo','failed',?,?,?)")
    .run('agent:main:zalo:group:g1', 'g1', 'Bản trả lời bị lỗi');
  source.close();

  const store = openZaloStore({ path: join(dir, 'zalo.sqlite') });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const result = importLegacyHermesHistory({
    sourcePath, store, accountId: 'bot', now: () => 1_788_100_000_000,
  });

  assert.deepEqual(result, { scanned: 2, inserted: 2, skipped: 0 });
  const history = store.getHistory('bot', 'g1', 1, 10);
  assert.deepEqual(history.map((message) => message.text), ['đọc file này', 'Bản trả lời đã giao']);
  assert.equal(history[0].senderName, 'Anh');
  assert.equal(history[0].isSelf, false);
  assert.equal(history[1].isSelf, true);
  assert.equal(history[1].msgId, null);

  assert.deepEqual(
    importLegacyHermesHistory({ sourcePath, store, accountId: 'bot', now: () => 1_788_100_000_000 }),
    { scanned: 2, inserted: 0, skipped: 2 },
  );
});

test('legacy import applies the 365-day retention boundary', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'zalo-legacy-retention-'));
  const sourcePath = join(dir, 'state.db');
  const source = legacyDatabase(sourcePath);
  const nowMs = 1_800_000_000_000;
  source.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)')
    .run(1, 's1', 'user', '[Anh] quá cũ', 'old', (nowMs - 366 * 86_400_000) / 1000);
  source.close();
  const store = openZaloStore({ path: join(dir, 'zalo.sqlite') });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.deepEqual(importLegacyHermesHistory({ sourcePath, store, accountId: 'bot', now: () => nowMs }), {
    scanned: 0, inserted: 0, skipped: 0,
  });
  assert.equal(store.getHealth().messageCount, 0);
});
