/**
 * Dọn bản Hermes cũ. Mỗi lần cập nhật, Hermes dựng một môi trường Python mới (~1 GB) trong
 * HERMES_HOME/installs/<mã>/environments/<mã 32 hex>/ và không xoá bản cũ — VPS 29 GB từng đầy 94% sau 5 ngày.
 *
 * Luôn giữ: môi trường ghi trong installs/<mã>/facts.json (bản đang dùng), mọi môi trường đang có tiến trình
 * Python nạp thư viện (Linux: /proc/<pid>/maps; Windows: danh sách module của python*.exe), và GIU_MOI_NHAT bản
 * mới nhất. Phần còn lại xoá được. Dùng chung cho nút "Dọn ngay" ở Bảo trì và lần dọn tự động mỗi ngày.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const GIU_MOI_NHAT = 3;
const MA_MT = /environments[\\/]+([0-9a-f]{32})/gi;
const MA = /^[0-9a-f]{32}$/i;

/** Mọi môi trường: [{ id, dir, at }] (at = thời điểm sửa thư mục, mới nhất trước). */
export function listEnvs(hermesHome) {
  const root = join(hermesHome, 'installs');
  if (!existsSync(root)) return [];
  const ra = [];
  for (const install of readdirSync(root, { withFileTypes: true })) {
    if (!install.isDirectory()) continue;
    const envRoot = join(root, install.name, 'environments');
    if (!existsSync(envRoot)) continue;
    for (const e of readdirSync(envRoot, { withFileTypes: true })) {
      if (!e.isDirectory() || !MA.test(e.name)) continue;
      const dir = join(envRoot, e.name);
      let at = 0;
      try { at = statSync(dir).mtimeMs; } catch { /* vừa bị xoá */ }
      ra.push({ id: e.name.toLowerCase(), dir, at });
    }
  }
  return ra.sort((a, b) => b.at - a.at);
}

/** Mã môi trường trong facts.json của từng bản cài (bản Hermes đang dùng). */
export function activeIds(hermesHome) {
  const ids = new Set();
  const root = join(hermesHome, 'installs');
  if (!existsSync(root)) return ids;
  for (const install of readdirSync(root, { withFileTypes: true })) {
    if (!install.isDirectory()) continue;
    try {
      for (const m of readFileSync(join(root, install.name, 'facts.json'), 'utf8').matchAll(MA_MT)) ids.add(m[1].toLowerCase());
    } catch { /* bản cài chưa có facts.json */ }
  }
  return ids;
}

/** Môi trường đang có tiến trình nạp thư viện. Lỗi đọc thì trả tập rỗng — vẫn còn facts.json và bản mới nhất. */
export async function inUseIds({ platform = process.platform, readProc = readProcMaps, listWinModules = winModules } = {}) {
  const text = platform === 'win32' ? await listWinModules() : readProc();
  return new Set([...String(text || '').matchAll(MA_MT)].map((m) => m[1].toLowerCase()));
}

function readProcMaps() {
  let out = '';
  let pids = [];
  try { pids = readdirSync('/proc').filter((p) => /^\d+$/.test(p)); } catch { return ''; }
  for (const pid of pids) {
    try {
      const maps = readFileSync(`/proc/${pid}/maps`, 'utf8');
      if (maps.includes('environments')) out += maps.split('\n').filter((l) => l.includes('environments')).join('\n') + '\n';
    } catch { /* tiến trình đã thoát hoặc không đọc được */ }
  }
  return out;
}

function winModules() {
  const ps = 'Get-Process python* -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Modules.FileName } catch {} }';
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (e, stdout) => resolve(e ? '' : stdout));
  });
}

/** Kế hoạch: { keep: [{id, why}], remove: [{id, dir}], total }. */
export function plan(envs, active, inUse, giu = GIU_MOI_NHAT) {
  const keep = new Map();
  envs.forEach((e, i) => {
    const why = [active.has(e.id) && 'đang dùng', inUse.has(e.id) && 'có tiến trình', i < giu && 'mới nhất'].filter(Boolean);
    if (why.length) keep.set(e.id, why.join(', '));
  });
  return {
    total: envs.length,
    keep: envs.filter((e) => keep.has(e.id)).map((e) => ({ id: e.id, why: keep.get(e.id), at: e.at })),
    remove: envs.filter((e) => !keep.has(e.id)).map((e) => ({ id: e.id, dir: e.dir, at: e.at })),
  };
}

export function diskFree(path) {
  try { const s = statfsSync(path); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch { return null; }
}

export function createHermesEnvs({ hermesHome, inUse = inUseIds, rm = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 2 }), now = Date.now }) {
  let running = false;
  let last = null;
  async function status() {
    const p = plan(listEnvs(hermesHome), activeIds(hermesHome), await inUse());
    return { total: p.total, keep: p.keep, removable: p.remove.length, disk: diskFree(hermesHome), last, running };
  }
  /** Dọn theo kế hoạch tính NGAY lúc dọn. `by`: 'tay' | 'tu-dong'. */
  async function clean(by = 'tay') {
    if (running) throw Object.assign(new Error('Đang dọn rồi — chờ xong đã.'), { statusCode: 409 });
    running = true;
    try {
      const truoc = diskFree(hermesHome);
      const p = plan(listEnvs(hermesHome), activeIds(hermesHome), await inUse());
      const loi = [];
      let xoa = 0;
      for (const e of p.remove) {
        try { rm(e.dir); xoa += 1; } catch (err) { loi.push(`${e.id.slice(0, 8)}: ${err.code || err.message}`); }
      }
      const sau = diskFree(hermesHome);
      last = { at: now(), by, removed: xoa, kept: p.keep.length, failed: loi, freed: truoc && sau ? Math.max(0, sau.free - truoc.free) : null };
      return last;
    } finally { running = false; }
  }
  return { status, clean, get last() { return last; } };
}
