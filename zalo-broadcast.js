/**
 * Gửi một nội dung tới nhiều hội thoại (chăm sóc khách hàng, thông báo) theo nhịp chậm.
 *
 * Chạy trong sidecar chứ không ở trình duyệt: một đợt có thể kéo dài nhiều giờ hoặc nhiều ngày, đóng trang không được
 * làm dừng việc gửi. Trạng thái lưu ra data/broadcasts.json sau mỗi nơi, nên khởi động lại thì chạy tiếp.
 *
 * Mỗi nơi nhận tối đa một lần: đánh dấu `sending` TRƯỚC khi gửi; khởi động lại mà còn `sending` thì ghi `unknown`,
 * không gửi lại. Khách nhận trùng tin tệ hơn là thiếu một tin mà chủ bot nhìn thấy trong báo cáo.
 *
 * Nhịp gửi là giới hạn an toàn cho tài khoản Zalo, nên giãn cách, nghỉ theo tốp, chuỗi lỗi và trần ngày đều tính chung
 * cho cả tài khoản, không theo từng đợt: chia nhỏ thành nhiều đợt không lách được nhịp. Zalo chưa sẵn sàng thì chờ,
 * không tính là lỗi; lỗi liên tiếp thì dừng mọi đợt để chủ bot xem, vì gửi tiếp lúc Zalo đang từ chối là cách nhanh nhất
 * để mất tài khoản.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export const MAX_TARGETS = 500;
export const MAX_TEXT = 2000;
export const MAX_FAIL_STREAK = 5;
// zca-js không có hạn chờ: tệp không phải ảnh đợi tín hiệu từ WebSocket, mất tín hiệu là treo mãi cả hàng đợi.
export const SEND_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_PACE = { minDelayS: 45, maxDelayS: 90, batchSize: 20, batchRestMin: 15, dailyCap: 100, fromHour: 8, toHour: 21 };
const PACE_RANGE = {
  minDelayS: [15, 3600], maxDelayS: [15, 3600], batchSize: [1, 100], batchRestMin: [1, 240], dailyCap: [1, 300], fromHour: [0, 23], toHour: [1, 24],
};
const KEEP_FINISHED = 30;
const KEEP_DAYS = 7;
const RECHECK_MS = 60_000;
const FILE_GAP_MS = 2000;
const VN_OFFSET_MS = 7 * 3600_000;
const DAY_MS = 24 * 3600_000;
const HOUR_MS = 3600_000;

const invalid = (message) => Object.assign(new Error(message), { validation: true });

export function normalizePace(raw = {}) {
  const pace = { ...DEFAULT_PACE };
  for (const [key, [lo, hi]] of Object.entries(PACE_RANGE)) {
    if (raw?.[key] == null) continue;
    const value = Number(raw[key]);
    if (!Number.isInteger(value) || value < lo || value > hi) throw invalid(`Giá trị ${key} phải từ ${lo} đến ${hi}`);
    pace[key] = value;
  }
  if (pace.maxDelayS < pace.minDelayS) throw invalid('Giãn cách tối đa phải lớn hơn hoặc bằng tối thiểu');
  if (pace.toHour <= pace.fromHour) throw invalid('Giờ kết thúc phải sau giờ bắt đầu');
  return pace;
}

/** {ten} (hoặc {tên}) → tên người nhận hay tên nhóm; chưa biết tên thì "bạn". */
export function renderText(template, name) {
  return String(template).replace(/\{\s*t[eê]n\s*\}/giu, () => String(name || '').trim() || 'bạn');
}

export const vnDay = (ms) => new Date(ms + VN_OFFSET_MS).toISOString().slice(0, 10);

/** Thời điểm sớm nhất được gửi theo khung giờ (giờ Việt Nam), tính từ `ms`. */
export function nextOpenAt(ms, { fromHour, toHour }) {
  const local = ms + VN_OFFSET_MS;
  const midnight = Math.floor(local / DAY_MS) * DAY_MS;
  const hour = (local - midnight) / HOUR_MS;
  if (hour >= fromHour && hour < toHour) return ms;
  const day = hour < fromHour ? midnight : midnight + DAY_MS;
  return day + fromHour * HOUR_MS - VN_OFFSET_MS;
}

