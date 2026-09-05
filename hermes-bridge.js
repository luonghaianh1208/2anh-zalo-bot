import { WebSocketServer } from 'ws';
import { ThreadType } from 'zca-js';
import { formatZaloMarkdown } from './markdown-formatter.js';

/**
 * Cầu nối Zalo ↔ Hermes Agent.
 *
 * Vì sao cần cầu nối: plugin nền tảng của Hermes viết bằng Python, còn zca-js
 * là thư viện JavaScript. Hai thư viện Zalo cho Python đều không dùng được
 * (zlapi đã ngừng phát triển và mất server đăng nhập; zca-py còn ở mức Alpha),
 * nên giữ zca-js làm lớp Zalo rồi nối sang Python qua WebSocket là đường an
 * toàn nhất — không phải quét QR lại, không mất phiên đang chạy.
 *
 * Giao thức (JSON, mỗi frame một thông điệp)
 *
 *   Node → Python
 *     { type: "hello",  self: {...} }                        khi Hermes vừa nối
 *     { type: "message", id, threadId, threadType, ... }     có tin nhắn Zalo
 *     { type: "ack",    reqId, ok, msgId?, error? }          kết quả một lệnh
 *
 *   Python → Node
 *     { type: "send",     reqId, threadId, threadType, text, quote? }
 *     { type: "typing",   threadId, threadType }
 *     { type: "reaction", threadId, threadType, msgId, cliMsgId, icon }
 *     { type: "ping" }
 *
 * Khi có ít nhất một client Hermes đang nối, bot nội bộ nhường quyền trả lời
 * cho Hermes để tránh trả lời hai lần.
 */

const DEFAULT_PORT = 3873;

let wss = null;
let clients = new Set();
let zaloApi = null;
let selfProfile = null;

/** Có Hermes đang nối không — bot nội bộ đọc cờ này để nhường quyền. */
export function isHermesAttached() {
  for (const ws of clients) {
    if (ws.readyState === 1) return true;
  }
  return false;
}

export function startHermesBridge({ api, profile, port = DEFAULT_PORT }) {
  zaloApi = api;
  selfProfile = profile || null;

  wss = new WebSocketServer({ host: '127.0.0.1', port });

  wss.on('connection', (ws, req) => {
    clients.add(ws);
    console.log(`[bridge] 🔗 Hermes đã nối (${clients.size} client)`);

    send(ws, { type: 'hello', self: selfProfile });

    ws.on('message', (raw) => {
      let cmd;
      try {
        cmd = JSON.parse(raw.toString());
      } catch {
        return console.warn('[bridge] frame không phải JSON hợp lệ');
      }
      handleCommand(ws, cmd).catch((err) => {
        console.error('[bridge] lỗi khi chạy lệnh:', err?.message || err);
        if (cmd?.reqId) send(ws, { type: 'ack', reqId: cmd.reqId, ok: false, error: String(err?.message || err) });
      });
    });

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[bridge] 🔌 Hermes ngắt kết nối (còn ${clients.size})`);
    });

    ws.on('error', (err) => {
      console.warn('[bridge] lỗi socket:', err?.message || err);
    });
  });

  wss.on('error', (err) => {
    console.error('[bridge] không mở được cổng:', err?.message || err);
  });

  console.log(`[bridge] 🌉 đang chờ Hermes tại ws://127.0.0.1:${port}`);
  return wss;
}

export function stopHermesBridge() {
  for (const ws of clients) {
    try { ws.close(); } catch { /* đang đóng dở */ }
  }
  clients.clear();
  if (wss) {
    wss.close();
    wss = null;
  }
}

/** Đẩy một tin nhắn Zalo sang Hermes. Trả về true nếu có ai đó nhận. */
export function forwardToHermes(msg) {
  if (!isHermesAttached()) return false;

  const payload = {
    type: 'message',
    id: msg.data?.msgId ? String(msg.data.msgId) : null,
    cliMsgId: msg.data?.cliMsgId ? String(msg.data.cliMsgId) : null,
    threadId: String(msg.threadId ?? ''),
    threadType: msg.type === ThreadType.Group ? 1 : 0,
    senderUid: String(msg.data?.uidFrom ?? ''),
    senderName: msg.data?.dName || '',
    text: typeof msg.data?.content === 'string' ? msg.data.content : '',
    mentions: Array.isArray(msg.data?.mentions) ? msg.data.mentions : [],
    ts: msg.data?.ts ?? Date.now(),
    // Giữ nguyên gói gốc để adapter trích thêm khi cần (quote, đính kèm…)
    raw: msg.data ?? null,
  };

  broadcast(payload);
  return true;
}

async function handleCommand(ws, cmd) {
  if (!cmd || typeof cmd.type !== 'string') return;

  if (cmd.type === 'ping') {
    return send(ws, { type: 'pong' });
  }

  if (!zaloApi) {
    if (cmd.reqId) send(ws, { type: 'ack', reqId: cmd.reqId, ok: false, error: 'Zalo chưa đăng nhập' });
    return;
  }

  const threadType = cmd.threadType === 1 ? ThreadType.Group : ThreadType.User;

  switch (cmd.type) {
    case 'send': {
      // Hermes Agent xuất Markdown (giống hệt khi trả lời trên Telegram).
      // Zalo không hiểu Markdown nhưng có hệ style riêng, nên dịch tại đây —
      // adapter phía Python không cần biết gì về định dạng của Zalo.
      const formatted = formatZaloMarkdown(String(cmd.text ?? ''));
      const content = { msg: formatted.msg };
      if (formatted.styles.length) content.styles = formatted.styles;
      // Cho phép người gọi tự truyền styles để ghi đè (hiếm dùng).
      if (Array.isArray(cmd.styles) && cmd.styles.length) content.styles = cmd.styles;
      if (cmd.quote) content.quote = cmd.quote;

      const res = await zaloApi.sendMessage(content, String(cmd.threadId), threadType);
      const msgId = res?.message?.msgId ?? res?.message?.msgID ?? null;
      if (cmd.reqId) send(ws, { type: 'ack', reqId: cmd.reqId, ok: true, msgId: msgId ? String(msgId) : null });
      break;
    }

    case 'typing': {
      await zaloApi.sendTypingEvent(String(cmd.threadId), threadType);
      if (cmd.reqId) send(ws, { type: 'ack', reqId: cmd.reqId, ok: true });
      break;
    }

    case 'reaction': {
      await zaloApi.addReaction(cmd.icon, {
        data: { msgId: String(cmd.msgId), cliMsgId: String(cmd.cliMsgId) },
        threadId: String(cmd.threadId),
        type: threadType,
      });
      if (cmd.reqId) send(ws, { type: 'ack', reqId: cmd.reqId, ok: true });
      break;
    }

    case 'seen': {
      await zaloApi.sendSeenEvent(cmd.message, threadType);
      if (cmd.reqId) send(ws, { type: 'ack', reqId: cmd.reqId, ok: true });
      break;
    }

    default:
      if (cmd.reqId) send(ws, { type: 'ack', reqId: cmd.reqId, ok: false, error: `lệnh lạ: ${cmd.type}` });
  }
}

function send(ws, obj) {
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch (err) {
    console.warn('[bridge] không gửi được frame:', err?.message || err);
  }
}

function broadcast(obj) {
  const text = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState !== 1) continue;
    try {
      ws.send(text);
    } catch (err) {
      console.warn('[bridge] broadcast lỗi:', err?.message || err);
    }
  }
}
