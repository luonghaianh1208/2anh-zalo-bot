/**
 * Bảo trì (chỉ Quản trị): phiên bản + cập nhật, và nơi giữ bản sao lưu cài đặt.
 * - Bot Zalo (2anh-zalo-bot): phiên bản trong plugin.yaml đã cài; bản mới nhất từ GitHub Releases (repo công khai,
 *   lưu đệm 1 giờ). Cập nhật bot: chạy tách rời scripts/self-update.js (sao lưu → mã mới → cài → khởi động lại →
 *   kiểm tra, hỏng thì tự quay về bản cũ); chỉ lên đúng bản mới nhất.
 * - Hermes: `hermes --version`, `hermes update --check` (bấm mới chạy, ~10 giây). Cập nhật: chạy tách rời
 *   `hermes update --yes --backup` (Hermes tự chụp điểm khôi phục + sao lưu trước), ghi nhật ký ra tệp để xem tiến độ.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitSpawned } from './spawn-detached.js';

export const RELEASES_URL = 'https://api.github.com/repos/luonghaianh1208/2anh-zalo-bot/releases/latest';
export const BACKUP_FILE = /^hermes-zalo-\d{8}-\d{6}(-[a-z0-9-]{1,30})?\.zip$/;
const HOUR = 3600_000;
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });

/** "version: 2.7.0" trong plugin.yaml → "2.7.0". */
export function pluginVersion(text) {
  return /^version:\s*['"]?([\w.+-]+)/m.exec(String(text || ''))?.[1] || '';
}

/** So hai phiên bản dạng x.y.z (bỏ "v"): >0 nếu a mới hơn b. */
export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/** Kết quả `hermes update --check` → 'available' | 'current' | 'unknown'. */
export function parseUpdateCheck(out) {
  const t = String(out || '').replace(ANSI, '');
  if (/update available|behind origin/i.test(t)) return 'available';
  if (/up to date|already (on the )?latest|no updates?/i.test(t)) return 'current';
  return 'unknown';
}

const run = (file, args, opts) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, timeout: 60_000, ...opts }, (e, stdout, stderr) => resolve({ ok: !e, out: `${stdout || ''}${stderr || ''}` }));
});

