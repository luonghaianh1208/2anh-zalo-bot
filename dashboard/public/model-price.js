// Giá model (cổng AI trả `pricing`, vd. Stali): định dạng tiền Việt và ước tính chi phí một lượt gọi AI để khách so sánh.

/** Một lượt gọi AI của bot Zalo: lời nhắc hệ thống + công cụ + lịch sử khoảng 25.000 token vào, trả lời khoảng 600 token. */
export const TYPICAL_CALL = { input: 25_000, output: 600 };

const nf = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
export const vnd = (n) => `${nf.format(Math.round(n))}đ`;

/** Ước tính đồng cho một lượt gọi AI (không nhỏ hơn mức tối thiểu mỗi lượt). null khi không có giá. */
export function estimateCall(p, call = TYPICAL_CALL) {
  if (!p) return null;
  if (p.unit === 'request') return p.perRequest;
  return Math.max(p.min || 0, (call.input * p.input + call.output * p.output) / 1e6);
}

/** Nhãn ngắn cạnh tên model trong ô chọn. */
export function shortPrice(p) {
  if (!p) return '';
  if (p.unit === 'request') return `${vnd(p.perRequest)}/lượt`;
  return p.input === p.output ? `${vnd(p.input)}/1tr token` : `vào ${vnd(p.input)} · ra ${vnd(p.output)}/1tr token`;
}

/** Câu giải thích đầy đủ cho model đang chọn. */
export function priceSentence(p) {
  if (!p) return '';
  const est = `≈ ${vnd(estimateCall(p))} mỗi lượt gọi AI`;
  if (p.unit === 'request') return `${vnd(p.perRequest)} mỗi lượt gọi AI, không phụ thuộc độ dài.`;
  return `Vào ${vnd(p.input)} · ra ${vnd(p.output)} cho 1 triệu token${p.min ? `, tối thiểu ${vnd(p.min)}/lượt` : ''} — ${est}.`;
}

/** Hàng của bảng giá: lọc theo chữ (không dấu), rẻ trước. */
export function priceRows(prices, { q = '', fold = (s) => s.toLowerCase() } = {}) {
  const k = fold(q).trim();
  return Object.entries(prices || {})
    .map(([id, p]) => ({ id, name: p.name || '', p, est: estimateCall(p) }))
    .filter((r) => !k || fold(`${r.id} ${r.name}`).includes(k))
    .sort((a, b) => a.est - b.est || a.id.localeCompare(b.id));
}
