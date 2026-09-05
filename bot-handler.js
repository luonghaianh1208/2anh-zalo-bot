import { loadBotConfig, saveBotConfig, loadPersonas } from './config-manager.js';
import { formatZaloMarkdown } from './markdown-formatter.js';
import { pickSmartReaction } from './smart-reaction.js';
import { BRAIN } from './brain-config.js';
import { isHermesAttached, forwardToHermes } from './hermes-bridge.js';
import { ThreadType } from 'zca-js';

// Lịch sử hội thoại theo từng thread (nhóm hoặc DM)
const conversationHistory = new Map();
const MAX_HISTORY_TURNS = 10;

/**
 * UID Zalo là chuỗi số dài (17-20 chữ số) và không bao giờ bắt đầu bằng '0'.
 * Số điện thoại Việt Nam thì ngược lại. Cấu hình cũ hay bị điền nhầm số điện
 * thoại vào adminUids — nhận diện để bỏ qua thay vì hiểu nhầm thành chủ nhân.
 */
function isZaloUid(value) {
  const s = String(value ?? '').trim();
  return /^[1-9]\d{14,21}$/.test(s);
}

function normalizeUidList(list, label) {
  if (!Array.isArray(list)) return [];
  const valid = [];
  const invalid = [];
  for (const item of list) {
    (isZaloUid(item) ? valid : invalid).push(String(item));
  }
  if (invalid.length) {
    console.warn(
      `[bot] ⚠️ ${label} có ${invalid.length} giá trị không phải UID Zalo (bỏ qua): ${invalid.join(', ')}\n` +
      '        UID Zalo là dãy số dài, không phải số điện thoại. Gõ /sethome để gán lại chủ nhân.'
    );
  }
  return valid;
}

