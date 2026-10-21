import { createHash, randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { readJson, writeJsonAtomic } from './json-store.js';
import { describeUserAgent } from './user-agent.js';

const sha = (t) => createHash('sha256').update(String(t)).digest('hex');
// Mã công khai của phiên (hiện trên danh sách thiết bị, dùng để đăng xuất từ xa): băm lần nữa từ khoá lưu trữ,
// không suy ngược ra token. Phiên cũ (trước khi có danh sách thiết bị) cũng có mã mà không phải chuyển đổi tệp.
const publicId = (key) => sha(`session:${key}`).slice(0, 20);
const clip = (v, n) => String(v || '').slice(0, n);

// Dấu vết tệp: đổi khi tiến trình khác (vd. dashboard:reset-admin) ghi lại tệp.
// Gồm cả ino vì ghi nguyên tử bằng rename tạo tệp mới.
function fingerprint(path) {
  try { const s = statSync(path); return `${s.mtimeMs}:${s.size}:${s.ino}`; } catch { return 'none'; }
}

export function createSessionStore(path, { now = Date.now, ttlMs = 7 * 24 * 3600_000, idleMs = 12 * 3600_000 } = {}) {
  let data = readJson(path, { sessions: {} });
  let seen = fingerprint(path);
  let lastFlush = 0;
  // Đọc lại khi tệp đã bị tiến trình khác sửa — nếu không, bản trong bộ nhớ sẽ ghi đè
  // và làm sống lại các phiên mà CLI vừa gỡ.
  const sync = () => {
    const fp = fingerprint(path);
    if (fp !== seen) { data = readJson(path, { sessions: {} }); seen = fp; }
  };
  const flush = () => { writeJsonAtomic(path, data); seen = fingerprint(path); lastFlush = now(); };
  const alive = (s, t) => s && t - s.createdAt < ttlMs && t - s.lastSeen < idleMs;
  return {
    /** meta: { ua, ip, method } — thiết bị và cách đăng nhập, chỉ để hiển thị. */
    create(username, meta = {}) {
      sync();
      const token = randomBytes(32).toString('base64url');
      const t = now();
      for (const [k, s] of Object.entries(data.sessions)) if (!alive(s, t)) delete data.sessions[k];
      data.sessions[sha(token)] = { username, createdAt: t, lastSeen: t, ua: clip(meta.ua, 400), ip: clip(meta.ip, 64), method: clip(meta.method, 32) };
      flush();
      return token;
    },
    get(token, ip = '') {
      if (!token) return null;
      sync();
      const key = sha(token);
      const s = data.sessions[key];
      const t = now();
      if (!alive(s, t)) { if (s) { delete data.sessions[key]; flush(); } return null; }
      s.lastSeen = t;
      if (ip) s.ip = clip(ip, 64);
      if (t - lastFlush > 60_000) flush();
      return { username: s.username, id: publicId(key) };
    },
    /** Phiên còn hiệu lực, mới hoạt động trước. Bỏ trống username = mọi tài khoản (chỉ Quản trị gọi). */
    list(username) {
      sync();
      const t = now();
      return Object.entries(data.sessions)
        .filter(([, s]) => alive(s, t) && (!username || s.username === username))
        .map(([k, s]) => ({
          id: publicId(k), username: s.username, device: describeUserAgent(s.ua),
          ip: s.ip || '', method: s.method || '', createdAt: s.createdAt, lastSeen: s.lastSeen,
        }))
        .sort((a, b) => b.lastSeen - a.lastSeen);
    },
    /** Đăng xuất một phiên theo mã công khai; username giới hạn chỉ được gỡ phiên của chính tài khoản đó. */
    destroyById(id, username) {
      sync();
      const hit = Object.entries(data.sessions).find(([k, s]) => publicId(k) === String(id) && (!username || s.username === username));
      if (!hit) return null;
      delete data.sessions[hit[0]];
      flush();
      return { username: hit[1].username, device: describeUserAgent(hit[1].ua).label };
    },
    destroy(token) { sync(); delete data.sessions[sha(token)]; flush(); },
    destroyAll(username) {
      sync();
      for (const [k, s] of Object.entries(data.sessions)) if (s.username === username) delete data.sessions[k];
      flush();
    },
  };
}
