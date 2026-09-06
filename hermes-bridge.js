import { WebSocketServer } from 'ws';
import { ThreadType, Reactions } from 'zca-js';
import { formatZaloMarkdown } from './markdown-formatter.js';
import { pickSmartReaction } from './smart-reaction.js';
import { RateLimiter, RateLimitedError, THROTTLED_METHODS } from './rate-limiter.js';

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

// Đọc từ môi trường chứ không cứng 3873: `.env.example` vẫn ghi biến này là
// đổi được, nhưng trước đây server.js gọi startHermesBridge() không truyền
// port nên biến đó không có tác dụng — ai đổi sẽ ngồi tự hỏi vì sao không ăn.
const DEFAULT_PORT = Number(process.env.ZALO_BRIDGE_PORT) || 3873;

/**
 * Các API zca-js mà Hermes được phép gọi qua lệnh `invoke`.
 *
 * Danh sách trắng, không phải danh sách đen: thư viện có 149 hàm, trong đó
 * nhiều hàm đủ sức làm khoá tài khoản (gửi lời mời kết bạn hàng loạt, chặn
 * người, giải tán nhóm) hoặc chạm tới tiền bạc (thẻ ngân hàng, catalog bán
 * hàng). Thà mở thêm từng cái khi thật sự cần còn hơn để agent tự do gọi
 * bất cứ thứ gì.
 */
const ALLOWED_METHODS = new Set([
  // Gửi nội dung
  'sendMessage', 'sendVoice', 'sendSticker', 'sendLink', 'uploadAttachment',
  'forwardMessage',
  // Sửa sai
  'undo',
  // Đọc ngữ cảnh
  'getGroupChatHistory', 'getGroupMembersInfo', 'getGroupInfo',
  'getAllGroups', 'getAllFriends', 'getUserInfo', 'findUser',
  'findUserByUsername', 'fetchAccountInfo', 'searchSticker',
  // Tính năng riêng của Zalo
  'createPoll', 'getPollDetail', 'lockPoll', 'createNote', 'createReminder',
  'getListReminder', 'removeReminder',
  // Quản trị nhóm
  'changeGroupName', 'addUserToGroup', 'removeUserFromGroup',
  'addGroupDeputy', 'removeGroupDeputy', 'getPendingGroupMembers',
  'reviewPendingMemberRequest', 'enableGroupLink', 'disableGroupLink',
  'createGroup', 'inviteUserToGroups', 'getGroupLinkDetail', 'joinGroupLink',
  // Hồ sơ của chính tài khoản bot
  'updateProfileBio', 'updateActiveStatus',
  // Quản lý hội thoại
  'setPinnedConversations', 'setMute',
  // Lịch sự
  'sendSeenEvent', 'sendTypingEvent', 'addReaction',
]);

/**
 * Nhịp gửi mặc định: bắn liền tối đa 5 tin, sau đó giãn về 20 tin/phút.
 *
 * Con số 5 chọn theo lượt trả lời thực tế — một câu trả lời của Hermes hiếm
 * khi vượt quá 2–3 tin kể cả khi kèm sticker, nên hạn mức này không bao giờ
 * chạm tới trong hội thoại bình thường.
 */
