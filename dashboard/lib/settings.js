/**
 * Cấu hình (spec §18.6, chỉ Quản trị): danh sách CỐ ĐỊNH các cài đặt an toàn của bot. Không bao giờ có khoá bí mật,
 * không bao giờ sửa được khoá ngoài danh sách. Mỗi mục biết:
 *  - đọc/ghi ở đâu: `.env` của Hermes (env-file.js) hoặc `platforms.zalo.extra` của config.yaml (config-yaml.js),
 *    đúng thứ tự ưu tiên adapter đọc (extraWins: config.yaml thắng .env; ngược lại .env thắng);
 *  - kiểu + giới hạn để kiểm giá trị;
 *  - cần khởi động lại gì: phần lớn áp dụng ngay (plugin đọc lại tệp khi đổi); chỉ mục sidecar đọc lúc khởi động
 *    (giữ lịch sử) hoặc đăng ký công cụ lúc nạp (kết bạn) mới cần khởi động lại.
 * Ghi vào đúng nơi đang có hiệu lực: khoá đang nằm trong config.yaml thì sửa config.yaml, còn lại sửa .env.
 */
import { parseEnv } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { writeEnvKeys } from './env-file.js';
import { editConfigYaml, readConfigYaml } from './config-yaml.js';

const S = ['sidecar']; const AS = ['assistant', 'sidecar'];
// Áp dụng ngay: plugin đọc lại .env / config.yaml khi đổi (hermes-plugin/zalo/live_settings.py) — không cần khởi động lại.
const NOW = [];
export const SETTINGS = [
  { id: 'replyOnlyTagged', group: 'Trả lời', label: 'Trong nhóm chỉ trả lời khi được tag', hint: 'Mặc định cho mọi nhóm; từng nhóm vẫn chỉnh riêng ở Phân quyền Bot.', type: 'bool', env: 'ZALO_GROUP_REPLY_ONLY_TAGGED', extra: 'reply_only_tagged', extraWins: false, def: true, restart: NOW },
  { id: 'dmPolicy', group: 'Trả lời', label: 'Nhắn riêng khi chưa chọn ở Phân quyền Bot', hint: '"Chỉ chủ nhân" hoặc "Mọi người". Mục Nhắn riêng ở Phân quyền Bot (nếu đã lưu) thắng cài đặt này.', type: 'enum', options: [{ value: 'owner-only', label: 'Chỉ chủ nhân' }, { value: 'open', label: 'Mọi người' }], env: 'ZALO_DM_POLICY', extra: 'dm_policy', extraWins: true, def: 'owner-only', restart: NOW },
  { id: 'ackGestures', group: 'Trả lời', label: 'Báo đã xem khi nhận tin', type: 'bool', env: 'ZALO_ACK_GESTURES', extra: 'ack_gestures', extraWins: true, def: true, restart: NOW },
  { id: 'notifyOwnerMention', group: 'Trả lời', label: 'Báo về tin riêng khi có người tag chủ nhân trong nhóm', hint: 'Bot nhắn riêng cho chủ nhân: ai tag, ở nhóm nào, lúc nào, nội dung gì. Nhiều bot cùng ở một nhóm thì chỉ bật ở một bot để khỏi báo trùng.', type: 'bool', env: 'ZALO_NOTIFY_OWNER_MENTION', def: true, restart: NOW },
  { id: 'autoReact', group: 'Trả lời', label: 'Thả cảm xúc tự động', type: 'bool', env: 'ZALO_AUTO_REACT', extra: 'auto_react', extraWins: true, def: true, restart: NOW },
  { id: 'ownerOnlyGroups', group: 'Trả lời', label: 'Nhóm chỉ chủ nhân gọi được bot', hint: 'Người khác tag bot thì bot im, tin vẫn được lưu làm ngữ cảnh. Nên chỉnh ở Phân quyền Bot (tắt nhóm) — nhóm đã phân quyền riêng ở đó thì phân quyền đó thắng danh sách này.', type: 'ids', max: 50, env: 'ZALO_OWNER_ONLY_GROUPS', extra: 'owner_only_groups', extraWins: true, def: [], restart: NOW },
  { id: 'floodThreshold', group: 'Chống nhắn dồn', label: 'Số tin tối đa trong một khoảng', type: 'int', min: 2, max: 50, env: 'ZALO_FLOOD_THRESHOLD', def: 6, restart: NOW },
  { id: 'floodWindow', group: 'Chống nhắn dồn', label: 'Khoảng tính (giây)', type: 'int', min: 5, max: 600, env: 'ZALO_FLOOD_WINDOW_S', decimal: true, def: 15, restart: NOW },
  { id: 'floodMute', group: 'Chống nhắn dồn', label: 'Bỏ qua người nhắn dồn trong (giây)', type: 'int', min: 10, max: 3600, env: 'ZALO_FLOOD_MUTE_S', decimal: true, def: 90, restart: NOW },
  { id: 'alertDanger', group: 'Kết bạn và an toàn', label: 'Cảnh báo hành vi nguy hiểm trong nhóm về tin riêng', hint: 'Tin nhóm không hợp với học sinh (tục tĩu, bắt nạt, tình dục, chất cấm, bạo lực, tự hại, cờ bạc/lừa đảo) hoặc cố can thiệp sâu vào bot (bảo bot bỏ quy tắc, đòi khoá/cấu hình, chạy lệnh): AI xác nhận rồi bot nhắn riêng chủ nhân. Nhiều bot cùng ở một nhóm thì chỉ bật ở một bot để khỏi báo trùng.', type: 'bool', env: 'ZALO_ALERT_DANGER', def: true, restart: NOW },
  { id: 'friendTools', group: 'Kết bạn và an toàn', label: 'Cho chủ nhân nhờ bot kết bạn, lập nhóm với người lạ', type: 'bool', env: 'ZALO_FRIEND_TOOLS', def: false, restart: AS },
  { id: 'confirmDangerous', group: 'Kết bạn và an toàn', label: 'Bắt chủ nhân gửi mã xác nhận trước thao tác nguy hiểm', hint: 'Chặn thêm trường hợp tài liệu/trang web bot đọc có cài lệnh ẩn.', type: 'bool', env: 'ZALO_CONFIRM_DANGEROUS', def: false, restart: NOW },
  { id: 'kbPublicDirs', group: 'Tài liệu và MCP', label: 'Thư mục kho tài liệu mở cho mọi người', hint: 'Tên thư mục cấp 1 trong kho, cách nhau bằng dấu phẩy. Để trống = cả kho.', type: 'names', max: 20, env: 'ZALO_KB_PUBLIC_DIRS', def: [], restart: NOW },
  { id: 'publicMcp', group: 'Tài liệu và MCP', label: 'Kết nối MCP thành viên được dùng', hint: 'Tên kết nối (được dùng * và ?). Mở cho thành viên là cho người ngoài dùng tài nguyên của chủ bot — cân nhắc kỹ.', type: 'patterns', max: 20, env: 'ZALO_PUBLIC_MCP', def: [], restart: NOW, confirm: true },
  { id: 'mediaLookback', group: 'Đọc ảnh và tệp', label: 'Số tin gần nhất bot xem lại để tìm ảnh/tệp', hint: 'Khi được hỏi về ảnh hay tệp (vd. "xem ảnh này", "gộp 2 file vừa gửi") trong nhóm, bot lật lại chừng này tin để lấy ảnh/tệp mà đọc. Mặc định 3. Đặt cao thì đọc được ảnh gửi xa hơn nhưng tốn thêm lượt AI cho mỗi ảnh; chỉ tính các tin nhận được từ lần khởi động lại trợ lý gần nhất.', type: 'int', min: 1, max: 30, env: 'ZALO_MEDIA_LOOKBACK', extra: 'media_lookback', extraWins: true, def: 3, restart: NOW },
  { id: 'historyDays', group: 'Lưu trữ', label: 'Giữ lịch sử trò chuyện (ngày)', type: 'int', min: 30, max: 3650, env: 'ZALO_HISTORY_RETENTION_DAYS', def: 365, restart: S },
  { id: 'auditDays', group: 'Lưu trữ', label: 'Giữ nhật ký thao tác của bot (ngày)', hint: 'Dòng cũ hơn tự xoá mỗi ngày. Muốn xoá ngay thì vào Nhật ký › Dọn nhật ký.', type: 'int', min: 7, max: 3650, env: 'ZALO_AUDIT_RETENTION_DAYS', def: 90, restart: S },
];

