import { isHermesAttached, forwardToHermes, extractText } from './hermes-bridge.js';
import { ThreadType } from 'zca-js';

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

/** Ai được nghe câu báo lỗi khi Hermes chưa sẵn sàng (UID Zalo, phân tách bởi dấu phẩy). */
const ownerUids = String(process.env.ZALO_ALLOWED_USERS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Đừng lặp lại câu báo lỗi. Một người hỏi năm lần trong lúc Hermes đang rớt
 * thì chỉ nên nghe một lần — nhắc lại vừa phiền vừa tính vào hạn mức chống
 * spam.
 */
const notified = new Map();
const NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;

export function setupBotListener(api, profile = null) {
  if (!api?.listener) {
    console.warn('[bot] ❌ api.listener không tồn tại — bot sẽ không nhận được tin nhắn');
    return;
  }
  selfUid = String(profile?.user_id ?? profile?.userId ?? '');

  api.listener.on('message', (msg) => {
    handleIncomingMessage(api, msg).catch((err) => {
      console.error('[bot] lỗi khi xử lý tin nhắn:', err?.message || err);
    });
  });

  api.listener.on('error', (err) => {
    console.error('[bot] listener error:', err?.message || err);
  });

  try {
    api.listener.start();
    console.log('[bot] 🚀 Zalo listener đã chạy');
  } catch (err) {
    console.error('[bot] không start được listener:', err.message);
  }
}

/** Tin này có gọi đích danh bot không (tag trong nhóm, hoặc chủ nhân nhắn riêng). */
function isAddressedToBot(msg, isGroup, senderUid) {
  if (!isGroup) return ownerUids.includes(senderUid);
  const mentions = Array.isArray(msg.data?.mentions) ? msg.data.mentions : [];
  return selfUid ? mentions.some((m) => String(m?.uid ?? '') === selfUid) : false;
}

async function handleIncomingMessage(api, msg) {
  if (msg.isSelf) return;

  // Dùng chung bộ rút chữ với cầu nối: tin có link hay tệp thì content là
  // object chứ không phải chuỗi, lọc theo chuỗi ở đây là vứt mất tin trước
  // cả khi Hermes kịp nhìn thấy.
  const content = extractText(msg).trim();
  if (!content) return;

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

  const where = isGroup ? `Nhóm ${threadId}` : `DM ${threadId}`;
  console.log(`[bot] 📩 [${where}] ${msg.data?.dName || '?'} (${senderUid}): ${content.slice(0, 80)}`);

  if (isHermesAttached()) {
    forwardToHermes(msg);
    console.log('[bot] ➡️ đã chuyển cho Hermes Agent');
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
    await api.sendMessage(
      { msg: 'Mình đang mất kết nối với bộ não xử lý nên chưa trả lời được 😔 Bạn nhắn lại giúp mình sau ít phút nhé!' },
      threadId,
      threadType,
    );
  } catch (err) {
    console.error('[bot] không gửi được thông báo lỗi:', err?.message || err);
  }
}
