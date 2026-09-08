import { createHash } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DAY_MS = 24 * 60 * 60 * 1000;

function text(value) {
  return value == null ? '' : String(value);
}

function nullableText(value) {
  return value == null || value === '' ? null : String(value);
}

function messageKey(accountId, message) {
  const msgId = nullableText(message.msgId);
  const cliMsgId = nullableText(message.cliMsgId);
  if (msgId || cliMsgId) {
    return [accountId, message.threadType, message.threadId, msgId || '', cliMsgId || ''].join(':');
  }
  return createHash('sha256').update(JSON.stringify([
    accountId, Number(message.threadType), text(message.threadId), text(message.senderUid),
    Number(message.ts) || 0, text(message.msgType), text(message.text),
  ])).digest('hex');
}

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function mapMessage(row) {
  return {
    threadId: row.thread_id,
    threadType: row.thread_type,
    msgId: row.msg_id,
    cliMsgId: row.cli_msg_id,
    senderUid: row.sender_uid,
    senderName: row.sender_name,
    text: row.text,
    msgType: row.msg_type,
    ts: row.timestamp_ms,
    isSelf: Boolean(row.is_self),
    source: row.source,
  };
}

function repairDuplicateAliases(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const column of ['msg_id', 'cli_msg_id']) {
      const duplicates = db.prepare(`
        SELECT account_id, thread_id, thread_type, ${column} AS alias
        FROM messages
        WHERE ${column} IS NOT NULL AND ${column} <> ''
        GROUP BY account_id, thread_id, thread_type, ${column}
        HAVING COUNT(*) > 1
      `).all();
      const selectRows = db.prepare(`
        SELECT * FROM messages
        WHERE account_id = ? AND thread_id = ? AND thread_type = ? AND ${column} = ?
        ORDER BY
          (cli_msg_id IS NOT NULL AND cli_msg_id <> '') DESC,
          (msg_id IS NOT NULL AND msg_id <> '') DESC,
          (source = 'live') DESC,
          LENGTH(text) DESC,
          updated_at_ms DESC
      `);
      const updateWinner = db.prepare(`
        UPDATE messages SET
          msg_id = ?, cli_msg_id = ?, sender_uid = ?, sender_name = ?, text = ?,
          msg_type = ?, timestamp_ms = ?, is_self = ?, source = ?,
          created_at_ms = ?, updated_at_ms = ?
        WHERE identity_key = ?
      `);
      const deleteRow = db.prepare('DELETE FROM messages WHERE identity_key = ?');

      for (const duplicate of duplicates) {
        const rows = selectRows.all(
          duplicate.account_id, duplicate.thread_id, duplicate.thread_type, duplicate.alias,
        );
        const winner = rows[0];
        const longestText = [...rows].sort((left, right) => right.text.length - left.text.length)[0].text;
        const firstText = (field) => rows.find((row) => row[field])?.[field] || '';
        updateWinner.run(
          firstText('msg_id') || null,
          firstText('cli_msg_id') || null,
          firstText('sender_uid'),
          firstText('sender_name'),
          longestText,
          firstText('msg_type'),
          winner.timestamp_ms,
          rows.some((row) => row.is_self) ? 1 : 0,
          rows.some((row) => row.source === 'live') ? 'live' : winner.source,
          Math.min(...rows.map((row) => row.created_at_ms)),
          Math.max(...rows.map((row) => row.updated_at_ms)),
          winner.identity_key,
        );
        for (const loser of rows.slice(1)) deleteRow.run(loser.identity_key);
      }
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_msg_alias
        ON messages(account_id, thread_id, thread_type, msg_id)
        WHERE msg_id IS NOT NULL AND msg_id <> '';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_cli_alias
        ON messages(account_id, thread_id, thread_type, cli_msg_id)
        WHERE cli_msg_id IS NOT NULL AND cli_msg_id <> '';
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function openZaloStore({ path, retentionDays = 365, now = Date.now } = {}) {
  if (!path) throw new Error('SQLite path is required');
  const databasePath = resolve(path);
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS messages (
      identity_key TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      thread_type INTEGER NOT NULL,
      msg_id TEXT,
      cli_msg_id TEXT,
      sender_uid TEXT NOT NULL DEFAULT '',
      sender_name TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      msg_type TEXT NOT NULL DEFAULT '',
      timestamp_ms INTEGER NOT NULL,
      is_self INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread_time
      ON messages(account_id, thread_type, thread_id, timestamp_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_retention ON messages(timestamp_ms);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      account_id TEXT NOT NULL DEFAULT '',
      actor_uid TEXT NOT NULL DEFAULT '',
      actor_role TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      category TEXT NOT NULL,
      thread_id TEXT NOT NULL DEFAULT '',
      thread_type INTEGER,
      status TEXT NOT NULL,
      target_summary TEXT,
      error TEXT,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_log(request_id, id);
    CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at_ms DESC);

    CREATE TABLE IF NOT EXISTS backfill_state (
      account_id TEXT NOT NULL,
      thread_type INTEGER NOT NULL,
      cursor_msg_id TEXT,
      status TEXT NOT NULL,
      pages_fetched INTEGER NOT NULL DEFAULT 0,
      messages_inserted INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(account_id, thread_type)
    );
  `);
  repairDuplicateAliases(db);

  const upsertMessageStatement = db.prepare(`
    INSERT INTO messages (
      identity_key, account_id, thread_id, thread_type, msg_id, cli_msg_id,
      sender_uid, sender_name, text, msg_type, timestamp_ms, is_self, source,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(identity_key) DO UPDATE SET
      msg_id = COALESCE(excluded.msg_id, messages.msg_id),
      cli_msg_id = COALESCE(excluded.cli_msg_id, messages.cli_msg_id),
      sender_uid = excluded.sender_uid,
      sender_name = excluded.sender_name,
      text = excluded.text,
      msg_type = excluded.msg_type,
      timestamp_ms = excluded.timestamp_ms,
      is_self = excluded.is_self,
      source = CASE WHEN messages.source = 'live' THEN messages.source ELSE excluded.source END,
      updated_at_ms = excluded.updated_at_ms
  `);

  function upsertMessage(accountId, message, source = 'live') {
    const timestamp = Number(message.ts);
    if (!accountId || !message?.threadId || !Number.isFinite(timestamp)) {
      throw new Error('Message requires accountId, threadId, and numeric ts');
    }
    const currentTime = Number(now());
    const msgId = nullableText(message.msgId);
    const cliMsgId = nullableText(message.cliMsgId);
    const alias = db.prepare(`
      SELECT identity_key FROM messages
      WHERE account_id = ? AND thread_id = ? AND thread_type = ?
        AND ((? IS NOT NULL AND msg_id = ?) OR (? IS NOT NULL AND cli_msg_id = ?))
      ORDER BY rowid LIMIT 1
    `).get(
      String(accountId), String(message.threadId), Number(message.threadType),
      msgId, msgId, cliMsgId, cliMsgId,
    );
    const generatedIdentityKey = messageKey(String(accountId), message);
    const identityKey = alias?.identity_key || generatedIdentityKey;
    const existed = Boolean(alias || db.prepare('SELECT 1 FROM messages WHERE identity_key = ?').get(identityKey));
    upsertMessageStatement.run(
      identityKey, String(accountId), String(message.threadId),
      Number(message.threadType), msgId, cliMsgId,
      text(message.senderUid), text(message.senderName), text(message.text), text(message.msgType),
      timestamp, message.isSelf ? 1 : 0, String(source), currentTime, currentTime,
    );
    return { inserted: !existed };
  }

  function insertMessages(accountId, messages, source = 'backfill') {
    db.exec('BEGIN IMMEDIATE');
    let inserted = 0;
    try {
      for (const message of messages) {
        if (upsertMessage(accountId, message, source).inserted) inserted += 1;
      }
      db.exec('COMMIT');
      return inserted;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function getHistory(accountId, threadId, threadType, count = 30) {
    const safeCount = Math.min(Math.max(Number(count) || 30, 1), 100);
    const rows = db.prepare(`
      SELECT * FROM messages
      WHERE account_id = ? AND thread_id = ? AND thread_type = ?
      ORDER BY timestamp_ms DESC, rowid DESC LIMIT ?
    `).all(String(accountId), String(threadId), Number(threadType), safeCount);
    return rows.reverse().map(mapMessage);
  }

  function findOwnMessage(accountId, threadId, threadType, ids = null) {
    const conditions = [
      'account_id = ?', 'thread_id = ?', 'thread_type = ?', 'is_self = 1',
      'msg_id IS NOT NULL', 'cli_msg_id IS NOT NULL',
    ];
    const params = [String(accountId), String(threadId), Number(threadType)];
    if (ids) {
      conditions.push('msg_id = ?', 'cli_msg_id = ?');
      params.push(String(ids.msgId), String(ids.cliMsgId));
    }
    const row = db.prepare(`
      SELECT * FROM messages WHERE ${conditions.join(' AND ')}
      ORDER BY timestamp_ms DESC, rowid DESC LIMIT 1
    `).get(...params);
    return row ? mapMessage(row) : null;
  }

  function pruneMessages() {
    const cutoff = Number(now()) - Number(retentionDays) * DAY_MS;
    return Number(db.prepare('DELETE FROM messages WHERE timestamp_ms < ?').run(cutoff).changes);
  }

  function beginAudit(entry) {
    if (!entry?.requestId || !entry?.action || !entry?.category) {
      throw new Error('Audit requires requestId, action, and category');
    }
    db.prepare(`
      INSERT INTO audit_log (
        request_id, account_id, actor_uid, actor_role, action, category,
        thread_id, thread_type, status, target_summary, error, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'attempted', ?, NULL, ?)
    `).run(
      String(entry.requestId), text(entry.accountId), text(entry.actorUid), text(entry.actorRole),
      String(entry.action), String(entry.category), text(entry.threadId),
      entry.threadType == null ? null : Number(entry.threadType),
      entry.targetSummary ? JSON.stringify(entry.targetSummary) : null, Number(now()),
    );
  }

  function finishAudit(requestId, status, detail = {}) {
    if (!['succeeded', 'failed'].includes(status)) throw new Error('Invalid terminal audit status');
    const attempted = db.prepare(`
      SELECT * FROM audit_log WHERE request_id = ? AND status = 'attempted'
      ORDER BY id DESC LIMIT 1
    `).get(String(requestId));
    if (!attempted) throw new Error(`No attempted audit record for ${requestId}`);
    const terminal = db.prepare(`
      SELECT id FROM audit_log WHERE request_id = ? AND status IN ('succeeded', 'failed') LIMIT 1
    `).get(String(requestId));
    if (terminal) return false;
    db.prepare(`
      INSERT INTO audit_log (
        request_id, account_id, actor_uid, actor_role, action, category,
        thread_id, thread_type, status, target_summary, error, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attempted.request_id, attempted.account_id, attempted.actor_uid, attempted.actor_role,
      attempted.action, attempted.category, attempted.thread_id, attempted.thread_type,
      status, attempted.target_summary, nullableText(detail.error), Number(now()),
    );
    return true;
  }

  function getAuditTrail(requestId) {
    return db.prepare('SELECT * FROM audit_log WHERE request_id = ? ORDER BY id').all(String(requestId)).map((row) => ({
      requestId: row.request_id,
      accountId: row.account_id,
      actorUid: row.actor_uid,
      actorRole: row.actor_role,
      action: row.action,
      category: row.category,
      threadId: row.thread_id,
      threadType: row.thread_type,
      status: row.status,
      targetSummary: parseJson(row.target_summary),
      error: row.error,
      createdAtMs: row.created_at_ms,
    }));
  }

  function saveBackfillState(state) {
    db.prepare(`
      INSERT INTO backfill_state (
        account_id, thread_type, cursor_msg_id, status, pages_fetched,
        messages_inserted, error, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, thread_type) DO UPDATE SET
        cursor_msg_id = excluded.cursor_msg_id,
        status = excluded.status,
        pages_fetched = excluded.pages_fetched,
        messages_inserted = excluded.messages_inserted,
        error = excluded.error,
        updated_at_ms = excluded.updated_at_ms
    `).run(
      String(state.accountId), Number(state.threadType), nullableText(state.cursorMsgId),
      String(state.status), Number(state.pagesFetched) || 0, Number(state.messagesInserted) || 0,
      nullableText(state.error), Number(now()),
    );
  }

  function getBackfillState(accountId, threadType) {
    const row = db.prepare('SELECT * FROM backfill_state WHERE account_id = ? AND thread_type = ?')
      .get(String(accountId), Number(threadType));
    return row ? {
      accountId: row.account_id,
      threadType: row.thread_type,
      cursorMsgId: row.cursor_msg_id,
      status: row.status,
      pagesFetched: row.pages_fetched,
      messagesInserted: row.messages_inserted,
      error: row.error,
      updatedAtMs: row.updated_at_ms,
    } : null;
  }

  function getHealth() {
    const messageCount = Number(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count);
    const auditCount = Number(db.prepare('SELECT COUNT(*) AS count FROM audit_log').get().count);
    let databaseSizeBytes = 0;
    try { databaseSizeBytes = statSync(databasePath).size; } catch { /* database is still ready */ }
    return { ready: true, databaseSizeBytes, messageCount, auditCount };
  }

  return {
    upsertMessage,
    insertMessages,
    getHistory,
    findOwnMessage,
    pruneMessages,
    beginAudit,
    finishAudit,
    getAuditTrail,
    saveBackfillState,
    getBackfillState,
    getHealth,
    close: () => db.close(),
  };
}
