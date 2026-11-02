import {
  isHermesAttached, forwardToHermes, extractMediaUrls, extractText, rememberZaloMessage,
  sendSystemNotice, acquireSendQuota,
} from './hermes-bridge.js';
import { ThreadType } from 'zca-js';
import { createStickerDirectory, enrichSticker } from './zalo-stickers.js';
import { createWelcomer } from './zalo-welcome.js';
import { createFriendManager, friendToolsEnabled, setActiveFriendManager } from './zalo-friends.js';
import { createOwnerMentionNotifier, envFlag } from './owner-mention.js';
import { join } from 'node:path';

/**
 * Định tuyến tin nhắn Zalo sang Hermes Agent.
 *
 * File này CỐ Ý không có bộ não riêng. Trước đây nó có: một đường dự phòng gọi
 * thẳng LLM khi Hermes chưa cắm. Đường đó đã bị bỏ vì hai lý do.
 *
 * Thứ nhất, nó không bao giờ chạy nên âm thầm mục ruỗng — mấy lỗi nặng nhất
 * của dự án (định tuyến nhóm sai, kiểm chủ nhân sai) đều nằm trong đoạn mã đó
 * và sống sót qua nhiều tháng vì không ai đi qua.
 *
 * Thứ hai, nguy hiểm hơn: khi nó *có* chạy thì lại chạy bằng một bộ luật khác.
 * Hermes phân quyền theo toolset (người ngoài chỉ nhận zalo_public), còn bộ
 * não Node đọc `adminUids` trong bot_settings.json và không có tầng phân quyền
 * nào. Hermes rớt là hệ thống lặng lẽ hạ cấp sang bộ luật lỏng hơn — đúng lúc
 * không ai để ý.
 *
 * Nay Hermes rớt thì bot báo thẳng là chưa sẵn sàng. Im lặng hoặc trả lời sai
 * đều tệ hơn một câu nói thật.
 */

let selfUid = '';
let mentionNotifier = null;

