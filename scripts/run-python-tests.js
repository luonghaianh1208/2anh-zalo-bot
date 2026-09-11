#!/usr/bin/env node
// Chạy 3 test suite Python của repo (test_zalo_adapter.py, scripts/test_lay_token_facebook.py,
// tts/test_vieneu_provider.py) mà `node --test` không bao giờ đụng tới.
//
// Dò Python theo thứ tự: biến PYTHON (nếu đặt, dùng đúng nó, không âm thầm rơi xuống lựa chọn
// khác — để mô phỏng "máy chưa cài Python" bằng PYTHON=/khong/ton/tai vẫn đúng ý) → venv của
// Hermes qua HERMES_HOME → python3 → python.
// Không tìm thấy Python nào chạy được: cảnh báo rõ ràng rồi thoát 0, không làm hỏng `npm test`
// trên máy khách chưa cài Python.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { platform } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveHermesLayout } from './hermes-install-lib.js';
import { loadRepoEnv } from './setup-env.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const envPath = join(REPO_ROOT, '.env');
if (existsSync(envPath)) loadRepoEnv(envPath);

function worksAsPython(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  return result.status === 0;
}

function hermesVenvPython() {
  try {
    const { repoRoot } = resolveHermesLayout();
    const candidates = platform() === 'win32'
      ? [join(repoRoot, 'venv', 'Scripts', 'python.exe'), join(repoRoot, '.venv', 'Scripts', 'python.exe')]
      : [join(repoRoot, 'venv', 'bin', 'python'), join(repoRoot, '.venv', 'bin', 'python')];
    return candidates.find(existsSync) || null;
  } catch {
    return null;
  }
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
    '[test:py] CẢNH BÁO: không tìm thấy Python khả dụng — BỎ QUA 3 test suite Python\n'
    + '[test:py]   (test_zalo_adapter.py, scripts/test_lay_token_facebook.py, tts/test_vieneu_provider.py).\n'
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
  { label: 'scripts/test_lay_token_facebook.py', module: 'scripts.test_lay_token_facebook', cwd: REPO_ROOT },
  { label: 'tts/test_vieneu_provider.py', module: 'test_vieneu_provider', cwd: join(REPO_ROOT, 'tts') },
];

let totalTests = 0;
let anyFailed = false;

for (const suite of suites) {
  console.log(`\n[test:py] === ${suite.label} ===`);
  if (suite.requires && spawnSync(python, ['-c', suite.requires], { cwd: suite.cwd, encoding: 'utf8' }).status !== 0) {
    console.warn(
      `[test:py] CẢNH BÁO: BỎ QUA ${suite.label} — Python này chưa import được lõi Hermes (gateway) hoặc jsonschema.\n`
      + '[test:py]   Đặt biến PYTHON trỏ tới Python trong venv của Hermes, hoặc HERMES_HOME, rồi chạy lại `npm run test:py`.',
    );
    continue;
  }
  const result = spawnSync(python, ['-m', 'unittest', suite.module, '-v'], {
    cwd: suite.cwd,
    encoding: 'utf8',
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
