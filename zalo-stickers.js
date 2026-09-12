/**
 * Đọc nhãn dán (sticker) của Zalo.
 *
 * Vì sao cần: tin sticker tới dưới dạng `chat.sticker` mà nội dung chỉ có ba
 * con số `{id, catId, type}` — không chữ, không ảnh. Bộ rút chữ trả về rỗng,
 * bot-handler thấy tin rỗng thì bỏ luôn, nên bot không hề biết có người vừa
 * gửi sticker. Nhìn từ phía người dùng là "bot không đọc được sticker".
 *
 * Cách chữa: hỏi Zalo chi tiết của cái id đó (`getStickersDetail`) để lấy nhãn
 * chữ và ảnh tĩnh, rồi gắn thẳng vào khung tin. Từ đó mọi tầng phía sau —
 * lưu lịch sử, rút chữ, phân loại đính kèm — đọc được như một tin bình thường.
 */

const LOOKUP_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 500;

export function isStickerMessage(msgType) {
  return /sticker/i.test(String(msgType ?? ''));
}

/** Lấy `{id, cateId, type}` của sticker trong một khung tin, hoặc null. */
export function stickerRefOf(msg) {
  if (!isStickerMessage(msg?.data?.msgType)) return null;
  const content = msg?.data?.content;
  if (!content || typeof content !== 'object') return null;
  const id = Number(content.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return {
    id,
    cateId: Number(content.catId ?? content.cateId) || 0,
    type: Number(content.type) || 0,
  };
}

// Trường `text` của Zalo thường không phải chữ cho người đọc mà là mã nội bộ
// dạng `[^10751.27703^]` (đo trên sticker thật, 13/9/2026). In mã đó ra thì vô
// nghĩa với model lẫn người xem lịch sử, nên bỏ — ý nghĩa nằm ở ảnh sticker.
const CODE_LABEL_RE = /^\[\^[\d.]+\^\]$/;

/** Chữ thay cho tin sticker. Không có nhãn đọc được thì vẫn nói rõ là có sticker. */
export function stickerText(detail) {
  const label = String(detail?.text ?? '').trim();
  return label && !CODE_LABEL_RE.test(label) ? `[Nhãn dán: ${label}]` : '[Nhãn dán]';
}

/**
 * Ảnh tĩnh của sticker, để model nhìn được cả hình lẫn chữ vẽ trong đó.
 * Dùng `stickerUrl` chứ không dùng bản webp động: bản động nhiều khung, tầng
 * ảnh của Hermes chỉ đọc được khung đầu.
 */
export function stickerAttachment(detail) {
  const url = String(detail?.stickerUrl ?? '').trim();
  if (!url) return null;
  return {
    url,
    name: `sticker-${detail?.id ?? ''}.png`.replace('-.png', '.png'),
    mime: 'image/png',
    kind: 'image',
  };
}

/**
 * Nhớ tạm chi tiết sticker theo id. Nhãn dán gần như không đổi nên nhớ lâu;
 * một nhóm vui có thể gửi vài chục sticker một lúc, tra lại từng cái vừa chậm
 * vừa tốn hạn mức gọi Zalo.
 *
 * Tra hỏng hoặc quá lâu thì trả null — tin vẫn đi tiếp, chỉ là không có nhãn.
 */
export function createStickerDirectory({
  fetchDetail,
  ttlMs = CACHE_TTL_MS,
  limit = CACHE_LIMIT,
  timeoutMs = LOOKUP_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  const cache = new Map();
  return {
    async get(id) {
      const key = String(id);
      const hit = cache.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.detail;
      let detail = null;
      let timer = null;
      try {
        detail = await Promise.race([
          Promise.resolve(fetchDetail(Number(id))),
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('quá thời gian chờ')), timeoutMs);
          }),
        ]);
      } catch (err) {
        console.warn('[bot] không tra được nhãn dán %s: %s', key, err?.message || err);
        return hit?.detail ?? null;
      } finally {
        clearTimeout(timer);
      }
      // getStickersDetail nhận một id nhưng trả về mảng.
      const first = Array.isArray(detail) ? detail[0] : detail;
      if (!first || typeof first !== 'object') return hit?.detail ?? null;
      if (cache.size >= limit) cache.delete(cache.keys().next().value);
      cache.set(key, { at: now(), detail: first });
      return first;
    },
    clear() { cache.clear(); },
  };
}

/**
 * Gắn nhãn dán đã tra được vào khung tin, ngay tại chỗ.
 *
 * Gắn vào khung thay vì truyền tham số riêng để mọi tầng phía sau (lưu lịch
 * sử, rút chữ, dựng gói cho Hermes) đọc được cùng một nguồn, không tầng nào
 * phải biết thêm một đường dây mới.
 */
export async function enrichSticker(msg, directory) {
  const ref = stickerRefOf(msg);
  if (!ref) return null;
  // Tra hỏng thì vẫn gắn nhãn trống: tin sticker không có chữ nào, không gắn
  // gì là bot-handler bỏ luôn tin và bot lại điếc trước sticker như cũ.
  const detail = directory ? await directory.get(ref.id) : null;
  const info = {
    id: ref.id,
    text: stickerText(detail),
    attachment: detail ? stickerAttachment(detail) : null,
  };
  msg.data.__sticker = info;
  return info;
}