/** Ai được nghe câu báo lỗi khi Hermes chưa sẵn sàng (UID Zalo, phân tách bởi dấu phẩy). */
function ownerUids() {
  return String(process.env.ZALO_ALLOWED_USERS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Đừng lặp lại câu báo lỗi. Một người hỏi năm lần trong lúc Hermes đang rớt
 * thì chỉ nên nghe một lần — nhắc lại vừa phiền vừa tính vào hạn mức chống
 * spam.
 */
const notified = new Map();
const NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Nhịp chờ trước khi tự mở lại listener đã đóng hẳn. zca-js chỉ tự nối lại với
 * vài mã đóng do Zalo chỉ định và có giới hạn số lần; hết lượt là phát `closed`
 * rồi thôi. Không mở lại thì bot vẫn "đăng nhập" nhưng điếc hẳn — đúng sự cố
 * đêm 10/9/2026: đứt lúc nào không ai biết, sáng hôm sau mới lộ ra.
 */
const RESTART_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

const KICK_CODES = new Set([3000, 3003]); // 3000: phiên khác mở; 3003: bị đá (zca-js CloseReason)

export function setupBotListener(api, profile = null, {
  health = null, restartDelaysMs = RESTART_DELAYS_MS,
  stableAfterMs = 120_000, flapWindowMs = 10_000, now = Date.now,
  onScheduleRestart = null,
} = {}) {
  if (!api?.listener) {
    console.warn('[bot] ❌ api.listener không tồn tại — bot sẽ không nhận được tin nhắn');
    return () => {};
  }
  selfUid = String(profile?.user_id ?? profile?.userId ?? '');

  let stopped = false;
  let restartTimer = null;
  let restartAttempt = 0;
  let connectedAt = 0;
  let stableTimer = null;
  let kicked = false;
  let connects = 0;

  const stickers = createStickerDirectory({
    fetchDetail: (id) => api.getStickersDetail(id),
  });

  const onMessage = (msg) => {
    handleIncomingMessage(api, msg, stickers).catch((err) => {
      console.error('[bot] lỗi khi xử lý tin nhắn:', err?.message || err);
    });
  };

  // Chào thành viên mới ở các nhóm chủ bot đã bật (data/welcome.json).
  const welcomer = createWelcomer({
    selfUid,
    send: (groupId, text, mentions) => sendSystemNotice({
      api, threadId: groupId, threadType: ThreadType.Group, text, mentions,
    }),
  });
  const onGroupEvent = (event) => {
    try { welcomer.onGroupEvent(event); } catch (err) {
      console.error('[bot] lỗi khi xử lý sự kiện nhóm:', err?.message || err);
    }
  };

  // Kết bạn theo lệnh chủ bot, kết bạn xong thì tạo nhóm (ZALO_FRIEND_TOOLS).
  const friends = friendToolsEnabled() ? createFriendManager({
    api,
    selfUid,
    ownerUids,
    acquire: () => acquireSendQuota(),
    notify: (threadId, threadType, text) => sendSystemNotice({ api, threadId, threadType, text }),
  }) : null;
  setActiveFriendManager(friends);

  // Có người tag chủ nhân trong nhóm → nhắn riêng chủ nhân (bật/tắt ở dashboard › Cấu hình, có hiệu lực ngay).
  mentionNotifier = createOwnerMentionNotifier({
    ownerUids,
    selfUid: () => selfUid,
    enabled: envFlag(process.env.HERMES_HOME ? join(process.env.HERMES_HOME, '.env') : ''),
    groupName: async (id) => {
      const info = await api.getGroupInfo(id);
      return info?.gridInfoMap?.[id]?.name || '';
    },
    notify: (uid, text) => sendSystemNotice({ api, threadId: uid, threadType: ThreadType.User, text }),
  });
  // Ai đồng ý trong lúc sidecar tắt thì bắt ngay, không đợi 10 phút.
  friends?.poll().catch((err) => console.error('[bot] lỗi khi kiểm tra kế hoạch kết bạn:', err?.message || err));
  const onFriendEvent = (event) => {
    friends?.onFriendEvent(event).catch((err) => {
      console.error('[bot] lỗi khi xử lý sự kiện kết bạn:', err?.message || err);
    });
  };

  const onError = (err) => {
    console.error('[bot] listener error:', err?.message || err);
  };

  const onConnected = () => {
    connectedAt = now();
    connects += 1;
    health?.setListenerState('connected');
    console.log('[bot] 🔌 Zalo listener đã kết nối');
    clearTimeout(stableTimer);
    // Chỉ coi là đã ổn khi giữ được kết nối đủ lâu — nối được rồi rớt ngay
    // không được xoá nhịp chờ (sự cố 01/10/2026: 17.414 lần thử trong 24 giờ).
    stableTimer = setTimeout(() => {
      restartAttempt = 0;
      kicked = false;
      health?.setNeedsRelogin?.(false);
    }, stableAfterMs);
    stableTimer.unref?.();
  };

  // Bị đá có thể chỉ đến dưới dạng `closed` mà không có `disconnected` trước.
  const noteKick = (code) => {
    if (!KICK_CODES.has(Number(code))) return;
    kicked = true;
    health?.setNeedsRelogin?.(true);
  };

  const onDisconnected = (code, reason) => {
    clearTimeout(stableTimer);
    health?.setListenerState('reconnecting');
    const heldMs = connectedAt ? now() - connectedAt : null;
    const flapped = heldMs != null && heldMs < flapWindowMs;
    // Vừa đăng nhập, kết nối đầu tiên hay bị Zalo trả 3000 rồi tự nối lại được. Coi đó là bị đá thì dashboard báo
    // mất kết nối và lần mở QR kế tiếp dỡ luôn phiên mới (sự cố 02/11/2026). Rớt 3000 lần nữa mới tính.
    if (!(Number(code) === 3000 && connects === 1 && flapped)) noteKick(code);
    const flap = flapped ? ` (rớt sau ${heldMs}ms)` : '';
    console.warn(`[bot] ⚠️ Zalo listener mất kết nối (mã ${code}${reason ? `: ${reason}` : ''})${flap}`);
  };

  const onClosed = (code, reason) => {
    if (stopped) return;
    clearTimeout(stableTimer);
    noteKick(code);
    health?.setListenerState('closed');
    health?.recordError('zalo_listener_closed', `code ${code}`);
    console.error(`[bot] ❌ Zalo listener đã đóng (mã ${code}${reason ? `: ${reason}` : ''}) — không nhận được tin cho tới khi mở lại`);
    scheduleRestart();
  };

  const handlers = [
    ['message', onMessage],
    ['group_event', onGroupEvent],
    ['friend_event', onFriendEvent],
    ['error', onError],
    ['connected', onConnected],
    ['disconnected', onDisconnected],
    ['closed', onClosed],
  ];
  for (const [event, handler] of handlers) api.listener.on(event, handler);

  function scheduleRestart() {
    if (stopped || restartTimer) return;
    const delay = kicked
      ? restartDelaysMs[restartDelaysMs.length - 1]
      : restartDelaysMs[Math.min(restartAttempt, restartDelaysMs.length - 1)];
    restartAttempt += 1;
    onScheduleRestart?.(delay);
    console.warn(`[bot] 🔁 thử mở lại Zalo listener sau ${Math.round(delay / 1000)}s (lần ${restartAttempt})`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      startListener();
    }, delay);
  }

  function startListener() {
    if (stopped) return;
    health?.setListenerState('starting');
    try {
      api.listener.start({ retryOnClose: true });
      console.log('[bot] 🚀 Zalo listener đã chạy');
    } catch (err) {
      health?.setListenerState('closed');
      console.error('[bot] không start được listener:', err?.message || err);
      scheduleRestart();
    }
  }

  startListener();

  return () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(restartTimer);
    clearTimeout(stableTimer);
    restartTimer = null;
    welcomer.stop();
    friends?.stop();
    mentionNotifier = null;
    setActiveFriendManager(null);
    for (const [event, handler] of handlers) api.listener.off?.(event, handler);
    health?.setListenerState(null);
    try { api.listener.stop?.(); } catch (err) {
      console.warn('[bot] không stop được listener:', err?.message || err);
    }
  };
}

