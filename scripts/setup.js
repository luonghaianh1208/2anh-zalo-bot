#!/usr/bin/env node
/**
 * Cài đặt 2Anh Zalo Bot.
 *
 * Chạy:  npm run setup
 *
 * Việc script làm:
 *   1. Kiểm tra Node đủ mới
 *   2. Tạo data/ và chép cấu hình mẫu vào (không đè lên file đã có)
 *   3. Tạo .env từ .env.example nếu chưa có
 *   4. Tìm thư mục cài Hermes
 *   5. Chép plugin Zalo vào Hermes và cài gói websockets
 *   6. In ra các bước còn lại cần làm tay
 *
 * Chạy lại nhiều lần được — không ghi đè thứ gì bạn đã sửa.
 */

import { existsSync, mkdirSync, copyFileSync, readdirSync, cpSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);
const step = (m) => console.log(`\n${m}`);

let hasWarning = false;
function note(m) { hasWarning = true; warn(m); }

// --- 1. Node -----------------------------------------------------------
step('1. Kiểm tra Node.js');
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error(`  ✗ Cần Node 20 trở lên, máy đang chạy ${process.versions.node}`);
  process.exit(1);
}
ok(`Node ${process.versions.node}`);

// --- 2. Thư mục dữ liệu ------------------------------------------------
step('2. Chuẩn bị thư mục data/');
const dataDir = join(ROOT, 'data');
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
  ok('đã tạo data/');
} else {
  ok('data/ đã có');
}

const seeds = [
  ['examples/bot_settings.example.json', 'data/bot_settings.json'],
  ['examples/personas.example.json', 'data/personas.json'],
];
for (const [from, to] of seeds) {
  const dst = join(ROOT, to);
  if (existsSync(dst)) {
    ok(`${to} đã có — giữ nguyên`);
  } else {
    copyFileSync(join(ROOT, from), dst);
    ok(`đã tạo ${to} từ mẫu`);
  }
}

// --- 3. .env -----------------------------------------------------------
step('3. Chuẩn bị .env');
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  ok('.env đã có — giữ nguyên');
} else {
  copyFileSync(join(ROOT, '.env.example'), envPath);
  ok('đã tạo .env từ .env.example');
}

// --- 4. Tìm Hermes -----------------------------------------------------
step('4. Tìm thư mục cài Hermes Agent');
function findHermesHome() {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;
  const candidates = [];
  if (platform() === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(join(process.env.LOCALAPPDATA, 'hermes'));
  }
  candidates.push(join(homedir(), '.hermes'));
  return candidates.find((d) => existsSync(join(d, 'config.yaml')) || existsSync(join(d, '.env'))) || null;
}

const hermesHome = findHermesHome();
if (!hermesHome) {
  note('Không tìm thấy Hermes. Bot vẫn chạy được ở chế độ chatbot độc lập.');
  note('Muốn dùng đầy đủ tools/memory/skills thì cài Hermes rồi chạy lại: npm run setup');
} else {
  ok(`Hermes ở ${hermesHome}`);

  // --- 5. Cài plugin --------------------------------------------------
  step('5. Cài plugin Zalo vào Hermes');
  const repoRoot = join(hermesHome, 'hermes-agent');
  const pluginDst = join(repoRoot, 'plugins', 'platforms', 'zalo');

  if (!existsSync(repoRoot)) {
    note(`Không thấy ${repoRoot} — bản Hermes này không phải kiểu cài từ git?`);
    note('Chép tay thư mục hermes-plugin/zalo/ vào <hermes>/hermes-agent/plugins/platforms/');
  } else {
    mkdirSync(dirname(pluginDst), { recursive: true });
    cpSync(join(ROOT, 'hermes-plugin', 'zalo'), pluginDst, { recursive: true, force: true });
    ok(`đã chép plugin vào ${pluginDst}`);

    // Gói websockets cho adapter Python
    const venvPython = platform() === 'win32'
      ? join(repoRoot, 'venv', 'Scripts', 'python.exe')
      : join(repoRoot, 'venv', 'bin', 'python');

    if (existsSync(venvPython)) {
      const uv = platform() === 'win32'
        ? join(hermesHome, 'bin', 'uv.exe')
        : join(hermesHome, 'bin', 'uv');
      try {
        if (existsSync(uv)) {
          execFileSync(uv, ['pip', 'install', '--python', venvPython, 'websockets'], { stdio: 'pipe' });
        } else {
          execFileSync(venvPython, ['-m', 'pip', 'install', '-q', 'websockets'], { stdio: 'pipe' });
        }
        ok('đã cài gói websockets cho Hermes');
      } catch {
        note('Chưa cài được websockets. Chạy tay:');
        note(`  "${venvPython}" -m pip install websockets`);
      }
    } else {
      note(`Không thấy môi trường Python của Hermes (${venvPython}) — bỏ qua bước cài websockets`);
    }
  }
}

// --- Kết ---------------------------------------------------------------
console.log(`
${'='.repeat(62)}
  Cài đặt xong${hasWarning ? ' (có vài cảnh báo ở trên)' : ''}
${'='.repeat(62)}

Các bước tiếp theo:

  1. Chạy bot:            npm start
  2. Mở dashboard:        http://127.0.0.1:3872
  3. Quét QR bằng Zalo    — nên dùng một tài khoản phụ, đừng dùng tài
                            khoản chính
  4. Nhắn "/sethome" cho tài khoản vừa quét, từ Zalo cá nhân của bạn
     → bot ghi nhận bạn là chủ và in ra UID
  5. Thêm UID đó vào .env của Hermes:
         ZALO_ALLOWED_USERS=<UID vừa nhận>
  6. Khởi động Hermes:    hermes gateway run

Đọc thêm: README.md
`);