/** Đầu khung giờ của ngày hôm sau: lúc trần trong ngày được tính lại. */
function nextDayOpenAt(ms, { fromHour }) {
  const midnight = Math.floor((ms + VN_OFFSET_MS) / DAY_MS) * DAY_MS;
  return midnight + DAY_MS + fromHour * HOUR_MS - VN_OFFSET_MS;
}

export function readBroadcasts(path) {
  if (!existsSync(path)) return { jobs: [], sentByDay: {}, lastSentAt: 0 };
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(data?.jobs)) throw new Error('thiếu mảng jobs');
    return { sentByDay: {}, lastSentAt: 0, ...data };
  } catch (err) {
    const aside = `${path}.corrupt-${Date.now()}`; // trả rỗng rồi ghi đè là mất cả đợt đang chạy
    try { renameSync(path, aside); } catch { /* noop */ }
    console.warn(`[broadcast] tệp đợt gửi hỏng, đã cất sang ${aside}:`, err?.message || err);
    return { jobs: [], sentByDay: {}, lastSentAt: 0 };
  }
}

export function writeBroadcasts(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), 'utf8');
  renameSync(tmp, path);
}

/**
 * @param {{
 *   load: () => object, save: (data: object) => void,
 *   ready: () => boolean,
 *   sendText: (m: {threadId: string, threadType: number, text: string, actor: string}) => Promise<unknown>,
 *   sendFile: (m: {threadId: string, threadType: number, path: string, actor: string}) => Promise<unknown>,
 *   acquire?: () => Promise<void>,
 * }} options
 */