const err = (message) => Object.assign(new Error(message), { statusCode: 400 });
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const list = (v) => (Array.isArray(v) ? v.map(String) : String(v ?? '').split(',')).map((s) => s.trim()).filter(Boolean);

/** Giá trị thô (chuỗi .env hoặc giá trị YAML) → giá trị đúng kiểu của mục. */
function coerce(def, raw) {
  if (raw === undefined || raw === null || (raw === '' && def.type !== 'bool')) return def.def;
  // Bool: chuỗi rỗng = tắt (như _truthy của adapter: chỉ 1/true/yes/on mới là bật).
  if (def.type === 'bool') return typeof raw === 'boolean' ? raw : truthy(raw);
  // Số: hiện đúng giá trị bộ đọc nhận — adapter đọc cửa sổ/thời gian chặn bằng float() nên có thể có phần thập phân.
  if (def.type === 'int') { const n = Number(raw); return def.decimal ? (Number.isFinite(n) ? n : def.def) : (Number.isInteger(n) ? n : def.def); }
  if (def.type === 'enum') { const s = String(raw).trim().toLowerCase(); return def.options.some((o) => o.value === s) ? s : def.def; }
  return list(raw);
}

/** Kiểm giá trị người dùng gửi lên; trả giá trị đã chuẩn hoá hoặc ném lỗi 400 có câu dễ hiểu. */
export function validateSetting(def, v) {
  if (def.type === 'bool') { if (typeof v !== 'boolean') throw err(`${def.label}: chọn bật hoặc tắt.`); return v; }
  if (def.type === 'int') {
    if (!Number.isInteger(v) || v < def.min || v > def.max) throw err(`${def.label}: nhập số nguyên từ ${def.min} đến ${def.max}.`);
    return v;
  }
  if (def.type === 'enum') { if (!def.options.some((o) => o.value === v)) throw err(`${def.label}: chọn lại.`); return v; }
  if (!Array.isArray(v) || v.length > def.max) throw err(`${def.label}: tối đa ${def.max} mục.`);
  const rule = { ids: /^\d{1,32}$/, names: /^[\p{L}\p{N} _.-]{1,60}$/u, patterns: /^[A-Za-z0-9_.*?-]{1,64}$/ }[def.type];
  const out = [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
  for (const x of out) if (!rule.test(x) || (def.type === 'names' && (x === '.' || x === '..'))) throw err(`${def.label}: "${x.slice(0, 30)}" không hợp lệ.`);
  return out;
}

/** `inherited`: giá trị các khoá này trong môi trường dịch vụ, chụp trước khi nạp .env (như makeDmEnv). */
export function createSettings({ envFile, configFile, inherited = {} }) {
  function envValues() {
    try { return existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8').replace(/^﻿/, '')) : {}; } catch { return {}; }
  }
  function resolve(def, env, extra) {
    const inExtra = def.extra && extra && Object.hasOwn(extra, def.extra);
    const envRaw = Object.hasOwn(env, def.env) ? env[def.env] : inherited[def.env];
    if (def.extraWins && inExtra) return { value: coerce(def, extra[def.extra]), source: 'config' };
    if (envRaw !== undefined && (def.type === 'bool' || String(envRaw).trim() !== '')) return { value: coerce(def, envRaw), source: 'env' };
    if (inExtra) return { value: coerce(def, extra[def.extra]), source: 'config' };
    return { value: def.def, source: 'default' };
  }
  const read = () => {
    const env = envValues();
    const raw = readConfigYaml(configFile)?.platforms?.zalo?.extra;
    const extra = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return SETTINGS.map((d) => ({ ...d, ...resolve(d, env, extra) }));
  };
  return {
    view: () => read().map(({ env, extra, extraWins, ...rest }) => ({ ...rest, key: env })),
    /**
     * Lưu các mục đổi; trả [{ id, label, restart, before, after }] của mục thật sự đổi.
     * `onApplied(changes)` gọi NGAY sau mỗi phần ghi thành công (config.yaml rồi .env) để nơi gọi đánh dấu khởi động lại
     * kịp thời. Ghi dở dang → ném lỗi 500 tiếng Việt kèm `applied` (những mục đã ghi thật).
     */
    save(values, { onApplied } = {}) {
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw err('Dữ liệu không hợp lệ — tải lại trang.');
      const current = new Map(read().map((s) => [s.id, s]));
      const changes = [];
      for (const [id, raw] of Object.entries(values)) {
        const cur = current.get(id);
        if (!cur) throw err('Có mục không nằm trong danh sách cài đặt — tải lại trang.');
        const v = validateSetting(cur, raw);
        if (JSON.stringify(v) === JSON.stringify(cur.value)) continue;
        changes.push({ cur, v });
      }
      const yamlEdits = changes.filter((c) => c.cur.source === 'config').map((c) => ({ path: ['platforms', 'zalo', 'extra', c.cur.extra], value: c.v }));
      const out = (cs) => cs.map((c) => ({ id: c.cur.id, label: c.cur.label, restart: c.cur.restart, before: c.cur.value, after: c.v }));
      const yamlChanges = changes.filter((c) => c.cur.source === 'config');
      const envChanges = changes.filter((c) => c.cur.source !== 'config');
      const applied = [];
      if (yamlEdits.length) {
        editConfigYaml(configFile, yamlEdits);
        applied.push(...out(yamlChanges)); onApplied?.(out(yamlChanges));
      }
      if (envChanges.length) {
        try {
          writeEnvKeys(envFile, Object.fromEntries(envChanges.map((c) => [c.cur.env, Array.isArray(c.v) ? c.v.join(',') : String(c.v)])));
        } catch (e) {
          if (!applied.length) throw e;
          console.error('[dashboard] ghi .env dở dang:', e);
          throw Object.assign(new Error(`Đã lưu ${applied.map((a) => a.label).join(', ')} nhưng chưa lưu được ${envChanges.map((c) => c.cur.label).join(', ')} — tải lại trang, kiểm tra rồi lưu lại các mục còn lại; nếu vẫn lỗi hãy báo người cài đặt.`), { statusCode: 500, applied, partial: true });
        }
        applied.push(...out(envChanges)); onApplied?.(out(envChanges));
      }
      return out(changes);
    },
  };
}
