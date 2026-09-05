import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Nguồn cấu hình LLM dùng chung với Hermes Agent (kênh Telegram).
 *
 * Cả Zalo và Telegram đều trỏ về CÙNG một router + CÙNG một model + CÙNG một
 * API key, nên đổi model bên Hermes là cả hai kênh đổi theo — không phải sửa
 * hai nơi.
 *
 * Thứ tự tìm key:
 *   1. biến môi trường CUSTOM_API_KEY (nếu đặt tay)
 *   2. <HERMES_HOME>/.env         → CUSTOM_API_KEY=...
 *   3. <HERMES_HOME>/config.yaml  → model.api_key: ...
 */

/**
 * Tìm thư mục cài Hermes. Ưu tiên biến môi trường, sau đó là các vị trí mặc
 * định của trình cài đặt trên từng hệ điều hành — để repo này chạy được trên
 * máy khách mà không phải sửa mã.
 */
function resolveHermesHome() {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;

  const candidates = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) candidates.push(join(localAppData, 'hermes'));
  }
  candidates.push(join(homedir(), '.hermes'));

  for (const dir of candidates) {
    if (existsSync(join(dir, 'config.yaml')) || existsSync(join(dir, '.env'))) return dir;
  }
  return candidates[0] || join(homedir(), '.hermes');
}

const HERMES_HOME = resolveHermesHome();

function readFrom(path, regex) {
  try {
    if (!existsSync(path)) return null;
    const m = readFileSync(path, 'utf8').match(regex);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch {
    return null;
  }
}

function resolveApiKey() {
  if (process.env.CUSTOM_API_KEY) return process.env.CUSTOM_API_KEY;
  return (
    readFrom(join(HERMES_HOME, '.env'), /^\s*CUSTOM_API_KEY\s*=\s*(.+)$/m) ||
    readFrom(join(HERMES_HOME, 'config.yaml'), /^\s*api_key:\s*(.+)$/m)
  );
}

function resolveBaseUrl() {
  return (
    process.env.CUSTOM_BASE_URL ||
    readFrom(join(HERMES_HOME, 'config.yaml'), /^\s*base_url:\s*(.+)$/m) ||
    'http://127.0.0.1:20128/v1'
  );
}

function resolveModel() {
  return (
    process.env.HERMES_MODEL ||
    readFrom(join(HERMES_HOME, 'config.yaml'), /^\s*default:\s*(.+)$/m) ||
    'hermes'
  );
}

export const BRAIN = {
  apiKey: resolveApiKey(),
  baseUrl: resolveBaseUrl(),
  model: resolveModel(),
};

/** Gọi một lần lúc khởi động để báo sớm nếu thiếu key, thay vì im lặng lỗi 401. */
export function assertBrainReady() {
  if (!BRAIN.apiKey) {
    console.error(
      '[brain] ❌ Không tìm thấy API key.\n' +
      `        Đã tìm trong: env CUSTOM_API_KEY, ${HERMES_HOME}\\.env, ${HERMES_HOME}\\config.yaml\n` +
      '        Bot sẽ KHÔNG trả lời được cho tới khi có key.'
    );
    return false;
  }
  const masked = BRAIN.apiKey.slice(0, 8) + '…' + BRAIN.apiKey.slice(-4);
  console.log(`[brain] ✅ model=${BRAIN.model} · ${BRAIN.baseUrl} · key=${masked}`);
  return true;
}
