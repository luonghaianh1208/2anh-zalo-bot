import { WebSocketServer } from 'ws';
import { ThreadType, Reactions } from 'zca-js';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { formatAndChunkZaloMarkdown } from './markdown-formatter.js';
import { pickSmartReaction } from './smart-reaction.js';
import { RateLimiter, RateLimitedError, THROTTLED_METHODS } from './rate-limiter.js';
import { openZaloStore } from './zalo-store.js';
import { authorizeBridgeCommand } from './zalo-policy.js';

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

// Đọc từ môi trường lúc khởi động bridge, không phải lúc nạp module: import
// ESM chạy trước khi server.js kịp nạp .env, đọc sớm thì luôn ra 3873 — ai
// đổi cổng sẽ ngồi tự hỏi vì sao không ăn.
function defaultBridgePort() {
  return Number(process.env.ZALO_BRIDGE_PORT) || 3873;
}

// Nhóm Zalo có thể tới hàng nghìn người; tra hồ sơ chừng này là đủ để trả lời
// "nhóm có ai" mà không làm một lệnh đọc kéo dài.
const GROUP_MEMBERS_LIMIT = 200;

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
let limiter = null;

let wss = null;
let clients = new Set();
let zaloApi = null;
let selfProfile = null;
let activeStore = null;
let ownsActiveStore = false;
let activeAccountId = 'unknown';
let activeOwnerUids = new Set();
let activeHealth = null;
let staleTimer = null;
let clientSequence = 0;
const clientIds = new Map();
let maxBackfillPages = Number(process.env.ZALO_BACKFILL_MAX_PAGES) || 10;
const oldMessageWaiters = new Map();
const backfillJobs = new Map();
let historyListener = null;
let historyListenerCallback = null;
let historyListenerConnectedCallback = null;
let historyListenerDisconnectedCallback = null;
let historyListenerReady = true;
const historyListenerReadyWaiters = new Set();

function defaultStore() {
  return openZaloStore({
    path: fileURLToPath(new URL('./data/zalo.sqlite', import.meta.url)),
    retentionDays: Number(process.env.ZALO_HISTORY_RETENTION_DAYS) || 365,
  });
}

function normalizeHistoryMessage(msg) {
  const threadId = String(msg?.threadId ?? '');
  if (!threadId) return null;
  const threadType = msg?.type === ThreadType.Group ? 1 : 0;
  const senderUid = String(msg?.data?.uidFrom ?? '');
  const selfUid = String(selfProfile?.user_id ?? selfProfile?.userId ?? '');
  return {
    threadId,
    threadType,
    msgId: msg?.data?.msgId != null ? String(msg.data.msgId) : null,
    cliMsgId: msg?.data?.cliMsgId != null ? String(msg.data.cliMsgId) : null,
    senderUid,
    senderName: msg?.data?.dName || '',
    text: extractText(msg),
    msgType: msg?.data?.msgType || '',
    ts: Number(msg?.data?.ts ?? Date.now()),
    isSelf: Boolean(msg?.isSelf) || Boolean(selfUid && senderUid === selfUid),
  };
}

/** Ghi một tin vào cache cục bộ; bot-handler gọi cả với tin self trước khi bỏ qua. */
export function rememberZaloMessage(msg) {
  const item = normalizeHistoryMessage(msg);
  if (!item) return false;
  if (!activeStore) return false;
  activeStore.upsertMessage(activeAccountId, item, 'live');
  return true;
}

function onOldMessages(messages, threadType) {
  const normalized = (Array.isArray(messages) ? messages : [])
    .map(normalizeHistoryMessage).filter(Boolean);
  const inserted = activeStore ? activeStore.insertMessages(activeAccountId, normalized, 'backfill') : 0;
  const waiter = oldMessageWaiters.get(threadType);
  if (!waiter) return;
  oldMessageWaiters.delete(threadType);
  waiter({ messages: normalized, inserted, timedOut: false });
}

function requestOldMessages(threadType, lastMsgId = null) {
  const listener = zaloApi?.listener;
  if (typeof listener?.requestOldMessages !== 'function') {
    return Promise.resolve({ messages: [], inserted: 0, timedOut: false });
  }
  return new Promise((resolve) => {
    let timer;
    const done = (result = { messages: [], inserted: 0, timedOut: true }) => {
      clearTimeout(timer);
      if (oldMessageWaiters.get(threadType) === done) oldMessageWaiters.delete(threadType);
      resolve(result);
    };
    oldMessageWaiters.set(threadType, done);
    const timeoutMs = Math.max(1_500, Number(process.env.ZALO_BACKFILL_PAGE_TIMEOUT_MS) || 1_500);
    timer = setTimeout(done, timeoutMs);
    try {
      listener.requestOldMessages(threadType, lastMsgId);
    } catch {
      done();
    }
  });
}

