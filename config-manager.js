import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(__dirname, 'data', 'bot_settings.json');
const PERSONAS_FILE = join(__dirname, 'data', 'personas.json');

export async function loadPersonas() {
  try {
    if (!existsSync(PERSONAS_FILE)) return {};
    return JSON.parse(await readFile(PERSONAS_FILE, 'utf8'));
  } catch (err) {
    console.error('Error loading personas:', err);
    return {};
  }
}

export async function savePersonas(data) {
  try {
    await writeFile(PERSONAS_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error saving personas:', err);
    return false;
  }
}

// Cấu hình mặc định
export const DEFAULT_CONFIG = {
  global: {
    enabled: true,
    silentListenOnly: false, // Chế độ Lắng nghe im lặng (chỉ học hỏi/ghi nhớ, không trả lời dù bị tag)
    replyOnlyTagged: true,
    persona: "friendly", // xem data/personas.json để biết các tính cách có sẵn
    voiceReply: false,
    autoCreateFile: true,
    autoReadLink: true,
    autoReadFile: true,
    enableGroupDigest: true,
    antiSpam: true,
    autoWelcomeNewMember: true,
    autoPoll: true,
    autoReminders: true,
    autoAcceptFriend: false,
    // Chủ nhân — điền bằng lệnh /sethome trên Zalo. Giá trị thật nằm ở
    // data/bot_settings.json; đây chỉ là mặc định khi chưa có file đó.
    // UID Zalo là dãy số dài (17-21 chữ số), KHÔNG phải số điện thoại.
    adminUids: [],
    allowedUids: [],        // ai được nhắn riêng khi dmPolicy = "allowlist"
    dmPolicy: "owner-only", // owner-only | allowlist | open
    ownerName: "",          // để trống thì bot gọi theo tên Zalo của người nhắn
    orgName: "",            // tên đơn vị, dùng khi bot tự giới thiệu
  },
  groups: {
    // Cấu hình riêng cho từng nhóm (key là Group ID)
    // "group_id_sample": {
    //    name: "Tổ Hóa Học",
    //    enabled: true,
    //    replyOnlyTagged: false,
    //    autoCreateFile: true,
    //    autoWelcomeNewMember: true,
    //    enableGroupDigest: true
    // }
  }
};

export async function loadBotConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) {
      await saveBotConfig(DEFAULT_CONFIG);
      return DEFAULT_CONFIG;
    }
    const data = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
    return { ...DEFAULT_CONFIG, ...data };
  } catch (err) {
    console.error('[config] loadBotConfig error:', err.message);
    return DEFAULT_CONFIG;
  }
}

export async function saveBotConfig(config) {
  try {
    await mkdir(dirname(CONFIG_FILE), { recursive: true });
    await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    console.log('[config] saved to', CONFIG_FILE);
    return true;
  } catch (err) {
    console.error('[config] saveBotConfig error:', err.message);
    return false;
  }
}
