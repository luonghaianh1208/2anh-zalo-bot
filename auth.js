import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'url';
import { Zalo } from 'zca-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = join(__dirname, 'data', 'session.json');

export async function loadSession() {
  try {
    if (!existsSync(SESSION_FILE)) return null;
    const raw = await readFile(SESSION_FILE, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error('[auth] không đọc được session:', err.message);
    return null;
  }
}

export async function saveSession(credentials, loginInfo) {
  try {
    await mkdir(dirname(SESSION_FILE), { recursive: true });
    const existing = await loadSession();
    const payload = {
      savedAt: Date.now(),
      credentials: credentials || existing?.credentials || null,
      loginInfo: loginInfo || existing?.loginInfo || null,
    };
    await writeFile(SESSION_FILE, JSON.stringify(payload, null, 2), 'utf8');
    const who = payload.loginInfo?.display_name || payload.loginInfo?.zaloName || '(chưa rõ tên)';
    console.log(`[auth] 💾 đã lưu phiên — ${who}`);
    return true;
  } catch (err) {
    console.error('[auth] không lưu được session:', err.message);
    return false;
  }
}

export async function clearSession() {
  try {
    if (existsSync(SESSION_FILE)) await rm(SESSION_FILE, { force: true });
    console.log('[auth] đã xoá phiên đăng nhập');
  } catch (err) {
    console.error('[auth] không xoá được session:', err.message);
  }
}

/**
 * Chỉ giữ những gì dashboard và cầu nối cần. Hồ sơ này hiện ở /api/status và
 * gửi sang Hermes, nên không được mang số điện thoại của tài khoản bot theo.
 */
export function pickProfile(info) {
  if (!info) return null;
  return {
    user_id: String(info.user_id ?? ''),
    display_name: info.display_name || '',
    avatar: info.avatar || '',
  };
}

/**
 * Lấy hồ sơ tài khoản đang đăng nhập.
 *
 * zca-js v2.1.2 KHÔNG gán `this.ctx` trên instance Zalo, và class API cũng
 * không có thuộc tính `loginInfo` — nên cách duy nhất lấy được tên/UID là hỏi
 * thẳng server qua fetchAccountInfo().
 */
export async function fetchProfile(api) {
  try {
    if (typeof api?.fetchAccountInfo !== 'function') return null;
    const info = await api.fetchAccountInfo();
    const p = info?.profile;
    if (!p) return null;
    return {
      user_id: String(p.userId ?? p.uid ?? ''),
      display_name: p.displayName || p.zaloName || p.username || '',
      avatar: p.avatar || '',
    };
  } catch (err) {
    console.warn('[auth] không lấy được hồ sơ:', err.message);
    return null;
  }
}

/** Đăng nhập lại bằng cookie đã lưu. Trả về null nếu cookie hết hạn. */
export async function tryReconnect() {
  const data = await loadSession();
  if (!data?.credentials?.cookie) return null;

  console.log('[auth] đang kết nối lại bằng phiên đã lưu...');
  const zalo = new Zalo({ logging: false, selfListen: true });
  try {
    const api = await zalo.login({
      cookie: data.credentials.cookie,
      imei: data.credentials.imei,
      userAgent: data.credentials.userAgent,
      language: data.credentials.language || 'vi',
    });

    // Hồ sơ cũ có thể thiếu (phiên bản trước lưu null) — lấy lại từ server.
    // Phiên lưu từ bản cũ còn kèm số điện thoại, nên lọc lại trước khi dùng.
    let loginInfo = pickProfile(data.loginInfo);
    if (!loginInfo?.user_id) {
      loginInfo = await fetchProfile(api);
      if (loginInfo) await saveSession(data.credentials, loginInfo);
    }

    console.log(`[auth] ✅ kết nối lại OK — ${loginInfo?.display_name || '(chưa rõ tên)'}`);
    return { zalo, api, loginInfo };
  } catch (err) {
    console.warn('[auth] ⚠️ kết nối lại thất bại (cookie hết hạn?):', err.message);
    // Giữ lại file để không mất credentials — người dùng quét QR lại sẽ ghi đè.
    return null;
  }
}