const limiter = new RateLimiter({
  capacity: Number(process.env.ZALO_RATE_BURST || 5),
  refillMs: Number(process.env.ZALO_RATE_INTERVAL_MS || 3000),
  maxWaitMs: Number(process.env.ZALO_RATE_MAX_WAIT_MS || 20000),
});

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

  // Giãn nhịp trước khi gửi bất cứ thứ gì người khác nhìn thấy được.
  //
  // Đặt ở đây chứ không đặt trong từng case: một chỗ duy nhất thì không thể
  // quên khi thêm lệnh mới, và cũng không có đường vòng nào lách qua.
  //
  // Ưu tiên cao cho `send` — đó là câu trả lời cho người đang nói chuyện. Các
  // lệnh khác (chuyển tiếp hàng loạt, mời vào nhóm) đi mức thường, nên chúng
  // không bao giờ chen trước một lượt trả lời.
  const needsQuota =
    cmd.type === 'send' ||
    (cmd.type === 'invoke' && THROTTLED_METHODS.has(String(cmd.method || '')));
  if (needsQuota) {
    try {
      await limiter.acquire(cmd.type === 'send' ? 'high' : 'normal');
    } catch (err) {
      if (err instanceof RateLimitedError) {
        console.warn(`[bridge] ⏳ chặn nhịp ${cmd.type}/${cmd.method || ''}: ${err.message}`);
        if (cmd.reqId) send(ws, { type: 'ack', reqId: cmd.reqId, ok: false, error: err.message });
        return;
      }
      throw err;
    }
  }

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

    // Cử chỉ "đã nhận tin" gộp làm một: báo đã xem + thả cảm xúc hợp ngữ cảnh.
    // Hermes ra lệnh này khi quyết định xử lý một tin nhắn — chỉ nó mới biết
    // tin nào đáng phản hồi, nên sidecar không tự làm (thả cảm xúc cho mọi
    // tin trong nhóm đông sẽ thành quấy rối).
    case 'ack_message': {
      const dest = {
        data: { msgId: String(cmd.msgId), cliMsgId: String(cmd.cliMsgId) },
        threadId: String(cmd.threadId),
        type: threadType,
      };
      if (cmd.seen && cmd.raw) {
        try {
          await zaloApi.sendSeenEvent(cmd.raw, threadType);
        } catch (e) {
          console.warn('[bridge] sendSeenEvent lỗi:', e?.message || e);
        }
      }
      if (cmd.react !== false && cmd.msgId) {
        try {
          const icon = cmd.icon
            ? (Reactions[cmd.icon] ?? cmd.icon)
            : pickSmartReaction(cmd.text || '');
          await zaloApi.addReaction(icon, dest);
        } catch (e) {
          console.warn('[bridge] addReaction lỗi:', e?.message || e);
        }
      }
      if (cmd.reqId) send(ws, { type: 'ack', reqId: cmd.reqId, ok: true });
      break;
    }

    // Gọi thẳng một hàm zca-js nằm trong danh sách trắng. Nhờ lệnh này mà
    // thêm tính năng mới chỉ là thêm tool bên Python, không phải sửa cầu nối.
    case 'invoke': {
      const method = String(cmd.method || '');
      if (!ALLOWED_METHODS.has(method)) {
        if (cmd.reqId) {
          send(ws, { type: 'ack', reqId: cmd.reqId, ok: false, error: `API không được phép: ${method}` });
        }
        break;
      }
      if (typeof zaloApi[method] !== 'function') {
        if (cmd.reqId) {
          send(ws, { type: 'ack', reqId: cmd.reqId, ok: false, error: `zca-js không có hàm ${method}` });
        }
        break;
      }
      const args = Array.isArray(cmd.args) ? cmd.args : [];
      const result = await zaloApi[method](...args);
      if (cmd.reqId) send(ws, { type: 'ack', reqId: cmd.reqId, ok: true, result: safeResult(result) });
      break;
    }

    default:
      if (cmd.reqId) send(ws, { type: 'ack', reqId: cmd.reqId, ok: false, error: `lệnh lạ: ${cmd.type}` });
  }
}

/**
 * Cắt bớt kết quả trước khi trả về Hermes.
 *
 * Vài API trả về danh sách rất dài (toàn bộ bạn bè, lịch sử nhóm) — nhồi hết
 * vào ngữ cảnh của agent vừa tốn token vừa vô ích. Giới hạn ở đây, agent cần
 * thêm thì hỏi tiếp.
 */
function safeResult(value, maxItems = 200) {
  if (Array.isArray(value)) {
    const cut = value.slice(0, maxItems);
    return cut.length < value.length
      ? { items: cut, truncated: true, total: value.length }
      : cut;
  }
  return value ?? null;
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