export function createMaintenance({
  hermesBin, pluginYaml = () => '', dataDir, sidecarRoot = '', fetchImpl = globalThis.fetch, runImpl = run, spawnImpl = spawn, now = Date.now,
  platform = process.platform, useSystemdRun = () => existsSync('/run/systemd/system') && process.getuid?.() === 0,
}) {
  const botStateFile = join(dataDir, 'bot-update.json');
  const botLogFile = join(dataDir, 'bot-update.log');
  const backupDir = join(dataDir, 'backups');
  const stateFile = join(dataDir, 'hermes-update.json');
  const logFile = join(dataDir, 'hermes-update.log');
  let latest = null; // { at, value }
  let hermesCheck = null; // { at, status }

  async function latestRelease(fresh = false) {
    if (latest && now() - latest.at < (fresh ? 60_000 : HOUR)) return latest.value; // trang Bảo trì: gần như luôn hỏi mới
    let value = null;
    try {
      const res = await fetchImpl(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': '2anh-zalo-dashboard' }, signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const j = await res.json();
        value = { tag: String(j.tag_name || ''), name: String(j.name || ''), url: String(j.html_url || ''), notes: String(j.body || '').slice(0, 6000), publishedAt: j.published_at || '' };
      }
    } catch { /* mất mạng → không biết bản mới */ }
    latest = { at: now(), value };
    return value;
  }

  function updateState() {
    let s = {};
    try { s = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* chưa cập nhật lần nào */ }
    let running = false;
    if (s.pid && !s.finishedAt) { try { process.kill(s.pid, 0); running = true; } catch { running = false; } }
    let log = '';
    try { log = readFileSync(logFile, 'utf8').replace(ANSI, '').split(/\r?\n/).filter((l) => l.trim()).slice(-40).join('\n'); } catch { /* chưa có */ }
    return { startedAt: s.startedAt || 0, running, log };
  }

  /** Trạng thái cập nhật bot (scripts/self-update.js ghi). Kẹt "running" quá 30 phút coi như hỏng. */
  function botUpdateState() {
    let s = {};
    try { s = JSON.parse(readFileSync(botStateFile, 'utf8')); } catch { /* chưa cập nhật lần nào */ }
    const stale = s.status === 'running' && now() - (s.startedAt || 0) > 30 * 60_000;
    let log = '';
    try { log = readFileSync(botLogFile, 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(-60).join('\n'); } catch { /* chưa có */ }
    return { status: stale ? 'failed' : (s.status || ''), from: s.from || '', to: s.to || '', step: s.step || '', error: stale ? 'Cập nhật dừng giữa chừng.' : (s.error || ''),
      startedAt: s.startedAt || 0, finishedAt: s.finishedAt || 0, running: s.status === 'running' && !stale, log };
  }

  async function botNotice(fresh = false) {
    const current = pluginVersion(pluginYaml());
    const rel = await latestRelease(fresh);
    return { current, latest: rel?.tag || '', newer: Boolean(rel?.tag && current && compareVersions(rel.tag, current) > 0), updating: botUpdateState().running };
  }

  return {
    backupDir,
    async versions() {
      const bot = pluginVersion(pluginYaml());
      const rel = await latestRelease(true);
      let hermes = '';
      const v = await runImpl(hermesBin, ['--version']);
      if (v.ok) hermes = v.out.replace(ANSI, '').split(/\r?\n/)[0].trim().slice(0, 200);
      return {
        bot: { version: bot, latest: rel, newer: Boolean(rel?.tag && bot && compareVersions(rel.tag, bot) > 0) },
        hermes: { version: hermes, check: hermesCheck },
        update: updateState(),
        botUpdate: botUpdateState(),
      };
    },
    async checkHermes() {
      const r = await runImpl(hermesBin, ['update', '--check'], { timeout: 90_000 });
      hermesCheck = { at: now(), status: parseUpdateCheck(r.out) };
      return hermesCheck;
    },
    async updateHermes() {
      if (updateState().running) throw fail(409, 'Hermes đang cập nhật — chờ xong rồi xem lại.');
      mkdirSync(dataDir, { recursive: true });
      const fd = openSync(logFile, 'w');
      const child = spawnImpl(hermesBin, ['update', '--yes', '--backup'], { detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: { ...process.env, NO_COLOR: '1' } });
      await waitSpawned(child);
      writeFileSync(stateFile, JSON.stringify({ pid: child.pid, startedAt: now() }));
      hermesCheck = null;
      return updateState();
    },
    updateState,
    botUpdateState,
    botNotice,
    /** Cập nhật bot lên đúng bản mới nhất trên GitHub: chạy scripts/self-update.js tách khỏi dashboard. */
    async updateBot(to) {
      const n = await botNotice(true); // hỏi lại GitHub: bản mới nhất có thể vừa ra
      if (!n.newer || to !== n.latest) throw fail(400, 'Chỉ cập nhật được lên bản mới nhất — tải lại trang.');
      if (botUpdateState().running) throw fail(409, 'Bot đang cập nhật — chờ xong rồi xem lại.');
      if (!sidecarRoot) throw fail(503, 'Không biết thư mục cài bot trên máy này.');
      const script = join(sidecarRoot, 'scripts', 'self-update.js');
      if (!existsSync(script)) throw fail(503, 'Bản cài này chưa có trình cập nhật — người cài đặt cập nhật thủ công một lần.');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(botStateFile, JSON.stringify({ status: 'running', from: n.current, to, startedAt: now(), step: 'Bắt đầu' }));
      writeFileSync(botLogFile, '');
      const argv = [script, '--to', to, '--from', n.current];
      // Linux + systemd: chạy thành unit riêng — `systemctl restart zalo-dashboard` sẽ không giết trình cập nhật.
      const viaSystemd = platform !== 'win32' && useSystemdRun();
      const child = viaSystemd
        ? spawnImpl('systemd-run', ['--unit', `zalo-bot-update-${now()}`, '--collect', '--quiet', `--working-directory=${sidecarRoot}`, process.execPath, ...argv], { windowsHide: true, stdio: 'ignore' })
        : spawnImpl(process.execPath, argv, { cwd: sidecarRoot, detached: true, windowsHide: true, stdio: 'ignore' });
      // systemd-run thoát ngay sau khi giao việc; mã ≠ 0 = không chạy được unit → báo lỗi thay vì treo "đang cập nhật".
      if (viaSystemd) {
        child.once?.('exit', (code) => {
          if (code && botUpdateState().running) writeFileSync(botStateFile, JSON.stringify({ status: 'failed', from: n.current, to, startedAt: now(), finishedAt: now(), error: `systemd-run lỗi (mã ${code})` }));
        });
      }
      await waitSpawned(child);
      return botUpdateState();
    },
    backups() {
      if (!existsSync(backupDir)) return [];
      return readdirSync(backupDir).filter((f) => BACKUP_FILE.test(f)).sort().reverse()
        .map((f) => { const st = statSync(join(backupDir, f)); return { file: f, size: st.size, at: st.mtimeMs }; });
    },
    backupPath(file) {
      if (!BACKUP_FILE.test(String(file || ''))) throw fail(400, 'Tên bản sao lưu không hợp lệ.');
      const p = join(backupDir, file);
      if (!existsSync(p)) throw fail(404, 'Không còn bản sao lưu này — tải lại trang.');
      return p;
    },
  };
}
