// Phần tính toán của trang Gửi hàng loạt: mức nhịp có sẵn, ước tính thời gian, người nhận theo thư mục.

// Zalo không công bố ngưỡng chặn, nên các mức này là lựa chọn thận trọng chứ không phải con số an toàn tuyệt đối.
export const PACE_PRESETS = [
  { value: 'slow', label: 'Rất chậm', hint: 'Dùng khi tài khoản mới hoặc từng bị hạn chế.',
    pace: { minDelayS: 90, maxDelayS: 180, batchSize: 10, batchRestMin: 30, dailyCap: 50, fromHour: 8, toHour: 21 } },
  { value: 'safe', label: 'An toàn', hint: 'Mức nên dùng cho hầu hết các đợt.',
    pace: { minDelayS: 45, maxDelayS: 90, batchSize: 20, batchRestMin: 15, dailyCap: 100, fromHour: 8, toHour: 21 } },
  { value: 'fast', label: 'Nhanh hơn', hint: 'Rủi ro cao hơn. Chỉ dùng với người quen, đã từng nhắn qua lại.',
    pace: { minDelayS: 25, maxDelayS: 45, batchSize: 30, batchRestMin: 10, dailyCap: 200, fromHour: 8, toHour: 21 } },
];

export const PACE_FIELDS = [
  { key: 'minDelayS', label: 'Giãn cách ít nhất (giây)', min: 15, max: 3600 },
  { key: 'maxDelayS', label: 'Giãn cách nhiều nhất (giây)', min: 15, max: 3600 },
  { key: 'batchSize', label: 'Số nơi mỗi tốp', min: 1, max: 100 },
  { key: 'batchRestMin', label: 'Nghỉ sau mỗi tốp (phút)', min: 1, max: 240 },
  { key: 'dailyCap', label: 'Tối đa mỗi ngày', min: 1, max: 300 },
  { key: 'fromHour', label: 'Bắt đầu gửi từ (giờ)', min: 0, max: 23 },
  { key: 'toHour', label: 'Dừng gửi lúc (giờ)', min: 1, max: 24 },
];

/** Thời gian ước tính để gửi `n` nơi. Số ngày tính theo trần ngày và độ dài khung giờ, lấy cái lâu hơn. */
export function estimateMs(n, pace) {
  if (n <= 0) return { activeMs: 0, days: 0 };
  const gapS = (pace.minDelayS + pace.maxDelayS) / 2;
  const rests = Math.floor((n - 1) / pace.batchSize);
  const activeMs = ((n - 1) * gapS + rests * pace.batchRestMin * 60) * 1000;
  const windowMs = (pace.toHour - pace.fromHour) * 3600_000;
  return { activeMs, days: Math.max(Math.ceil(n / pace.dailyCap), Math.ceil(activeMs / windowMs) || 1) };
}

export function estimateText(n, pace) {
  if (n <= 0) return '';
  const { activeMs, days } = estimateMs(n, pace);
  if (days > 1) return `khoảng ${days} ngày`;
  const minutes = Math.max(1, Math.round(activeMs / 60_000));
  if (minutes < 60) return `khoảng ${minutes} phút`;
  const h = Math.floor(minutes / 60);
  return `khoảng ${h} giờ${minutes % 60 ? ` ${minutes % 60} phút` : ''}`;
}

/** Nơi nhận của các thư mục đã chọn: `who` là 'all' | 'groups' | 'people'. Mỗi nơi một lần dù nằm ở nhiều thư mục. */
export function folderTargets(folders, picked, who, { groups, people }) {
  const name = new Map([...groups.map((g) => [`1:${g.id}`, g.name]), ...people.map((p) => [`0:${p.uid}`, p.name])]);
  const out = new Map();
  for (const f of folders) {
    if (!picked.has(f.id)) continue;
    if (who !== 'people') for (const id of f.groups) out.set(`1:${id}`, { id, type: 1, name: name.get(`1:${id}`) || '' });
    if (who !== 'groups') for (const uid of f.people) out.set(`0:${uid}`, { id: uid, type: 0, name: name.get(`0:${uid}`) || '' });
  }
  return [...out.values()];
}

/** "3 nhóm, 12 người" */
export function targetSummary(targets) {
  const g = targets.filter((t) => t.type === 1).length;
  const p = targets.length - g;
  return [g ? `${g} nhóm` : '', p ? `${p} người` : ''].filter(Boolean).join(', ');
}

/** Bản xem trước: cùng quy tắc với zalo-broadcast.js renderText. */
export const previewText = (template, name) => String(template).replace(/\{\s*t[eê]n\s*\}/giu, () => String(name || '').trim() || 'bạn');