/** Tin này có gọi đích danh bot không (tag trong nhóm, hoặc chủ nhân nhắn riêng). */
function isAddressedToBot(msg, isGroup, senderUid) {
  if (!isGroup) return ownerUids().includes(senderUid);
  const mentions = Array.isArray(msg.data?.mentions) ? msg.data.mentions : [];
  return selfUid ? mentions.some((m) => String(m?.uid ?? '') === selfUid) : false;
}

async function handleIncomingMessage(api, msg, stickers = null) {
  // Tra nhãn dán trước khi lưu: lịch sử ghi "[Nhãn dán: cười]" thay vì một
  // dòng trống, và các tầng sau không phải biết gì thêm.
  await enrichSticker(msg, stickers);
  rememberZaloMessage(msg);
  if (msg.isSelf) return;

  // Dùng chung bộ rút chữ với cầu nối: tin có link hay tệp thì content là
  // object chứ không phải chuỗi, lọc theo chuỗi ở đây là vứt mất tin trước
  // cả khi Hermes kịp nhìn thấy. Ảnh-only cũng được giữ lại để adapter Python
  // lưu làm ngữ cảnh nhóm cho câu hỏi kiểu "đây là..." gửi ngay sau đó.
  const content = extractText(msg).trim();
  const mediaUrls = extractMediaUrls(msg);
  if (!content && !mediaUrls.length) return;

  // zca-js đã tính sẵn msg.threadId và msg.type cho cả hai loại hội thoại.
  // (Trước đây code đọc msg.isGroup — property KHÔNG tồn tại — nên mọi tin
  //  nhắn nhóm đều bị trả lời vào DM của người gửi.)
  const threadType = msg.type;
  const isGroup = threadType === ThreadType.Group;
  const threadId = msg.threadId;
  const senderUid = String(msg.data?.uidFrom ?? '');

  if (!threadId) {
    console.warn('[bot] bỏ qua: không xác định được threadId');
    return;
  }

  if (isGroup && mentionNotifier) {
    mentionNotifier.onGroupMessage({ msg, threadId, senderUid, content }).catch((err) => {
      console.error('[bot] lỗi khi báo tag chủ nhân:', err?.message || err);
    });
  }

  const where = isGroup ? `Nhóm ${threadId}` : `DM ${threadId}`;
  console.log(`[bot] 📩 [${where}] ${msg.data?.dName || '?'} (${senderUid}): ${content.slice(0, 80)}`);

  if (isHermesAttached()) {
    forwardToHermes(msg);
    console.log('[bot] ➡️ đã chuyển cho Hermes Agent');
    return;
  }

  // Cài mới chưa có allowlist nên gateway chưa thể nhìn thấy lệnh này. Chỉ tiết
  // lộ UID của chính người nhắn; tuyệt đối không ghi .env hay tự cấp quyền chủ.
  if (!isGroup && senderUid && content.toLowerCase() === '/sethome') {
    try {
      await sendSystemNotice({
        api,
        threadId,
        threadType,
        text: [
          `UID Zalo của bạn: ${senderUid}`,
          '',
          'Lệnh này chỉ tiết lộ UID và chưa cấp quyền chủ cho bạn.',
          'Thêm vào .env của Hermes:',
          `ZALO_ALLOWED_USERS=${senderUid}`,
          '',
          // Để chữ "tuỳ chọn" ra dòng riêng: khách chép nguyên dòng giá trị
          // thì không dính chữ thừa vào .env.
          'Tuỳ chọn — nhận báo cáo định kỳ qua tin riêng:',
          `ZALO_HOME_CHANNEL=${senderUid}`,
          '',
          'Sau đó khởi động lại sidecar, rồi start/restart Hermes gateway.',
        ].join('\n'),
      });
    } catch (err) {
      console.error('[bot] không gửi được UID bootstrap:', err?.message || err);
    }
    return;
  }

  // Hermes chưa cắm. Chỉ báo cho người thật sự đang gọi bot — người khác nói
  // chuyện với nhau trong nhóm thì không việc gì phải nghe.
  if (!isAddressedToBot(msg, isGroup, senderUid)) {
    console.log('[bot] ⚠️ Hermes chưa cắm — tin này không gọi bot, bỏ qua');
    return;
  }

  const last = notified.get(threadId) || 0;
  if (Date.now() - last < NOTIFY_COOLDOWN_MS) {
    console.log('[bot] ⚠️ Hermes chưa cắm — đã báo cho thread này rồi, không nhắc lại');
    return;
  }
  notified.set(threadId, Date.now());

  console.warn('[bot] ⚠️ Hermes chưa cắm — báo lỗi cho người dùng');
  try {
    await sendSystemNotice({
      api,
      threadId,
      threadType,
      text: 'Mình đang mất kết nối với bộ não xử lý nên chưa trả lời được 😔 Bạn nhắn lại giúp mình sau ít phút nhé!',
    });
  } catch (err) {
    console.error('[bot] không gửi được thông báo lỗi:', err?.message || err);
  }
}