export function setupBotListener(api) {
  if (!api?.listener) {
    console.warn('[bot] ❌ api.listener không tồn tại — bot sẽ không nhận được tin nhắn');
    return;
  }

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

/**
 * Quyết định có nên trả lời tin nhắn này không.
 * Trả về { reply: boolean, reason: string } — reason để log, tiện chẩn đoán.
 *
 * Mặc định FAIL-CLOSED giống gateway Telegram của Hermes: người lạ nhắn riêng
 * thì im lặng, trong nhóm thì chỉ trả lời khi được tag.
 */
function decideReply({ isGroup, isOwner, isMentioned, isAllowed, g, groupCfg }) {
  // Bot bị tắt toàn cục / tắt riêng nhóm này
  const enabled = groupCfg.enabled !== undefined ? groupCfg.enabled : g.enabled !== false;
  if (!enabled) return { reply: false, reason: 'bot đang tắt' };

  // Chế độ chỉ nghe, không nói
  const silent = groupCfg.silentListenOnly !== undefined
    ? groupCfg.silentListenOnly
    : !!g.silentListenOnly;
  if (silent) return { reply: false, reason: 'silent mode' };

  if (isGroup) {
    const onlyTagged = groupCfg.replyOnlyTagged !== undefined
      ? groupCfg.replyOnlyTagged
      : g.replyOnlyTagged !== false;
    if (onlyTagged && !isMentioned) {
      return { reply: false, reason: 'nhóm: chưa được tag' };
    }
    return { reply: true, reason: isMentioned ? 'nhóm: được tag' : 'nhóm: mở' };
  }

  // --- Tin nhắn riêng (DM) ---
  const dmPolicy = g.dmPolicy || 'owner-only';
  if (isOwner) return { reply: true, reason: 'DM: chủ nhân' };
  if (dmPolicy === 'open') return { reply: true, reason: 'DM: mở cho tất cả' };
  if (dmPolicy === 'allowlist' && isAllowed) return { reply: true, reason: 'DM: trong allowlist' };
  return { reply: false, reason: `DM: người lạ bị chặn (dmPolicy=${dmPolicy})` };
}

async function handleIncomingMessage(api, msg) {
  if (msg.isSelf) return;

  const content = typeof msg.data?.content === 'string' ? msg.data.content.trim() : '';
  if (!content) return;

  // ── Định tuyến thread ────────────────────────────────────────────────────
  // zca-js đã tính sẵn msg.threadId và msg.type cho cả hai loại hội thoại.
  // (Trước đây code đọc msg.isGroup — property KHÔNG tồn tại — nên mọi tin
  //  nhắn nhóm đều bị trả lời vào DM của người gửi.)
  const threadType = msg.type;
  const isGroup = threadType === ThreadType.Group;
  const threadId = msg.threadId;
  const senderUid = String(msg.data?.uidFrom ?? '');
  const senderName = msg.data?.dName || 'bạn';

  if (!threadId) {
    console.warn('[bot] bỏ qua: không xác định được threadId');
    return;
  }

  const config = await loadBotConfig();
  const g = config.global || {};
  const groupCfg = isGroup ? (config.groups?.[threadId] || {}) : {};

  const adminUids = normalizeUidList(g.adminUids, 'adminUids');
  const allowedUids = normalizeUidList(g.allowedUids, 'allowedUids');
  const isOwner = adminUids.includes(senderUid);
  const isAllowed = allowedUids.includes(senderUid);

  const where = isGroup ? `Nhóm ${threadId}` : `DM ${threadId}`;
  console.log(`[bot] 📩 [${where}] ${senderName} (${senderUid}): ${content.slice(0, 80)}`);

  // Hermes đang cắm thì nhường toàn bộ quyền trả lời cho nó — Hermes có đủ
  // tools/memory/skills, còn bot nội bộ chỉ là LLM thuần. Nhường sớm ở đây để
  // không trả lời hai lần và không tốn thêm một lượt gọi LLM.
  if (isHermesAttached()) {
    forwardToHermes(msg);
    console.log('[bot] ➡️ đã chuyển cho Hermes Agent');
    return;
  }

  // ── Lệnh /sethome — nhận diện chủ nhân ───────────────────────────────────
  if (/^\/?sethome$/i.test(content)) {
    await handleSetHome({ api, msg, config, g, adminUids, senderUid, senderName, threadId, threadType });
    return;
  }

  // ── Phát hiện tag trong nhóm ─────────────────────────────────────────────
  let isMentioned = false;
  if (isGroup) {
    const mentions = msg.data?.mentions;
    if (Array.isArray(mentions) && mentions.length > 0) isMentioned = true;
    const lower = content.toLowerCase();
    if (lower.includes('@bot') || lower === 'bot' || lower.startsWith('bot ')) isMentioned = true;
  }

  // ── Quyết định trả lời ───────────────────────────────────────────────────
  const decision = decideReply({ isGroup, isOwner, isMentioned, isAllowed, g, groupCfg });
  if (!decision.reply) {
    console.log(`[bot] 🔇 bỏ qua — ${decision.reason}`);
    return;
  }

  // ── Báo đã đọc ───────────────────────────────────────────────────────────
  await safe('sendSeenEvent', async () => {
    const d = msg.data;
    await api.sendSeenEvent({
      msgId: d.msgId,
      cliMsgId: d.cliMsgId,
      uidFrom: d.uidFrom,
      idTo: d.idTo,
      msgType: d.msgType,
      st: d.st,
      at: d.at,
      cmd: d.cmd,
      ts: d.ts,
    }, threadType);
  });

  // ── Thả cảm xúc ──────────────────────────────────────────────────────────
  await safe('addReaction', async () => {
    if (!msg.data?.msgId) return;
    await api.addReaction(pickSmartReaction(content), {
      data: { msgId: msg.data.msgId, cliMsgId: msg.data.cliMsgId },
      threadId,
      type: threadType,
    });
  });

  // ── Hiệu ứng đang soạn tin ───────────────────────────────────────────────
  await safe('sendTypingEvent', () => api.sendTypingEvent(threadId, threadType));

  // ── Hỏi bộ não ───────────────────────────────────────────────────────────
  const personas = await loadPersonas();
  const personaKey = groupCfg.persona || g.persona || 'friendly';
  const persona = personas[personaKey] || personas.friendly || {};

  const cleanText = content.replace(/@bot/gi, '').trim();
  const answer = await askHermesBrain({
    prompt: cleanText,
    senderName,
    persona,
    isOwner,
    threadId,
    ownerName: g.ownerName || '',
    orgName: g.orgName || '',
  });

  // ── Trả lời ĐÚNG nơi được hỏi ────────────────────────────────────────────
  const formatted = formatZaloMarkdown(answer);
  await api.sendMessage(
    { msg: formatted.msg, styles: formatted.styles, quote: msg.data },
    threadId,
    threadType
  );
  console.log(`[bot] ✅ đã trả lời vào ${where}`);
}

/**
 * /sethome — gán quyền chủ nhân.
 * Lần đầu (chưa có admin nào) thì ai gõ trước thành chủ. Sau đó chỉ chủ hiện
 * tại mới thêm được người khác, tránh người lạ tự nhận quyền.
 */
async function handleSetHome({ api, msg, config, g, adminUids, senderUid, senderName, threadId, threadType }) {
  const isFirstClaim = adminUids.length === 0;
  const isOwner = adminUids.includes(senderUid);

  if (!isFirstClaim && !isOwner) {
    console.log(`[bot] 🔇 từ chối /sethome từ người lạ ${senderName} (${senderUid})`);
    return; // im lặng, không tiết lộ có lệnh này
  }

  if (!isZaloUid(senderUid)) {
    console.warn(`[bot] ⚠️ /sethome: UID không hợp lệ (${senderUid}), bỏ qua`);
    return;
  }

  if (!isOwner) {
    // Ghi đè bằng danh sách đã lọc — đồng thời dọn luôn giá trị rác cũ.
    config.global = { ...g, adminUids: [...adminUids, senderUid] };
    await saveBotConfig(config);
    console.log(`[bot] 👑 đã gán chủ nhân: ${senderName} (${senderUid})`);
  }

  const raw = `👑 Dạ em đã nhận diện [green]${senderName}[/green] (UID: ${senderUid}) là [red]CHỦ NHÂN[/red] của Hermes Agent rồi ạ!\n\nAnh cần gì cứ nhắn em nhé ✨`;
  const formatted = formatZaloMarkdown(raw);
  await api.sendMessage(
    { msg: formatted.msg, styles: formatted.styles, quote: msg.data },
    threadId,
    threadType
  );
}

async function askHermesBrain({ prompt, senderName, persona, isOwner, threadId, ownerName = '', orgName = '' }) {
  if (!BRAIN.apiKey) {
    return 'Dạ em đang không kết nối được tới bộ não AI (thiếu API key). Anh kiểm tra giúp em file cấu hình Hermes nhé.';
  }

  // Danh tính chủ nhân lấy từ cấu hình, không viết cứng trong mã — mỗi bản
  // triển khai là một người/đơn vị khác nhau.
  const owner = [ownerName, orgName].filter(Boolean).join(' — ');
  const intro = owner
    ? `Bạn là Hermes Agent — trợ lý AI cá nhân của ${owner}.`
    : 'Bạn là Hermes Agent — một trợ lý AI cá nhân.';

  const systemInstruction = `${intro}
Vai trò hiện tại: ${persona.name || 'Trợ lý Zalo'}.
Người đang trò chuyện: ${senderName}${isOwner ? ' — ĐÂY LÀ CHỦ NHÂN của bạn' : ''}.
Chỉ dẫn vai trò: ${persona.system_prompt || 'Thông minh, sắc bén, chu đáo.'}
Văn phong: ${persona.tone || 'Lịch sự, nhiệt huyết, đúng trọng tâm'}.

Quy tắc trình bày trên Zalo:
1. ${isOwner ? 'Xưng "em", gọi "anh".' : 'Xưng "em", gọi người dùng lịch sự theo tên.'}
2. Trả lời trực diện, đúng trọng tâm, không lan man.
3. Định dạng:
   - [red]nội dung quan trọng, cảnh báo[/red] → chữ đỏ đậm
   - [green]kết quả tốt, thành công[/green] → chữ xanh lá đậm
   - [orange]lưu ý vừa[/orange] / [yellow]ghi chú nhẹ[/yellow]
   - **từ khoá, con số quan trọng** → in đậm
   - Danh sách chính dùng 1. 2. kèm emoji; ý phụ dùng gạch đầu dòng.`;

  if (!conversationHistory.has(threadId)) conversationHistory.set(threadId, []);
  const history = conversationHistory.get(threadId);
  history.push({ role: 'user', content: prompt });
  while (history.length > MAX_HISTORY_TURNS) history.shift();

  try {
    const res = await fetch(`${BRAIN.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${BRAIN.apiKey}`,
      },
      body: JSON.stringify({
        model: BRAIN.model,
        messages: [{ role: 'system', content: systemInstruction }, ...history],
        stream: false,
        temperature: persona.creativity !== undefined ? persona.creativity : 0.7,
        max_tokens: 1500,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[brain] ❌ HTTP ${res.status}: ${body.slice(0, 200)}`);
      history.pop(); // đừng giữ lượt hỏi đã thất bại
      return res.status === 401
        ? 'Dạ em chưa xác thực được với bộ não AI (lỗi 401). Anh kiểm tra lại API key giúp em ạ.'
        : `Dạ bộ não AI đang bận (lỗi ${res.status}). Anh thử lại sau chút nhé.`;
    }

    const text = await res.text();
    const answer = parseLLMResponse(text);

    if (answer) {
      history.push({ role: 'assistant', content: answer });
      return answer;
    }
    history.pop();
    return 'Dạ em chưa nghĩ ra câu trả lời phù hợp. Anh hỏi lại rõ hơn giúp em nhé.';
  } catch (err) {
    console.error('[brain] ❌ không gọi được:', err.message);
    history.pop();
    return 'Dạ em đang mất kết nối tới bộ não AI. Anh kiểm tra 9router giúp em nhé.';
  }
}

/** Chấp nhận cả JSON thường lẫn stream SSE. */
function parseLLMResponse(text) {
  if (!text) return '';
  if (text.startsWith('data:')) {
    let out = '';
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
      try {
        const chunk = JSON.parse(line.slice(5).trim());
        out += chunk.choices?.[0]?.delta?.content || '';
      } catch { /* bỏ qua dòng hỏng */ }
    }
    return out.trim();
  }
  try {
    return (JSON.parse(text).choices?.[0]?.message?.content || '').trim();
  } catch {
    return '';
  }
}

/** Chạy tác vụ phụ, lỗi thì ghi log chứ không làm chết luồng trả lời. */
async function safe(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.warn(`[bot] ${label} lỗi: ${err?.message || err}`);
  }
}
