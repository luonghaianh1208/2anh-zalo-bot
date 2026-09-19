import {
  GUEST_REFUSAL, isHermesAttached, forwardToHermes, extractMediaUrls, extractText,
  rememberZaloMessage, sendSystemNotice,
} from './hermes-bridge.js';
import { ThreadType } from 'zca-js';
import { createStickerDirectory, enrichSticker } from './zalo-stickers.js';
import {
  emptyGuestGroups, emptyRoster, reloadGuestGroupsIfChanged, reloadRosterIfChanged,
} from './zalo-roster.js';

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
let activeRoster = emptyRoster();
let activeRosterPath = '';
let activeRosterState = null;
let activeGuestGroups = emptyGuestGroups();
let activeGuestGroupsPath = '';
let activeGuestGroupsState = null;

function refreshAuthorizationState() {
  if (activeRosterPath) {
    const next = reloadRosterIfChanged(activeRosterPath, activeRoster, activeRosterState);
    activeRoster = next.roster;
    activeRosterState = next.state;
  }
  if (activeGuestGroupsPath) {
    const next = reloadGuestGroupsIfChanged(
      activeGuestGroupsPath, activeGuestGroups, activeGuestGroupsState,
    );
    activeGuestGroups = next.groups;
    activeGuestGroupsState = next.state;
  }
}

function ownerUids() {
  return [...activeRoster.owners];
}

function audienceFor(senderUid, isGroup, threadId) {
  refreshAuthorizationState();
  if (activeRoster.owners.has(senderUid)) return 'owner';
  if (activeRoster.guests.has(senderUid) && isGroup && activeGuestGroups.has(String(threadId))) {
    return 'guest';
  }
  return null;
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

export function setupBotListener(
  api, profile = null,
  { health = null, restartDelaysMs = RESTART_DELAYS_MS, roster = null, guestGroups = null } = {},
) {
  selfUid = String(profile?.user_id ?? profile?.userId ?? '');
  activeRoster = roster || emptyRoster();
  activeRosterPath = roster ? String(process.env.ZALO_ROSTER_FILE || '') : '';
  activeRosterState = null;
  activeGuestGroups = guestGroups || emptyGuestGroups();
  activeGuestGroupsPath = guestGroups ? String(process.env.ZALO_GUEST_GROUPS_FILE || '') : '';
  activeGuestGroupsState = null;

  let stopped = false;
  let restartTimer = null;
  let restartAttempt = 0;

  const stickers = createStickerDirectory({
    fetchDetail: (id) => api.getStickersDetail(id),
  });

  const onMessage = (msg) => {
    handleIncomingMessage(api, msg, stickers).catch((err) => {
      console.error('[bot] lỗi khi xử lý tin nhắn:', err?.message || err);
    });
  };

  const onError = (err) => {
    console.error('[bot] listener error:', err?.message || err);
  };

  const onConnected = () => {
    restartAttempt = 0;
    health?.setListenerState('connected');
    console.log('[bot] 🔌 Zalo listener đã kết nối');
  };

  const onDisconnected = (code, reason) => {
    health?.setListenerState('reconnecting');
    console.warn(`[bot] ⚠️ Zalo listener mất kết nối (mã ${code}${reason ? `: ${reason}` : ''})`);
  };

  const onClosed = (code, reason) => {
    if (stopped) return;
    health?.setListenerState('closed');
    health?.recordError('zalo_listener_closed', `code ${code}`);
    console.error(`[bot] ❌ Zalo listener đã đóng (mã ${code}${reason ? `: ${reason}` : ''}) — không nhận được tin cho tới khi mở lại`);
    scheduleRestart();
  };

  const handlers = [
    ['message', onMessage],
    ['error', onError],
    ['connected', onConnected],
    ['disconnected', onDisconnected],
    ['closed', onClosed],
  ];
  for (const [event, handler] of handlers) api.listener.on(event, handler);

  function scheduleRestart() {
    if (stopped || restartTimer) return;
    const delay = restartDelaysMs[Math.min(restartAttempt, restartDelaysMs.length - 1)];
    restartAttempt += 1;
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
    restartTimer = null;
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
  if (msg.isSelf) return;
  const threadType = msg.type;
  const isGroup = threadType === ThreadType.Group;
  const threadId = String(msg.threadId || '');
  const senderUid = String(msg.data?.uidFrom ?? '');
  if (!threadId || !senderUid) {
    console.warn('[bot] discarded message with incomplete routing metadata');
    return;
  }

  const content = extractText(msg).trim();
  const mediaUrls = extractMediaUrls(msg);
  if (!content && !mediaUrls.length) return;

  // Bootstrap is a local owner-identity recovery path, never agent-visible state.
  if (!isHermesAttached() && !isGroup && content.toLowerCase() === '/sethome') {
    try {
      await sendSystemNotice({
        api, threadId, threadType,
        text: [
          `UID Zalo của bạn: ${senderUid}`,
          '',
          'Lệnh này chỉ tiết lộ UID và chưa cấp quyền chủ cho bạn.',
          'Thêm vào .env của Hermes:',
          `ZALO_ALLOWED_USERS=${senderUid}`,
          '',
          'Tuỳ chọn — nhận báo cáo định kỳ qua tin riêng:',
          `ZALO_HOME_CHANNEL=${senderUid}`,
          '',
          'Sau đó khởi động lại sidecar, rồi start/restart Hermes gateway.',
        ].join('\n'),
      });
    } catch (err) {
      console.error('[bot] bootstrap notice failed');
    }
    return;
  }

  // Mint audience before enrichment, history, or bridge fan-out. A guest never
  // falls back to the owner runtime when its isolated runtime is unavailable.
  const audience = audienceFor(senderUid, isGroup, threadId);
  if (!audience) {
    console.log('[bot] discarded denied message');
    return;
  }
  if (!isHermesAttached(audience)) {
    if (audience === 'guest') {
      await sendSystemNotice({ api, threadId, threadType, text: GUEST_REFUSAL });
      return;
    }
    if (!isAddressedToBot(msg, isGroup, senderUid)) return;
    const last = notified.get(threadId) || 0;
    if (Date.now() - last < NOTIFY_COOLDOWN_MS) return;
    notified.set(threadId, Date.now());
    try {
      await sendSystemNotice({
        api,
        threadId,
        threadType,
        text: 'Mình đang mất kết nối với bộ não xử lý nên chưa trả lời được. Bạn nhắn lại giúp mình sau ít phút nhé!',
      });
    } catch (err) {
      console.error('[bot] unavailable notice failed');
    }
    return;
  }

  await enrichSticker(msg, stickers);
  if (audience === 'guest') rememberZaloMessage(msg);
  forwardToHermes(msg, audience);
  console.log('[bot] forwarded admitted message');
  return;

}