export function createBroadcastManager({
  load, save, ready, sendText, sendFile, acquire = async () => {},
  dropFile = (path) => rmSync(dirname(path), { recursive: true, force: true }),
  now = Date.now, random = Math.random, setTimer = setTimeout, clearTimer = clearTimeout,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const state = { nextAt: 0, restAt: 0, sinceRest: 0, failStreak: 0, ...load() };
  let timer = null;
  let busy = false;
  let stopped = true;

  const persist = () => save(state);
  const find = (id) => state.jobs.find((j) => j.id === String(id));
  const active = () => state.jobs.find((j) => j.status === 'running');
  const sentToday = () => state.sentByDay[vnDay(now())] || 0;
  const pending = (job) => job.targets.find((t) => t.status === 'pending');

  function schedule(ms) {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      tick().catch((err) => {
        console.error('[broadcast] lỗi khi chạy đợt gửi:', err?.message || err);
        schedule(RECHECK_MS);
      });
    }, Math.max(0, ms));
    timer?.unref?.();
  }

  function finish(job, status, note = '') {
    job.status = status;
    job.finishedAt = now();
    job.wait = null;
    if (note) job.note = note;
  }

  // Xoá tệp đính kèm khi đợt đã kết thúc; lúc đang gửi dở thì để cuối lượt tick làm.
  function cleanup() {
    if (busy) return;
    for (const job of state.jobs) {
      if (!job.file?.path || !['done', 'cancelled'].includes(job.status)) continue;
      try { dropFile(job.file.path); } catch (err) { console.warn('[broadcast] không xoá được tệp đính kèm:', err?.message || err); }
      job.file = { name: job.file.name };
    }
    const finished = state.jobs.filter((j) => j.finishedAt).sort((a, b) => b.finishedAt - a.finishedAt);
    const drop = new Set(finished.slice(KEEP_FINISHED).map((j) => j.id));
    state.jobs = state.jobs.filter((j) => !drop.has(j.id));
  }

  /** Việc phải chờ trước lần gửi kế tiếp, null nếu gửi được ngay. */
  function blockedBy(job, t) {
    if (!ready()) return { reason: 'zalo', until: t + RECHECK_MS };
    const open = nextOpenAt(t, job.pace);
    if (open > t) return { reason: 'hours', until: open };
    if (sentToday() >= job.pace.dailyCap) return { reason: 'daily', until: nextDayOpenAt(t, job.pace) };
    const gap = Math.max(state.nextAt, (state.lastSentAt || 0) + job.pace.minDelayS * 1000);
    if (gap > t) return { reason: state.restAt && state.restAt === state.nextAt ? 'batch' : 'delay', until: gap };
    return null;
  }

  /** Tính một lần cho mỗi nơi vào trần ngày và giãn cách, kể cả khi lần gửi đó lỗi: Zalo vẫn thấy một lần gọi. */
  function countAttempt(target) {
    if (target.counted) return;
    target.counted = true;
    const t = now();
    state.lastSentAt = t;
    const day = vnDay(t);
    state.sentByDay[day] = (state.sentByDay[day] || 0) + 1;
    for (const key of Object.keys(state.sentByDay).sort().slice(0, -KEEP_DAYS)) delete state.sentByDay[key];
  }

  async function deliver(job, target, run) {
    // Chờ lượt gửi có thể lâu: trong lúc đó phiên có thể rớt, chủ bot có thể bấm dừng.
    const check = () => {
      if (run.dead || job.status !== 'running' || !ready()) throw Object.assign(new Error('Dừng gửi'), { code: 'not_ready' });
    };
    const base = { threadId: target.id, threadType: target.type, actor: job.actor };
    const text = renderText(job.text, target.name);
    if (text && !target.textSent) {
      await acquire();
      check();
      await sendText({ ...base, text });
      target.textSent = true; // ghi ngay: lần thử lại sau khi rớt phiên chỉ được gửi tệp
      countAttempt(target);
      try { persist(); } catch (err) { console.warn('[broadcast] chưa ghi được trạng thái:', err?.message || err); }
    }
    if (job.file?.path) {
      if (target.textSent) await sleep(FILE_GAP_MS);
      await acquire();
      check();
      await sendFile({ ...base, path: job.file.path });
    }
  }

  async function sendNext(job, target) {
    target.status = 'sending';
    job.wait = null;
    try {
      persist();
    } catch (err) {
      console.error('[broadcast] không ghi được trạng thái:', err?.message || err);
      target.status = 'pending'; // không ghi được "sending" thì không được gửi: mất dấu là có thể gửi trùng
      job.status = 'paused';
      job.note = 'Chưa ghi được trạng thái đợt gửi, có thể máy chủ đầy đĩa. Dọn máy chủ rồi bấm Tiếp tục.';
      return;
    }
    busy = true;
    const run = { dead: false };
    let guard;
    const hang = new Promise((_, reject) => {
      guard = setTimer(() => {
        run.dead = true;
        reject(Object.assign(new Error('Zalo không phản hồi sau 5 phút'), { code: 'timeout' }));
      }, SEND_TIMEOUT_MS);
    });
    try {
      await Promise.race([deliver(job, target, run), hang]);
      target.status = 'sent';
      state.failStreak = 0;
    } catch (err) {
      if (err?.code === 'not_ready') {
        target.status = 'pending';
        state.nextAt = now() + RECHECK_MS;
        if (target.textSent && job.status === 'cancelled') {
          target.status = 'failed';
          target.error = 'Đã gửi chữ, chưa gửi tệp';
        }
        return;
      }
      target.status = err?.code === 'timeout' ? 'unknown' : 'failed'; // treo: có thể Zalo đã nhận, không gửi lại
      target.error = String(err?.message || err).slice(0, 200);
      state.failStreak += 1;
    } finally {
      clearTimer(guard);
      busy = false;
    }
    countAttempt(target);
    const t = now();
    target.at = t;
    state.sinceRest += 1;
    const { minDelayS, maxDelayS, batchSize, batchRestMin } = job.pace;
    const delayMs = Math.round((minDelayS + random() * (maxDelayS - minDelayS)) * 1000);
    const rest = state.sinceRest >= batchSize;
    state.nextAt = t + delayMs + (rest ? batchRestMin * 60_000 : 0);
    state.restAt = rest ? state.nextAt : 0;
    if (rest) state.sinceRest = 0;
  }

  async function tick() {
    if (busy) return;
    const job = active();
    if (!job) { cleanup(); persist(); return; }
    const target = pending(job);
    if (!target) {
      finish(job, 'done');
      cleanup(); persist();
      schedule(0);
      return;
    }
    const block = blockedBy(job, now());
    if (block) {
      job.wait = block;
      persist();
      schedule(Math.min(block.until - now(), RECHECK_MS));
      return;
    }
    await sendNext(job, target);
    if (state.failStreak >= MAX_FAIL_STREAK) {
      state.failStreak = 0;
      for (const j of state.jobs.filter((x) => x.status === 'running')) {
        j.status = 'paused';
        j.wait = null;
        j.note = `Tự tạm dừng vì ${MAX_FAIL_STREAK} nơi liên tiếp gửi lỗi. Kiểm tra tài khoản Zalo rồi bấm Tiếp tục.`;
      }
    }
    if (job.status === 'running' && !pending(job)) finish(job, 'done');
    cleanup(); persist();
    schedule(0);
  }

  function create({ text = '', file = null, targets = [], pace = {}, actor = '' }) {
    const body = String(text).trim();
    if (!body && !file) throw invalid('Cần nội dung hoặc tệp đính kèm');
    if (body.length > MAX_TEXT) throw invalid(`Nội dung quá ${MAX_TEXT} ký tự`);
    const seen = new Set();
    const list = [];
    for (const t of targets) {
      const id = String(t?.id ?? '');
      if (!/^\d{1,32}$/.test(id) || (t?.type !== 0 && t?.type !== 1)) throw invalid('Danh sách người nhận không hợp lệ');
      const key = `${t.type}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ id, type: t.type, name: String(t.name || '').slice(0, 100), status: 'pending' });
    }
    if (!list.length) throw invalid('Chưa chọn nơi nhận');
    if (list.length > MAX_TARGETS) throw invalid(`Tối đa ${MAX_TARGETS} nơi nhận mỗi đợt`);
    const dup = state.jobs.find((j) => ['running', 'paused'].includes(j.status) && j.text === body && j.file?.name === file?.name
      && j.targets.some((t) => seen.has(`${t.type}:${t.id}`)));
    if (dup) throw invalid('Đã có một đợt đang chạy với đúng nội dung này tới một số nơi đã chọn');
    const job = {
      id: `bc-${now().toString(36)}-${randomBytes(3).toString('hex')}`,
      actor: String(actor), text: body, file, pace: normalizePace(pace), status: 'running',
      createdAt: now(), finishedAt: null, note: '', wait: null, targets: list,
    };
    state.jobs.push(job);
    try {
      persist();
    } catch (err) {
      state.jobs.pop(); // dashboard sẽ báo lỗi và xoá tệp: đợt này không được chạy ngầm
      throw err;
    }
    schedule(0);
    return view(job);
  }

  function counts(job) {
    const out = { total: job.targets.length, sent: 0, failed: 0, unknown: 0, pending: 0 };
    for (const t of job.targets) {
      if (t.status === 'sent' || t.status === 'failed' || t.status === 'unknown') out[t.status] += 1;
      else out.pending += 1;
    }
    return out;
  }

  function view(job) {
    const running = active();
    const { file, targets, ...rest } = job;
    return {
      ...rest, fileName: file?.name || '', counts: counts(job),
      queued: job.status === 'running' && running?.id !== job.id,
      issues: targets.filter((t) => t.status === 'failed' || t.status === 'unknown')
        .map((t) => ({ name: t.name, type: t.type, status: t.status, error: t.error || '' })),
    };
  }

  function need(id) {
    const job = find(id);
    if (!job) throw invalid('Không thấy đợt gửi này');
    return job;
  }

  function pause(id) {
    const job = need(id);
    if (job.status !== 'running') throw invalid('Đợt này không chạy');
    job.status = 'paused';
    job.wait = null;
    job.note = '';
    persist();
    schedule(0);
    return view(job);
  }

  function resume(id) {
    const job = need(id);
    if (job.status !== 'paused') throw invalid('Đợt này không tạm dừng');
    job.status = 'running';
    state.failStreak = 0;
    job.note = '';
    persist();
    schedule(0);
    return view(job);
  }

  function cancel(id) {
    const job = need(id);
    if (job.status !== 'running' && job.status !== 'paused') throw invalid('Đợt này đã kết thúc');
    finish(job, 'cancelled');
    cleanup();
    persist();
    schedule(0);
    return view(job);
  }

  function start() {
    stopped = false;
    let touched = false;
    for (const job of state.jobs) {
      for (const t of job.targets) {
        if (t.status !== 'sending') continue;
        t.status = 'unknown'; // đứt giữa lúc gửi: không biết Zalo đã nhận chưa, không gửi lại
        t.error = 'Bot khởi động lại đúng lúc đang gửi';
        countAttempt(t); // tin có thể đã tới Zalo: vẫn tính vào trần ngày và giãn cách
        touched = true;
      }
    }
    if (touched) persist();
    schedule(0);
  }

  function stop() {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
  }

  return {
    create, pause, resume, cancel, start, stop, tick,
    list: () => ({ jobs: state.jobs.map(view).reverse(), sentToday: sentToday() }),
  };
}
