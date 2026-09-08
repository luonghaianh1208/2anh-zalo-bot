import { DatabaseSync } from 'node:sqlite';

const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return null;
  return timestamp < 10_000_000_000 ? Math.round(timestamp * 1000) : Math.round(timestamp);
}

function normalizeInboundContent(value) {
  let text = String(value || '').trim();
  const marker = '[New message]';
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex >= 0) text = text.slice(markerIndex + marker.length).trim();
  const speaker = text.match(/^\[([^\]\n]+)\]\s*([\s\S]*)$/);
  if (!speaker) return { senderName: '', text };
  return { senderName: speaker[1].trim(), text: speaker[2].trim() };
}

export function importLegacyHermesHistory({
  sourcePath, store, accountId, retentionDays = 365, now = Date.now,
} = {}) {
  if (!sourcePath || !store || !accountId) {
    throw new Error('Legacy import requires sourcePath, store, and accountId');
  }
  const cutoffSeconds = (Number(now()) - Number(retentionDays) * DAY_MS) / 1000;
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const rows = source.prepare(`
      SELECT m.id, m.role, m.content, m.platform_message_id, m.timestamp,
             s.session_key, s.chat_id, s.chat_type, s.user_id, s.display_name
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      WHERE s.source = 'zalo'
        AND m.role IN ('user', 'assistant')
        AND TRIM(COALESCE(m.content, '')) <> ''
        AND m.timestamp >= ?
        AND (
          m.role = 'user'
          OR EXISTS (
            SELECT 1 FROM delivery_obligations d
            WHERE d.platform = 'zalo' AND d.state = 'delivered'
              AND d.session_key = s.session_key AND d.chat_id = s.chat_id
              AND d.content = m.content
          )
        )
      ORDER BY m.timestamp, m.id
    `).all(cutoffSeconds);

    const messages = rows.map((row) => {
      const inbound = row.role === 'user' ? normalizeInboundContent(row.content) : null;
      return {
        threadId: String(row.chat_id),
        threadType: row.chat_type === 'group' ? 1 : 0,
        msgId: row.role === 'user' && row.platform_message_id
          ? String(row.platform_message_id) : null,
        cliMsgId: null,
        senderUid: row.role === 'assistant'
          ? String(accountId)
          : (row.chat_type === 'dm' ? String(row.user_id || '') : ''),
        senderName: row.role === 'assistant'
          ? ''
          : (inbound.senderName || (row.chat_type === 'dm' ? String(row.display_name || '') : '')),
        text: row.role === 'assistant' ? String(row.content).trim() : inbound.text,
        msgType: 'legacy-hermes',
        ts: normalizeTimestamp(row.timestamp),
        isSelf: row.role === 'assistant',
      };
    }).filter((message) => message.threadId && message.text && message.ts != null);

    const inserted = store.insertMessages(String(accountId), messages, 'legacy-hermes');
    return { scanned: messages.length, inserted, skipped: messages.length - inserted };
  } finally {
    source.close();
  }
}
