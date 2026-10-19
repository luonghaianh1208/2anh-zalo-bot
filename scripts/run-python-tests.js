#!/usr/bin/env node
// Chạy 12 test suite Python của repo (test_zalo_adapter.py, test_zalo_media.py, test_zalo_pdf.py, test_zalo_academic.py, test_zalo_open_data.py, test_zalo_memory_drift.py, test_zalo_reply_style.py, test_zalo_memory_tags.py, test_zalo_freshness.py, test_zalo_model_command.py, test_zalo_permissions.py, test_zalo_studio.py, test_zalo_insight.py, test_zalo_memory.py, test_zalo_keypool.py, test_dashboard_hermes_admin.py, scripts/test_lay_token_facebook.py,
// tts/test_vieneu_provider.py) mà `node --test` không bao giờ đụng tới.
//
// Dò Python theo thứ tự: biến PYTHON (nếu đặt, dùng đúng nó, không âm thầm rơi xuống lựa chọn
// khác — để mô phỏng "máy chưa cài Python" bằng PYTHON=/khong/ton/tai vẫn đúng ý) → venv của
// Hermes qua HERMES_HOME → python3 → python.
// Không tìm thấy Python nào chạy được: cảnh báo rõ ràng rồi thoát 0, không làm hỏng `npm test`
// trên máy khách chưa cài Python.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { platform, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hermesRuntimePython, resolveHermesLayout } from './hermes-install-lib.js';
import { loadRepoEnv } from './setup-env.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const envPath = join(REPO_ROOT, '.env');
if (existsSync(envPath)) loadRepoEnv(envPath);

function worksAsPython(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  return result.status === 0;
}

function hermesLayout() {
  try { return resolveHermesLayout(); } catch { return null; }
}

// Hermes mới: Python của môi trường do Hermes quản lý (ngoài mã Hermes); Hermes cũ: venv trong mã Hermes.
function hermesVenvPython() {
  const layout = hermesLayout();
  if (!layout) return null;
  const managed = hermesRuntimePython(layout, layout.home);
  if (managed && existsSync(managed)) return managed;
  const { repoRoot } = layout;
  const candidates = platform() === 'win32'
    ? [join(repoRoot, 'venv', 'Scripts', 'python.exe'), join(repoRoot, '.venv', 'Scripts', 'python.exe')]
    : [join(repoRoot, 'venv', 'bin', 'python'), join(repoRoot, '.venv', 'bin', 'python')];
  return candidates.find(existsSync) || null;
}

function findPython() {
  // PYTHON được đặt tường minh: tin tưởng đúng nó, không rơi xuống lựa chọn khác nếu nó hỏng.
  if (process.env.PYTHON) {
    return worksAsPython(process.env.PYTHON) ? process.env.PYTHON : null;
  }
  const venvPython = hermesVenvPython();
  if (venvPython && worksAsPython(venvPython)) return venvPython;
  for (const candidate of ['python3', 'python']) {
    if (worksAsPython(candidate)) return candidate;
  }
  return null;
}

const python = findPython();
if (!python) {
  console.warn(
    '[test:py] CẢNH BÁO: không tìm thấy Python khả dụng — BỎ QUA 11 test suite Python\n'
    + '[test:py]   (test_zalo_adapter.py, test_zalo_media.py, test_zalo_pdf.py, test_zalo_academic.py, test_zalo_open_data.py, test_zalo_memory_drift.py, test_zalo_reply_style.py, test_zalo_memory_tags.py, test_zalo_freshness.py, test_zalo_model_command.py, test_zalo_permissions.py, test_zalo_studio.py, test_zalo_insight.py, test_zalo_memory.py, test_zalo_keypool.py, test_dashboard_hermes_admin.py, scripts/test_lay_token_facebook.py, tts/test_vieneu_provider.py).\n'
    + '[test:py]   Lớp phân quyền/bảo mật của hermes-plugin/zalo/adapter.py CHƯA được kiểm chứng trong lần chạy này.\n'
    + '[test:py]   Cài Python (hoặc đặt biến PYTHON) rồi chạy lại `npm run test:py` để test thật sự chạy.',
  );
  process.exit(0);
}

console.log(`[test:py] Dùng Python: ${python}`);

