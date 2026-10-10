/**
 * Tự cập nhật 2anh-zalo-bot lên một bản phát hành (bấm từ dashboard › Bảo trì). Chạy thành tiến trình riêng vì nó
 * khởi động lại cả dashboard. Các bước:
 *   1. Sao lưu cài đặt (hermes-admin backup.create) + ghi nhận bản đang chạy (git: commit; không git: nén mã nguồn).
 *   2. Lấy mã mới: git checkout <tag> (bản cài git), hoặc tải gói phát hành từ GitHub và giải nén đè (giữ .env, data/).
 *   3. `npm ci` nếu package-lock đổi; chạy bộ cài `install-hermes.js --no-dashboard` của MÃ MỚI (chép plugin, dựng
 *      plugin.yaml, bổ sung config, tự kiểm tra).
 *   4. Khởi động lại kết nối Zalo → trợ lý → dashboard; chờ khoẻ (kết nối Zalo trả lời, trợ lý đã nối, dashboard sống).
 *   5. Không khoẻ / lỗi giữa chừng → quay về bản cũ (cùng các bước) và báo lỗi.
 * Trạng thái ghi ra tệp JSON, nhật ký ra tệp .log — dashboard đọc để hiện tiến độ.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const REPO = 'luonghaianh1208/2anh-zalo-bot';
export const TAG = /^v\d+\.\d+\.\d+$/;
const HEALTH_TIMEOUT_MS = 180_000;

const hashFile = (p) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : '');

export function writeState(file, state) {
  writeFileSync(file, JSON.stringify(state, null, 2));
}

/**
 * deps: { log(text), run(cmd, args, opts) → Promise (ném lỗi khi mã thoát ≠ 0), download(url, dest), backup() → tên tệp,
 *         restartSidecar(), restartAssistant(), restartDashboard(), healthy() → Promise<{ ok, detail }>, sleep(ms), now() }
 */
export async function runSelfUpdate({ root, hermesHome, to, from = '', stateFile, tmpDir, deps }) {
  const { log, run, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = deps;
  if (!TAG.test(to)) throw new Error(`Phiên bản không hợp lệ: ${to}`);
  const state = { status: 'running', from, to, startedAt: now(), finishedAt: 0, error: '', step: '' };
  const step = (s) => { state.step = s; writeState(stateFile, state); log(`— ${s}`); };
  const lockFile = join(root, 'package-lock.json');
  const useGit = existsSync(join(root, '.git'));
  let rollback = null;

  async function fetchCode(tag) {
    if (useGit) {
      await run('git', ['fetch', '-q', '--tags', 'origin'], { cwd: root });
      await run('git', ['checkout', '-q', tag], { cwd: root });
    } else {
      const tgz = join(tmpDir, `2anh-zalo-bot-${tag}.tar.gz`);
      await deps.download(`https://codeload.github.com/${REPO}/tar.gz/refs/tags/${tag}`, tgz);
      await run('tar', ['-xzf', tgz, '-C', root, '--strip-components=1'], { cwd: root });
    }
  }
  async function installCode(lockBefore) {
    if (hashFile(lockFile) !== lockBefore) {
      log('Thư viện thay đổi — chạy npm ci');
      await run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: root, shell: process.platform === 'win32' });
    }
    await run(process.execPath, [join(root, 'scripts', 'install-hermes.js'), '--hermes-home', hermesHome, '--sidecar-root', root, '--no-dashboard'], { cwd: root });
  }
  async function restartAll() {
    log('Khởi động lại kết nối Zalo…'); await deps.restartSidecar();
    log('Khởi động lại trợ lý…'); await deps.restartAssistant();
    log('Khởi động lại dashboard…'); await deps.restartDashboard();
  }
  async function waitHealthy() {
    const until = now() + HEALTH_TIMEOUT_MS;
    let last = '';
    while (now() < until) {
      const h = await deps.healthy().catch((e) => ({ ok: false, detail: e.message }));
      if (h.ok) return;
      if (h.detail !== last) { log(`Chờ: ${h.detail}`); last = h.detail; }
      await sleep(5000);
    }
    throw new Error(`Sau ${HEALTH_TIMEOUT_MS / 1000} giây bot vẫn chưa chạy lại bình thường (${last}).`);
  }

  try {
    log(`Cập nhật 2anh-zalo-bot ${from || '(bản hiện tại)'} → ${to} (${useGit ? 'git' : 'gói phát hành'})`);
    if (useGit) {
      const dirty = (await run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root })).trim();
      if (dirty) throw new Error('Mã nguồn trên máy có sửa đổi chưa commit — người cài đặt cần xử lý trước khi cập nhật.');
    }
    step('Sao lưu cài đặt');
    log(`Đã sao lưu: ${await deps.backup()}`);
    const lockBefore = hashFile(lockFile);
    if (useGit) {
      const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim();
      rollback = async () => { await run('git', ['checkout', '-q', head], { cwd: root }); };
    } else {
      const code = join(tmpDir, 'code-before-update.tar.gz');
      await run('tar', ['-czf', code, '--exclude=./node_modules', '--exclude=./data', '--exclude=./.env', '-C', root, '.'], { cwd: root });
      rollback = async () => { await run('tar', ['-xzf', code, '-C', root], { cwd: root }); };
    }
    step(`Tải mã ${to}`);
    await fetchCode(to);
    step('Cài đặt');
    await installCode(lockBefore);
    step('Khởi động lại');
    await restartAll();
    step('Kiểm tra');
    await waitHealthy();
    Object.assign(state, { status: 'done', finishedAt: now(), step: 'Xong' });
    writeState(stateFile, state);
    log(`Đã cập nhật lên ${to}.`);
    return state;
  } catch (err) {
    log(`LỖI: ${err.message}`);
    state.error = err.message;
    if (!rollback) {
      Object.assign(state, { status: 'failed', finishedAt: now() });
      writeState(stateFile, state);
      return state;
    }
    try {
      step('Quay về bản cũ');
      const lockNow = hashFile(lockFile);
      await rollback();
      await installCode(lockNow);
      await restartAll();
      await waitHealthy();
      Object.assign(state, { status: 'rolled-back', finishedAt: now() });
      log('Đã quay về bản cũ, bot chạy lại bình thường.');
    } catch (e2) {
      Object.assign(state, { status: 'failed', finishedAt: now(), error: `${err.message} — quay về bản cũ cũng lỗi: ${e2.message}` });
      log(`LỖI khi quay về: ${e2.message}`);
    }
    writeState(stateFile, state);
    return state;
  }
}