function waitForHistoryListener() {
  if (historyListenerReady) return Promise.resolve(true);
  const timeoutMs = Math.max(1_500, Number(process.env.ZALO_BACKFILL_CONNECT_TIMEOUT_MS) || 30_000);
  return new Promise((resolve) => {
    let timer;
    const done = (ready) => {
      clearTimeout(timer);
      historyListenerReadyWaiters.delete(done);
      resolve(ready);
    };
    historyListenerReadyWaiters.add(done);
    timer = setTimeout(() => done(false), timeoutMs);
  });
}

function getThreadHistory(threadId, threadType, count) {
  if (!activeStore) return [];
  return activeStore.getHistory(activeAccountId, String(threadId), Number(threadType), count);
}

function oldestCursor(messages) {
  return [...messages]
    .filter((message) => message.msgId)
    .sort((left, right) => left.ts - right.ts)[0]?.msgId || null;
}

async function runBackfill(threadId, threadType, requestedCount) {
  if (backfillJobs.has(threadType)) {
    await backfillJobs.get(threadType);
    return activeStore?.getBackfillState(activeAccountId, threadType);
  }

  const job = (async () => {
    const previous = activeStore?.getBackfillState(activeAccountId, threadType);
    let cursor = previous?.cursorMsgId || null;
    let pagesFetched = previous?.pagesFetched || 0;
    let messagesInserted = previous?.messagesInserted || 0;
    let status = 'running';
    let error = null;
    const seenCursors = new Set();
    const retentionCutoff = Date.now() - (Number(process.env.ZALO_HISTORY_RETENTION_DAYS) || 365) * 24 * 60 * 60 * 1000;

    activeStore?.saveBackfillState({
      accountId: activeAccountId, threadType, cursorMsgId: cursor, status,
      pagesFetched, messagesInserted, error,
    });
    activeHealth?.setBackfill({ threadType, status, pagesFetched, messagesInserted });

    for (let pageIndex = 0; pageIndex < maxBackfillPages; pageIndex += 1) {
      if (getThreadHistory(threadId, threadType, requestedCount).length >= requestedCount) break;
      if (seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
      const page = await requestOldMessages(threadType, cursor);
      if (page.timedOut) {
        status = 'failed';
        error = 'old_messages_timeout';
        break;
      }
      pagesFetched += 1;
      messagesInserted += page.inserted;
      activeStore?.pruneMessages();
      const nextCursor = oldestCursor(page.messages);
      if (!page.messages.length || !nextCursor || page.inserted === 0 || nextCursor === cursor) {
        cursor = nextCursor || cursor;
        break;
      }
      cursor = nextCursor;
      const oldestTimestamp = Math.min(...page.messages.map((message) => message.ts));
      if (oldestTimestamp < retentionCutoff) break;
    }

    if (status === 'running') status = 'completed';
    const state = {
      accountId: activeAccountId, threadType, cursorMsgId: cursor, status,
      pagesFetched, messagesInserted, error,
    };
    activeStore?.saveBackfillState(state);
    activeHealth?.setBackfill(state);
    return state;
  })();

  backfillJobs.set(threadType, job);
  try {
    return await job;
  } finally {
    if (backfillJobs.get(threadType) === job) backfillJobs.delete(threadType);
  }
}

export async function startAutomaticBackfill() {
  if (!activeStore || !zaloApi) throw new Error('Zalo bridge is not ready');
  for (const threadType of [0, 1]) {
    const previous = activeStore.getBackfillState(activeAccountId, threadType);
    activeHealth?.setBackfill({
      threadType,
      status: 'scheduled',
      pagesFetched: previous?.pagesFetched || 0,
      messagesInserted: previous?.messagesInserted || 0,
    });
  }
  if (!await waitForHistoryListener()) {
    for (const threadType of [0, 1]) {
      const previous = activeStore.getBackfillState(activeAccountId, threadType);
      const state = {
        accountId: activeAccountId,
        threadType,
        cursorMsgId: previous?.cursorMsgId || null,
        status: 'failed',
        pagesFetched: previous?.pagesFetched || 0,
        messagesInserted: previous?.messagesInserted || 0,
        error: 'zalo_listener_not_ready',
      };
      activeStore.saveBackfillState(state);
      activeHealth?.setBackfill(state);
    }
    throw new Error('Zalo listener did not become ready for history backfill');
  }
  return Promise.all([0, 1].map((threadType) => runBackfill('', threadType, 100)));
}

/** Có Hermes đang nối không — bot nội bộ đọc cờ này để nhường quyền. */
export function isHermesAttached() {
  for (const ws of clients) {
    if (ws.readyState === 1) return true;
  }
  return false;
}

export function startHermesBridge({
  api, profile, port = defaultBridgePort(), store = null, maxBackfillPages: pageLimit = null,
  ownerUids = null, health = null, staleCheckIntervalMs = 15_000,
  bridgeToken = process.env.ZALO_BRIDGE_TOKEN,
}) {
  if (!bridgeToken) throw new Error('Thiếu ZALO_BRIDGE_TOKEN; hãy chạy npm run install:hermes');
  zaloApi = api;
  selfProfile = profile || null;
  activeAccountId = String(profile?.user_id ?? profile?.userId ?? 'unknown');
  activeStore = store || defaultStore();
  ownsActiveStore = !store;
  activeOwnerUids = new Set(ownerUids || String(process.env.ZALO_ALLOWED_USERS || '')
    .split(',').map((value) => value.trim()).filter(Boolean));
  activeHealth = health;
  maxBackfillPages = Math.max(1, Number(pageLimit) || Number(process.env.ZALO_BACKFILL_MAX_PAGES) || 10);
  limiter = new RateLimiter({
    capacity: Number(process.env.ZALO_RATE_BURST || 5),
    refillMs: Number(process.env.ZALO_RATE_INTERVAL_MS || 3000),
    maxWaitMs: Number(process.env.ZALO_RATE_MAX_WAIT_MS || 20000),
  });
  activeStore.pruneMessages();
  historyListener = api?.listener || null;
  historyListenerCallback = onOldMessages;
  historyListener?.on?.('old_messages', historyListenerCallback);
  historyListenerReady = !historyListener || !Object.prototype.hasOwnProperty.call(historyListener, 'ws');
  historyListenerConnectedCallback = () => {
    historyListenerReady = true;
    for (const resolve of historyListenerReadyWaiters) resolve(true);
    historyListenerReadyWaiters.clear();
  };
  historyListenerDisconnectedCallback = () => { historyListenerReady = false; };
  historyListener?.on?.('connected', historyListenerConnectedCallback);
  historyListener?.on?.('disconnected', historyListenerDisconnectedCallback);
  historyListener?.on?.('closed', historyListenerDisconnectedCallback);
  if (historyListener?.ws?.readyState === 1) historyListenerReady = true;

  wss = new WebSocketServer({
    host: '127.0.0.1',
    port,
    verifyClient(info, done) {
      if (info.origin || info.req.headers.origin) return done(false, 403, 'Browser origin is not allowed');
      const supplied = new URL(info.req.url || '/', 'ws://127.0.0.1').searchParams.get('token') || '';
      const expected = String(bridgeToken);
      const suppliedBytes = Buffer.from(supplied);
      const expectedBytes = Buffer.from(expected);
      const valid = suppliedBytes.length === expectedBytes.length
        && timingSafeEqual(suppliedBytes, expectedBytes);
      return done(valid, valid ? 101 : 401, valid ? undefined : 'Unauthorized');
    },
  });

  wss.on('connection', (ws, req) => {
    clients.add(ws);
    const clientId = `hermes-${++clientSequence}`;
    clientIds.set(ws, clientId);
    activeHealth?.bridgeConnected(clientId);
    console.log(`[bridge] 🔗 Hermes đã nối (${clients.size} client)`);

    send(ws, { type: 'hello', self: selfProfile });

    ws.on('message', (raw) => {
      let cmd;
      try {
        cmd = JSON.parse(raw.toString());
      } catch {
        return console.warn('[bridge] frame không phải JSON hợp lệ');
      }
      if (cmd?.type === 'ping') activeHealth?.bridgeHeartbeat(clientId);
      handleCommand(ws, cmd).catch((err) => {
        activeHealth?.recordError('bridge_command_failed', 'operation_failed');
        console.error('[bridge] lỗi khi chạy lệnh:', err?.name || 'operation_failed');
        if (cmd?.reqId) send(ws, {
          type: 'ack', reqId: cmd.reqId, ok: false,
          errorCode: 'operation_failed', error: 'Thao tác Zalo thất bại; xem health/audit để tra mã lỗi',
        });
      });
    });

    ws.on('close', () => {
      clients.delete(ws);
      activeHealth?.bridgeDisconnected(clientId);
      clientIds.delete(ws);
      console.log(`[bridge] 🔌 Hermes ngắt kết nối (còn ${clients.size})`);
    });

    ws.on('error', (err) => {
      console.warn('[bridge] lỗi socket:', err?.message || err);
    });
  });

  wss.on('error', (err) => {
    activeHealth?.recordError('bridge_server_error', err?.message || err);
    console.error('[bridge] không mở được cổng:', err?.message || err);
  });

  staleTimer = setInterval(() => {
    const staleIds = new Set(activeHealth?.staleClientIds() || []);
    if (!staleIds.size) return;
    for (const ws of clients) {
      if (staleIds.has(clientIds.get(ws))) ws.close(4000, 'application heartbeat stale');
    }
  }, Math.max(10, Number(staleCheckIntervalMs) || 15_000));
  staleTimer.unref?.();

  console.log(`[bridge] 🌉 đang chờ Hermes tại ws://127.0.0.1:${port}`);
  return wss;
}

export function stopHermesBridge() {
  for (const ws of clients) {
    try { ws.close(); } catch { /* đang đóng dở */ }
  }
  clients.clear();
  clientIds.clear();
  if (staleTimer) clearInterval(staleTimer);
  staleTimer = null;
  if (wss) {
    wss.close();
    wss = null;
  }
  historyListener?.off?.('old_messages', historyListenerCallback);
  historyListener?.off?.('connected', historyListenerConnectedCallback);
  historyListener?.off?.('disconnected', historyListenerDisconnectedCallback);
  historyListener?.off?.('closed', historyListenerDisconnectedCallback);
  historyListener = null;
  historyListenerCallback = null;
  historyListenerConnectedCallback = null;
  historyListenerDisconnectedCallback = null;
  historyListenerReady = true;
  for (const resolve of historyListenerReadyWaiters) resolve(false);
  historyListenerReadyWaiters.clear();
  for (const resolve of oldMessageWaiters.values()) resolve({ messages: [], inserted: 0, timedOut: true });
  oldMessageWaiters.clear();
  backfillJobs.clear();
  if (ownsActiveStore && activeStore) activeStore.close();
  activeStore = null;
  ownsActiveStore = false;
  activeOwnerUids = new Set();
  activeHealth = null;
  limiter = null;
}

/**
 * Rút phần chữ đọc được ra khỏi một tin nhắn Zalo.
 *
 * `msg.data.content` KHÔNG phải lúc nào cũng là chuỗi. Khi người ta dán một
 * đường link, gửi ảnh hay tệp, Zalo đổi nó thành object
 * `{title, description, href, thumb, …}`. Trước đây chỗ này chỉ nhận chuỗi, nên
 * mọi tin có link đều thành rỗng — và adapter bỏ tin rỗng ngay từ dòng đầu.
 * Kết quả: tag bot kèm một đường link thì bot im như không nghe thấy, không có
 * lấy một dòng log để lần ra.
 */
export function extractText(msg) {
  const c = msg?.data?.content;
  if (typeof c === 'string') return c;
  if (!c || typeof c !== 'object') return '';

  const parts = [];
  const push = (v) => {
    const s = String(v ?? '').trim();
    if (s && !parts.includes(s)) parts.push(s);
  };
  push(c.title);
  push(c.description);
  push(c.href);
  if (!parts.length) {
    // Dạng lạ: giữ lại vài trường chuỗi đầu tiên còn hơn trả về rỗng rồi bị
    // vứt bỏ trong im lặng.
    for (const [k, v] of Object.entries(c)) {
      if (typeof v === 'string' && v.trim() && !/^(thumb|action|params)$/i.test(k)) {
        push(v);
        if (parts.length >= 3) break;
      }
    }
  }
  if (!parts.length) {
    console.warn('[bridge] tin nhắn không rút được chữ, msgType=%s, khoá=%s',
      msg?.data?.msgType, Object.keys(c).join(','));
  }
  return parts.join('\n');
}

export function extractMediaUrls(value) {
  const urls = [];
  const seen = new Set();
  const push = (v) => {
    const s = String(v ?? '').trim();
    if (!/^https?:\/\//i.test(s) || seen.has(s)) return;
    seen.add(s);
    urls.push(s);
  };
  const visit = (node, key = '') => {
    if (!node) return;
    if (typeof node === 'string') {
      if (/^(href|oriUrl|hdUrl|normalUrl|thumb|thumbUrl|previewThumb|rawUrl|url)$/i.test(key)) push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, key);
      return;
    }
    if (typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (/^(href|oriUrl|hdUrl|normalUrl|thumb|thumbUrl|previewThumb|rawUrl|url)$/i.test(k)) push(v);
      else if (typeof v === 'object') visit(v, k);
    }
  };

  visit(value?.data ?? value);
  return urls;
}

function extractQuote(msg) {
  const quote = msg?.data?.quote || null;
  if (!quote || typeof quote !== 'object') return null;
  let attachment = quote.attach;
  if (typeof attachment === 'string' && attachment.trim()) {
    try { attachment = JSON.parse(attachment); } catch { attachment = null; }
  }
  return {
    id: quote.msgId ? String(quote.msgId) : (quote.globalMsgId ? String(quote.globalMsgId) : null),
    cliMsgId: quote.cliMsgId ? String(quote.cliMsgId) : null,
    authorId: quote.ownerId ? String(quote.ownerId) : null,
    authorName: quote.ownerName || quote.dName || quote.fromD || '',
    text: String(quote.msg || extractText({ data: quote }) || ''),
    msgType: quote.msgType || quote.cliMsgType || '',
    mediaUrls: extractMediaUrls(attachment || quote),
    raw: quote,
  };
}

/** Đẩy một tin nhắn Zalo sang Hermes. Trả về true nếu có ai đó nhận. */
export function forwardToHermes(msg) {
  if (!isHermesAttached()) return false;
  activeHealth?.markInbound();

  const mediaUrls = extractMediaUrls(msg);
  const quote = extractQuote(msg);
  const payload = {
    type: 'message',
    id: msg.data?.msgId ? String(msg.data.msgId) : null,
    cliMsgId: msg.data?.cliMsgId ? String(msg.data.cliMsgId) : null,
    threadId: String(msg.threadId ?? ''),
    threadType: msg.type === ThreadType.Group ? 1 : 0,
    senderUid: String(msg.data?.uidFrom ?? ''),
    senderName: msg.data?.dName || '',
    text: extractText(msg),
    // Kiểu tin của Zalo (webchat, chat.photo, chat.recommended…) — adapter cần
    // để biết đây là tin chữ hay tin đính kèm.
    msgType: msg.data?.msgType || '',
    mentions: Array.isArray(msg.data?.mentions) ? msg.data.mentions : [],
    mediaUrls,
    mediaTypes: mediaUrls.map(() => 'image/jpeg'),
    quote,
    ts: msg.data?.ts ?? Date.now(),
    // Giữ nguyên gói gốc để adapter trích thêm khi cần (quote, đính kèm…)
    raw: msg.data ?? null,
  };

  broadcast(payload);
  return true;
}

function rememberOutboundResult(result, threadId, threadType, content = '', msgType = 'chat.text') {
  const message = result?.message && typeof result.message === 'object' ? result.message : result;
  const msgId = message?.msgId ?? message?.msgID ?? null;
  const cliMsgId = message?.cliMsgId ?? message?.cliMsgID ?? null;
  if (!activeStore || (!msgId && !cliMsgId)) return false;
  activeStore.upsertMessage(activeAccountId, {
    threadId: String(threadId),
    threadType: Number(threadType),
    msgId: msgId == null ? null : String(msgId),
    cliMsgId: cliMsgId == null ? null : String(cliMsgId),
    senderUid: activeAccountId,
    senderName: selfProfile?.display_name || '',
    text: String(content || ''),
    msgType,
    ts: Date.now(),
    isSelf: true,
  }, 'outbound');
  return true;
}

export async function sendSystemNotice({ api, threadId, threadType, text }) {
  if (!activeStore) throw new Error('Zalo store is not ready');
  const requestId = `system-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  activeStore.beginAudit({
    requestId,
    accountId: activeAccountId,
    actorUid: 'system',
    actorRole: 'system',
    action: 'send_system_notice',
    category: 'send',
    threadId: String(threadId),
    threadType: Number(threadType),
    targetSummary: { commandType: 'system_notice', threadId: String(threadId), threadType: Number(threadType) },
  });
  try {
    const result = await api.sendMessage({ msg: String(text) }, String(threadId), threadType);
    rememberOutboundResult(result, threadId, threadType, text);
    activeStore.finishAudit(requestId, 'succeeded');
    activeHealth?.markOutbound();
    return result;
  } catch (error) {
    activeStore.finishAudit(requestId, 'failed', { error: 'operation_failed' });
    activeHealth?.recordError('system_notice_failed', 'operation_failed');
    throw error;
  }
}

function policyErrorMessage(code) {
  const messages = {
    auth_required: 'Thiếu ngữ cảnh phân quyền',
    owner_required: 'Chỉ chủ nhân được phép thực hiện thao tác này',
    cross_thread_denied: 'Người dùng public chỉ được thao tác trong hội thoại hiện tại',
    confirmation_required: 'Thao tác này cần xác nhận rõ ràng',
    command_denied: 'Lệnh không được phép',
  };
  return messages[code] || 'Lệnh không được phép';
}

function auditTargetSummary(cmd) {
  const args = Array.isArray(cmd.args) ? cmd.args : [];
  const targetIndexes = {
    sendMessage: 1, sendVoice: 1, sendSticker: 1, sendLink: 1,
    uploadAttachment: 1, createReminder: 1, removeReminder: 1,
    changeGroupName: 1, addUserToGroup: 1,
    removeUserFromGroup: 1, addGroupDeputy: 1, removeGroupDeputy: 1,
  };
  const invokeIndex = targetIndexes[String(cmd.method || '')];
  const invokeThreadId = invokeIndex == null ? undefined : args[invokeIndex];
  const summary = {
    commandType: String(cmd.type || ''),
    method: cmd.type === 'invoke' ? String(cmd.method || '') : undefined,
    threadId: cmd.threadId == null
      ? (invokeThreadId == null ? undefined : String(invokeThreadId))
      : String(cmd.threadId),
    threadType: cmd.threadType == null
      ? (invokeThreadId == null ? undefined : 1)
      : Number(cmd.threadType),
    cronJobId: cmd.auth?.cronJobId ? String(cmd.auth.cronJobId) : undefined,
  };
  if (Array.isArray(args[0])) summary.itemCount = args[0].length;
  return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined));
}

async function handleCommand(ws, cmd) {
  if (!cmd || typeof cmd.type !== 'string') return;

  if (cmd.type === 'ping') {
    return send(ws, { type: 'pong', ts: Date.now() });
  }

  const authorization = authorizeBridgeCommand(cmd, { ownerUids: activeOwnerUids });
  const shouldAudit = ['send', 'admin', 'undo'].includes(authorization.category);
  const auditRequestId = String(cmd.reqId || `bridge-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let auditFinished = false;
  const finishAudit = (status, error = null) => {
    if (!shouldAudit || auditFinished) return;
    activeStore.finishAudit(auditRequestId, status, error ? { error } : {});
    auditFinished = true;
  };

  if (shouldAudit) {
    activeStore.beginAudit({
      requestId: auditRequestId,
      accountId: activeAccountId,
      actorUid: String(cmd.auth?.actorUid || ''),
      actorRole: authorization.role,
      action: cmd.type === 'invoke' ? String(cmd.method || '') : cmd.type,
      category: authorization.category,
      threadId: String(cmd.threadId ?? ''),
      threadType: cmd.threadType == null ? null : Number(cmd.threadType),
      targetSummary: auditTargetSummary(cmd),
    });
  }

  if (!authorization.allowed) {
    finishAudit('failed', authorization.code);
    if (cmd.reqId) send(ws, {
      type: 'ack', reqId: cmd.reqId, ok: false,
      errorCode: authorization.code, error: policyErrorMessage(authorization.code),
    });
    return;
  }

  if (!zaloApi) {
    finishAudit('failed', 'zalo_not_logged_in');
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
        finishAudit('failed', err.message);
        if (cmd.reqId) send(ws, { type: 'ack', reqId: cmd.reqId, ok: false, error: err.message });
        return;
      }
      throw err;
    }
  }

  try {
  switch (cmd.type) {
    case 'send': {
      // Hermes Agent xuất Markdown (giống hệt khi trả lời trên Telegram).
      // Zalo không hiểu Markdown nhưng có hệ style riêng, nên dịch tại đây —
      // adapter phía Python không cần biết gì về định dạng của Zalo.
      //
      // Nâng cấp: Tự động chia tin nhắn thông minh theo ngân sách style và ký tự.
      // Nếu văn bản dài hoặc có nhiều tiêu đề / định dạng, formatAndChunkZaloMarkdown
      // sẽ tách thành các tin nhắn hoàn chỉnh, mỗi tin đảm bảo giữ trọn vẹn 100% styles
      // (tiêu đề to + đậm, chỉ mục số đậm + to, từ khoá in đậm) mà không bị Zalo từ chối!
      const rawText = String(cmd.text ?? '');
      const chunks = formatAndChunkZaloMarkdown(rawText);

      let lastMsgId = null;
      for (let i = 0; i < chunks.length; i++) {
        const item = chunks[i];
        const content = { msg: item.msg };
        if (item.styles && item.styles.length) content.styles = item.styles;
        // Chỉ trích dẫn (quote) ở tin đầu tiên nếu có
        if (i === 0 && cmd.quote) content.quote = cmd.quote;

        // Nếu có nhiều hơn 1 tin, từ tin thứ 2 trở đi cần qua limiter bình thường
        if (i > 0) {
          try {
            await limiter.acquire('high');
          } catch (limErr) {
            console.warn('[bridge] ⏳ ngắt nhịp giữa các chunk:', limErr?.message);
            finishAudit('failed', String(limErr?.message || limErr));
            if (cmd.reqId) send(ws, { type: 'ack', reqId: cmd.reqId, ok: false, error: String(limErr?.message || limErr) });
            return;
          }
        }

        let res;
        try {
          res = await zaloApi.sendMessage(content, String(cmd.threadId), threadType);
        } catch (err) {
          // Zalo có lúc từ chối tin có định dạng mà chỉ nói "Lỗi không xác định".
          // Có mã lỗi dạng số nghĩa là máy chủ đã từ chối, tin chưa đi, nên gửi
          // lại đúng chunk này dạng chữ thường: mất định dạng còn hơn mất cả tin.
          // Lỗi mạng không có mã số thì không gửi lại, tránh tin bị lặp.
          if (!content.styles || !/^-?\d+$/.test(String(err?.code ?? ''))) throw err;
          console.warn(`[bridge] Zalo từ chối chunk ${i + 1}/${chunks.length} có định dạng (mã ${err.code}) — gửi lại dạng chữ thường`);
          const { styles: _dropped, ...plain } = content;
          res = await zaloApi.sendMessage(plain, String(cmd.threadId), threadType);
        }
        rememberOutboundResult(res, cmd.threadId, threadType, item.msg);
        lastMsgId = res?.message?.msgId ?? res?.message?.msgID ?? lastMsgId;
      }

      if (cmd.reqId) send(ws, { type: 'ack', reqId: cmd.reqId, ok: true, msgId: lastMsgId ? String(lastMsgId) : null });
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

    case 'history': {
      const requestedCount = Math.min(Math.max(Number(cmd.count) || 30, 1), 100);
      let messages = getThreadHistory(cmd.threadId, threadType, requestedCount);
      let backfill = activeStore?.getBackfillState(activeAccountId, threadType) || null;
      if (messages.length < requestedCount) {
        backfill = await runBackfill(cmd.threadId, threadType, requestedCount);
        messages = getThreadHistory(cmd.threadId, threadType, requestedCount);
      }
      if (cmd.reqId) {
        send(ws, { type: 'ack', reqId: cmd.reqId, ok: true, result: { count: messages.length, messages, backfill } });
      }
      break;
    }

    case 'group_members': {
      // getGroupMembersInfo nhận ID thành viên, không nhận ID nhóm — hỏi
      // getGroupInfo lấy danh sách ID trước (dạng "uid_0").
      const groupId = String(cmd.threadId);
      const info = await zaloApi.getGroupInfo([groupId]);
      const memberIds = (info?.gridInfoMap?.[groupId]?.memVerList || [])
        .map((entry) => String(entry).replace(/_\d+$/, ''))
        .filter(Boolean);
      const lookup = memberIds.slice(0, GROUP_MEMBERS_LIMIT);
      const profiles = lookup.length ? (await zaloApi.getGroupMembersInfo(lookup))?.profiles || {} : {};
      const members = lookup.map((id) => ({
        id,
        displayName: profiles[id]?.displayName || profiles[id]?.zaloName || '',
      }));
      if (cmd.reqId) {
        send(ws, { type: 'ack', reqId: cmd.reqId, ok: true, result: { total: memberIds.length, members } });
      }
      break;
    }

    case 'undo': {
      const suppliedMsgId = cmd.msgId != null ? String(cmd.msgId) : null;
      const suppliedCliMsgId = cmd.cliMsgId != null ? String(cmd.cliMsgId) : null;
      if (Boolean(suppliedMsgId) !== Boolean(suppliedCliMsgId)) {
        finishAudit('failed', 'message_id_pair_required');
        if (cmd.reqId) send(ws, { type: 'ack', reqId: cmd.reqId, ok: false, error: 'Phải truyền đồng thời msgId và cliMsgId' });
        break;
      }

      let target = activeStore?.findOwnMessage(
        activeAccountId, String(cmd.threadId), threadType,
        suppliedMsgId ? { msgId: suppliedMsgId, cliMsgId: suppliedCliMsgId } : null,
      );
      if (!target) {
        await runBackfill(cmd.threadId, threadType, 100);
        target = activeStore?.findOwnMessage(
          activeAccountId, String(cmd.threadId), threadType,
          suppliedMsgId ? { msgId: suppliedMsgId, cliMsgId: suppliedCliMsgId } : null,
        );
      }
      if (!target) {
        finishAudit('failed', 'own_message_not_found');
        if (cmd.reqId) send(ws, { type: 'ack', reqId: cmd.reqId, ok: false, error: 'Không tìm thấy tin do chính bot gửi trong hội thoại này' });
        break;
      }

      const result = await zaloApi.undo(
        { msgId: target.msgId, cliMsgId: target.cliMsgId },
        String(cmd.threadId),
        threadType,
      );
      if (cmd.reqId) {
        send(ws, {
          type: 'ack', reqId: cmd.reqId, ok: true,
          result: { msgId: target.msgId, cliMsgId: target.cliMsgId, response: safeResult(result) },
        });
      }
      break;
    }

    // Cử chỉ "đã nhận tin" gộp làm một: báo đã xem + thả cảm xúc hợp ngữ cảnh.
    // Hermes ra lệnh này khi quyết định xử lý một tin nhắn — chỉ nó mới biết
    // tin nào đáng phản hồi, nên sidecar không tự làm (thả cảm xúc cho mọi
    // tin trong nhóm đông sẽ thành quấy rối).
    case 'ack_message': {
      const gestureErrors = [];
      const dest = {
        data: { msgId: String(cmd.msgId), cliMsgId: String(cmd.cliMsgId) },
        threadId: String(cmd.threadId),
        type: threadType,
      };
      if (cmd.seen && cmd.raw) {
        try {
          await zaloApi.sendSeenEvent(cmd.raw, threadType);
        } catch (e) {
          gestureErrors.push(`seen:${String(e?.message || e)}`);
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
          gestureErrors.push(`reaction:${String(e?.message || e)}`);
          console.warn('[bridge] addReaction lỗi:', e?.message || e);
        }
      }
      if (gestureErrors.length) finishAudit('failed', gestureErrors.join('; '));
      if (cmd.reqId) send(ws, { type: 'ack', reqId: cmd.reqId, ok: true });
      break;
    }

    // Gọi thẳng một hàm zca-js nằm trong danh sách trắng. Nhờ lệnh này mà
    // thêm tính năng mới chỉ là thêm tool bên Python, không phải sửa cầu nối.
    case 'invoke': {
      const method = String(cmd.method || '');
      if (!ALLOWED_METHODS.has(method)) {
        finishAudit('failed', 'method_not_allowed');
        if (cmd.reqId) {
          send(ws, { type: 'ack', reqId: cmd.reqId, ok: false, error: `API không được phép: ${method}` });
        }
        break;
      }
      if (typeof zaloApi[method] !== 'function') {
        finishAudit('failed', 'method_unavailable');
        if (cmd.reqId) {
          send(ws, { type: 'ack', reqId: cmd.reqId, ok: false, error: `zca-js không có hàm ${method}` });
        }
        break;
      }
      const args = Array.isArray(cmd.args) ? cmd.args : [];
      const result = await zaloApi[method](...args);
      if (['sendMessage', 'sendVoice', 'sendSticker', 'sendLink'].includes(method)) {
        rememberOutboundResult(result, args[1], args[2], '', method);
      }
      if (cmd.reqId) send(ws, { type: 'ack', reqId: cmd.reqId, ok: true, result: safeResult(result) });
      break;
    }

    default:
      if (cmd.reqId) send(ws, { type: 'ack', reqId: cmd.reqId, ok: false, error: `lệnh lạ: ${cmd.type}` });
  }
  finishAudit('succeeded');
  if (shouldAudit) activeHealth?.markOutbound();
  } catch (error) {
    finishAudit('failed', 'operation_failed');
    throw error;
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