const suites = [
  // Suite adapter import lõi Hermes (gateway) và jsonschema. Python hệ thống trên
  // bản clone mới không có hai thứ đó — bỏ qua kèm cảnh báo thay vì báo đỏ cả npm test.
  { label: 'test_zalo_adapter.py', module: 'test_zalo_adapter', cwd: REPO_ROOT, requires: 'import gateway, jsonschema' },
  { label: 'test_zalo_media.py', module: 'test_zalo_media', cwd: REPO_ROOT, requires: 'import gateway, lxml, httpx' },
  { label: 'test_zalo_video_edit.py', module: 'test_zalo_video_edit', cwd: REPO_ROOT, requires: 'import gateway, lxml, httpx' },
  { label: 'test_zalo_group_safety.py', module: 'test_zalo_group_safety', cwd: REPO_ROOT, requires: 'import gateway' },
  { label: 'test_zalo_pdf.py', module: 'test_zalo_pdf', cwd: REPO_ROOT, requires: 'import gateway, pymupdf, pdf2docx' },
  { label: 'test_zalo_academic.py', module: 'test_zalo_academic', cwd: REPO_ROOT, requires: 'import gateway' },
  { label: 'test_zalo_open_data.py', module: 'test_zalo_open_data', cwd: REPO_ROOT, requires: 'import gateway' },
  { label: 'test_zalo_memory_drift.py', module: 'test_zalo_memory_drift', cwd: REPO_ROOT, requires: 'import gateway' },
  { label: 'test_zalo_reply_style.py', module: 'test_zalo_reply_style', cwd: REPO_ROOT, requires: 'import gateway' },
  { label: 'test_zalo_memory_tags.py', module: 'test_zalo_memory_tags', cwd: REPO_ROOT, requires: 'import gateway' },
  { label: 'test_zalo_freshness.py', module: 'test_zalo_freshness', cwd: REPO_ROOT, requires: 'import gateway' },
  { label: 'test_zalo_media_engines.py', module: 'test_zalo_media_engines', cwd: REPO_ROOT, requires: 'import gateway, requests' },
  { label: 'test_zalo_model_command.py', module: 'test_zalo_model_command', cwd: REPO_ROOT, requires: 'import gateway, yaml' },
  { label: 'test_zalo_permissions.py', module: 'test_zalo_permissions', cwd: REPO_ROOT, requires: 'import gateway' },
  { label: 'test_zalo_studio.py', module: 'test_zalo_studio', cwd: REPO_ROOT, requires: 'import gateway' },
  { label: 'test_zalo_insight.py', module: 'test_zalo_insight', cwd: REPO_ROOT, requires: 'import gateway' },
  { label: 'test_zalo_memory.py', module: 'test_zalo_memory', cwd: REPO_ROOT, requires: 'import gateway, httpx' },
  // Plugin nạp từ <HERMES_HOME>/plugins dưới tên module tổng hợp (Hermes cũ và mới).
  { label: 'test_zalo_plugin_layout.py', module: 'test_zalo_plugin_layout', cwd: REPO_ROOT, requires: 'import gateway, httpx, yaml' },
  { label: 'test_zalo_keypool.py', module: 'test_zalo_keypool', cwd: REPO_ROOT },
  { label: 'test_zalo_ai_events.py', module: 'test_zalo_ai_events', cwd: REPO_ROOT, requires: 'import yaml' },
  { label: 'test_dashboard_hermes_admin.py', module: 'test_dashboard_hermes_admin', cwd: REPO_ROOT },
  { label: 'test_zalo_call_words.py', module: 'test_zalo_call_words', cwd: REPO_ROOT },
  { label: 'test_zalo_live_settings.py', module: 'test_zalo_live_settings', cwd: REPO_ROOT },
  { label: 'test_zalo_bot_uses.py', module: 'test_zalo_bot_uses', cwd: REPO_ROOT },
  { label: 'scripts/test_lay_token_facebook.py', module: 'scripts.test_lay_token_facebook', cwd: REPO_ROOT },
  { label: 'tts/test_vieneu_provider.py', module: 'test_vieneu_provider', cwd: join(REPO_ROOT, 'tts') },
];

let totalTests = 0;
let anyFailed = false;

// Test chạy với HERMES_HOME thật (để dùng venv của Hermes) nhưng không được đọc
// permissions.json của bot đang chạy trên máy này: một nhóm bị tắt tính năng ở đó
// sẽ làm đỏ test không liên quan. Trỏ plugin tới một tệp không tồn tại.
const isolation = mkdtempSync(join(tmpdir(), 'zalo-py-tests-'));
// Môi trường do Hermes quản lý không chứa mã Hermes: thêm gốc mã Hermes vào PYTHONPATH để import được gateway.
const hermesRoot = hermesLayout()?.repoRoot;
const pythonPath = [hermesRoot, process.env.PYTHONPATH].filter(Boolean).join(platform() === 'win32' ? ';' : ':');
// HERMES_HOME của test là thư mục tạm: plugin ghi thống kê lượt dùng, hạn mức… vào <HERMES_HOME>/zalo — trỏ vào bot
// thật thì người giả của test ("Lan", "u1"…) lẫn vào bảng xếp hạng Khách dùng bot.
const testHome = join(isolation, 'hermes-home');
mkdirSync(testHome, { recursive: true });
const testEnv = { ...process.env, HERMES_HOME: testHome, ZALO_PERMISSIONS_FILE: join(isolation, 'permissions.json'), ...(pythonPath ? { PYTHONPATH: pythonPath } : {}) };
process.on('exit', () => rmSync(isolation, { recursive: true, force: true }));

for (const suite of suites) {
  console.log(`\n[test:py] === ${suite.label} ===`);
  if (suite.requires && spawnSync(python, ['-c', suite.requires], { cwd: suite.cwd, encoding: 'utf8', env: testEnv }).status !== 0) {
    console.warn(
      `[test:py] CẢNH BÁO: BỎ QUA ${suite.label} — Python này chưa import được lõi Hermes (gateway) hoặc jsonschema.\n`
      + '[test:py]   Đặt biến PYTHON trỏ tới Python trong venv của Hermes, hoặc HERMES_HOME, rồi chạy lại `npm run test:py`.',
    );
    continue;
  }
  const result = spawnSync(python, ['-m', 'unittest', suite.module, '-v'], {
    cwd: suite.cwd,
    encoding: 'utf8',
    env: testEnv,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  const ran = /Ran (\d+) tests?/.exec(result.stderr || '');
  if (ran) totalTests += Number(ran[1]);

  if (result.status !== 0) {
    anyFailed = true;
    console.error(`[test:py] ${suite.label} THẤT BẠI (exit ${result.status ?? result.error})`);
  }
}

console.log(`\n[test:py] Tổng số test Python đã chạy: ${totalTests}`);
if (anyFailed) {
  console.error('[test:py] Có test Python thất bại — xem log phía trên.');
  process.exit(1);
}
console.log('[test:py] Tất cả test Python đều xanh.');
