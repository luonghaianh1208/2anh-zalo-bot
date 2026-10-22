/**
 * Phân quyền Bot theo nhóm (spec §8): đọc/ghi/kiểm `<HERMES_HOME>/zalo/permissions.json`.
 * Plugin Python (hermes-plugin/zalo_tools/group_permissions.py) đọc nóng tệp này — hai bên
 * phải cùng lược đồ: lớp gộp mặc định gốc ← `defaults` ← thư mục chứa nhóm (`folders[fid]`, mỗi nhóm tối đa một
 * thư mục) ← `groups[id]`, khoá thiếu rơi xuống lớp dưới.
 * Ghi nguyên tử (tệp tạm rồi đổi tên), quyền 600, giữ bản trước ở `.bak`.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { parseEnv } from 'node:util';
import YAML from 'yaml';
import { writeJsonAtomic } from './json-store.js';
import { ZALO_UID } from './users.js';
import { DM_FEATURE_KEYS, DM_WHO, STUDIO_KEYS, normalizeDm } from '../../dm-rules.js';

export const FEATURES = [
  { key: 'web', label: 'Tra cứu web', hint: 'Tìm và đọc trang web' },
  { key: 'files', label: 'Gửi và tạo tệp', hint: 'Gửi tệp, tạo Word/Excel/PowerPoint, xử lý PDF' },
  { key: 'voice', label: 'Tin nhắn thoại', hint: 'Bot trả lời bằng giọng nói' },
  { key: 'reminders', label: 'Nhắc hẹn', hint: 'Tạo, xem, xoá lời nhắc của Zalo' },
  { key: 'groupCron', label: 'Hẹn giờ cho nhóm', hint: 'Thành viên tạo việc bot tự làm theo lịch. Tắt chỉ chặn tạo mới — việc đã tạo vẫn chạy' },
  { key: 'kb', label: 'Kho tài liệu và skill', hint: 'Đọc tài liệu và skill chủ bot đã mở cho thành viên' },
  { key: 'people', label: 'Sổ người quen', hint: 'Ghi nhớ và tra hồ sơ thành viên' },
  { key: 'academic', label: 'Tra cứu học thuật', hint: 'Tìm bài báo khoa học' },
  { key: 'video', label: 'Video', hint: 'Xem thông tin, tải, cắt ghép video (link hoặc video gửi vào Zalo) và sửa video: phụ đề, nhạc nền, logo, chuyển cảnh' },
  { key: 'history', label: 'Tra lịch sử trò chuyện', hint: 'Bot tìm lại tin cũ của chính nhóm này khi được hỏi "hôm trước ai nói gì", "ai đã gửi tệp X"' },
];
export const FEATURE_KEYS = FEATURES.map((f) => f.key);
// Nút cho tin nhắn riêng (spec §16): 8 nút, không có "Hẹn giờ cho nhóm"; lời gợi ý viết cho một người.
const DM_HINTS = { kb: 'Đọc tài liệu chủ bot đã mở cho mọi người', people: 'Bot nhớ hồ sơ người nhắn để xưng hô đúng', history: 'Bot tìm lại tin cũ trong cuộc trò chuyện riêng với người này' };
export const DM_FEATURES = FEATURES.filter((f) => DM_FEATURE_KEYS.includes(f.key)).map((f) => ({ ...f, hint: DM_HINTS[f.key] || f.hint }));
// Xưởng tạo sản phẩm (spec §17): 4 nút nằm cùng `features` trong tệp nhưng thiếu khoá = TẮT; giao diện tách riêng
// thành `studio`. Hạn mức: `groups[id].studioQuota`, mục gốc `studio: { quota, people: { uid: { name, quota } } }`.
export const STUDIO_FEATURES = [
  { key: 'studioSlides', label: 'Slide PowerPoint', hint: 'Bài giảng, báo cáo, hoạt động Đoàn, poster, tập huấn — tệp .pptx làm bằng 2Anh Studio, có ảnh AI/ảnh web' },
  { key: 'studioDocs', label: 'Văn bản và giáo án', hint: 'Giáo án 5512, văn bản hành chính Nghị định 30, văn bản Đoàn, văn bản Đảng — tệp Word' },
  { key: 'studioExams', label: 'Đề thi, SKKN, trò chơi, thí nghiệm ảo', hint: 'Đề kiểm tra, đề KHTN tiếng Anh, sáng kiến kinh nghiệm, trò chơi (trắc nghiệm, ghép đôi, ô chữ, vòng quay, thẻ lật, đếm ngược), thí nghiệm ảo' },
  { key: 'studioVideo', label: 'Video', hint: 'Video giải thích (viết tay, cắt dán, Vox có ảnh AI, video ngắn TikTok có nhân vật minh hoạ và phụ đề nổi bật) và video bài giảng từ slide, tối đa 3 phút, 720p. Bot hỏi phong cách và gửi kịch bản để duyệt trước khi dựng. Máy chủ chạy nặng vài phút mỗi video' },
  { key: 'studioImage', label: 'Vẽ ảnh AI', hint: 'Nhờ bot vẽ hoặc sửa ảnh theo mô tả — dùng nguồn ở Khoá API & Model › Tạo ảnh & video, tốn tiền mỗi ảnh' },
  { key: 'studioAIVideo', label: 'Tạo video AI', hint: 'Nhờ bot tạo video ngắn từ mô tả hoặc ảnh (Stali, vài nghìn đồng mỗi video); xong bot tự gửi vào cuộc trò chuyện' },
];
/**
 * Chính sách cài đặt (spec §17.6): máy Windows không có hộp cát của hệ điều hành nên video luôn tắt (plugin ép tắt;
 * giao diện khoá nút và ghi chú). Linux: video chỉ mở khi gateway dùng được hộp cát systemd — plugin ghi kết luận vào
 * `<HERMES_HOME>/zalo/studio-policy.json` (group_permissions.publish_video_policy, lúc xưởng khởi động). Thiếu tệp,
 * tệp hỏng → tắt (đóng), ghi chú nói rõ. Đọc lại mỗi lần gọi (gateway có thể khởi động sau dashboard).
 */
const WINDOWS_NOTE = 'Máy chủ Windows không có hộp cát — video tắt';
const UNKNOWN_NOTE = 'Chưa biết máy chủ có hộp cát systemd không (gateway chưa khởi động xưởng) — video tắt';
export function studioPolicy(platform = process.platform, policyFile = '') {
  if (platform === 'win32') return { videoBlocked: true, note: WINDOWS_NOTE };
  try {
    const data = JSON.parse(readFileSync(policyFile, 'utf8'));
    if (data && data.version === 1 && typeof data.videoBlocked === 'boolean') {
      return { videoBlocked: data.videoBlocked, note: data.videoBlocked ? String(data.note || UNKNOWN_NOTE).slice(0, 200) : '' };
    }
  } catch { /* thiếu/hỏng → đóng */ }
  return { videoBlocked: true, note: UNKNOWN_NOTE };
}
export const DEFAULT_STUDIO_QUOTA = 3;
// Vẽ ảnh AI / tạo video AI: số ảnh, số video mỗi người mỗi ngày (theo lớp như số lượt xưởng).
export const DEFAULT_IMAGE_QUOTA = 5;
export const DEFAULT_VIDEO_QUOTA = 1;
const QUOTA_KEYS = ['studioQuota', 'imageQuota', 'videoQuota'];
const noQuotas = () => ({ studioQuota: null, imageQuota: null, videoQuota: null });
const quotasOf = (raw) => Object.fromEntries(QUOTA_KEYS.map((k) => [k, raw?.[k] ?? null]));
export const MAX_STUDIO_QUOTA = 50;
const MAX_STUDIO_PEOPLE = 500;
const SWITCHES = ['active', 'replyOnlyTagged'];
export const GROUP_ID = /^\d{1,32}$/;
const MAX_NAME = 120;
const MAX_GROUPS = 500;
export const FOLDER_ID = /^[a-z0-9]{1,16}$/;
export const MAX_FOLDERS = 50;
export const MAX_FOLDER_PEOPLE = 300;
/** Màu thư mục (khớp public/views/folder-ui.js). Plugin và kết nối Zalo không dùng tới. */
export const FOLDER_COLORS = ['blue', 'green', 'orange', 'purple', 'pink', 'teal', 'red', 'indigo', 'gray'];
const MAX_FOLDER_NAME = 60;
/** Quy tắc riêng của thư mục (bot đính vào lượt trả lời ở nhóm/người trong thư mục) — giống FOLDER_RULES_MAX bên Python. */
export const MAX_FOLDER_RULES = 3000;
const MAX_DM_PEOPLE = 200;
const MAX_PERSON_NAME = 80;

export class InvalidPermissions extends Error {
  constructor(message) { super(message); this.name = 'InvalidPermissions'; this.status = 400; }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isQuota = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_STUDIO_QUOTA;
const pickBools = (raw, keys) => (isObj(raw) ? Object.fromEntries(keys.filter((k) => typeof raw[k] === 'boolean').map((k) => [k, raw[k]])) : {});
const studioOff = () => Object.fromEntries(STUDIO_KEYS.map((k) => [k, false]));
// Ở mặc định và nhắn riêng chỉ ghi nút xưởng đang BẬT (thiếu khoá = tắt) — tệp gọn, bản cũ đọc vẫn y như trước.
const onlyOn = (studio) => Object.fromEntries(STUDIO_KEYS.filter((k) => studio[k] === true).map((k) => [k, true]));
const tidy = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
// Quy tắc viết thành danh sách: giữ xuống dòng, bỏ ký tự điều khiển.
// eslint-disable-next-line no-control-regex
const tidyRules = (v) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, MAX_FOLDER_RULES) : '');

/** `_truthy` của adapter: None → mặc định, còn lại so chuỗi đã hạ chữ thường. */
const truthy = (v, dflt = false) => (v === undefined || v === null ? dflt : ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase()));
const FLAG = 'ZALO_GROUP_REPLY_ONLY_TAGGED';

function readText(path) {
  try { return readFileSync(path, 'utf8').replace(/^﻿/, ''); } catch { return null; }
}

function fileStamp(path) {
  try { const s = statSync(path); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; }
}

/**
 * Cờ ZALO_GROUP_REPLY_ONLY_TAGGED mà adapter của bot đang thấy — đọc lại khi tệp đổi (theo mtime).
 * Adapter: `_truthy(extra.get("reply_only_tagged", secret(FLAG, "true")))`, trong đó Hermes nạp
 * `<HERMES_HOME>/.env` đè lên biến môi trường của tiến trình, và giá trị env khác rỗng đè lên
 * `platforms.zalo.extra.reply_only_tagged` trong config.yaml (`_env_enablement`).
 * `inherited` = giá trị biến này trong môi trường dịch vụ trước khi dashboard nạp .env của sidecar
 * (cùng nguồn gateway được trao); không bao giờ lấy từ .env của sidecar.
 */
export function makeGlobalReplyOnlyTagged({ envFile, configFile, inherited }) {
  let key = null;
  let value = true;
  return () => {
    const next = `${fileStamp(envFile)}|${configFile ? fileStamp(configFile) : '-'}`;
    if (next === key) return value;
    const text = readText(envFile);
    let env = inherited;
    if (text !== null) {
      try { const parsed = parseEnv(text); if (Object.hasOwn(parsed, FLAG)) env = parsed[FLAG]; } catch { /* .env hỏng: Hermes cũng bỏ qua */ }
    }
    let extra;
    if (configFile) {
      try { extra = YAML.parse(readText(configFile) ?? '')?.platforms?.zalo?.extra; } catch { extra = undefined; }
    }
    if (env !== undefined && String(env).trim()) value = truthy(env, true);
    else if (isObj(extra) && Object.hasOwn(extra, 'reply_only_tagged')) value = truthy(extra.reply_only_tagged);
    else value = truthy(env ?? 'true');
    key = next;
    return value;
  };
}

/**
 * Hai giá trị Hermes đang dùng cho tin nhắn riêng, đọc lại khi .env/config.yaml đổi:
 * - `legacyWho`: ZALO_DM_POLICY ("open" → 'everyone', còn lại → 'owners') — áp khi tệp chưa có mục dm.
 *   Adapter: `extra.get("dm_policy", get_secret("ZALO_DM_POLICY", "owner-only"))` — config.yaml thắng .env.
 * - `gatewayOpen`: ZALO_ALLOW_ALL_USERS hoặc GATEWAY_ALLOW_ALL_USERS bật. Tắt thì Hermes tự chặn mọi người
 *   ngoài chủ nhân trước khi tới bot, nên chọn "danh sách"/"mọi người" chưa có tác dụng.
 * `inherited`: các biến đó trong môi trường dịch vụ, chụp trước khi nạp .env của thư mục bot.
 */
export function makeDmEnv({ envFile, configFile, inherited = {} }) {
  let key = null;
  let value = { legacyWho: 'owners', gatewayOpen: false };
  return () => {
    const next = `${fileStamp(envFile)}|${configFile ? fileStamp(configFile) : '-'}`;
    if (next === key) return value;
    let env = {};
    const text = readText(envFile);
    if (text !== null) {
      try { env = parseEnv(text); } catch { /* .env hỏng: Hermes cũng bỏ qua */ }
    }
    const pick = (name) => (Object.hasOwn(env, name) ? env[name] : inherited[name]);
    let extra;
    if (configFile) {
      try { extra = YAML.parse(readText(configFile) ?? '')?.platforms?.zalo?.extra; } catch { extra = undefined; }
    }
    const policy = isObj(extra) && Object.hasOwn(extra, 'dm_policy') ? extra.dm_policy : (pick('ZALO_DM_POLICY') ?? 'owner-only');
    value = {
      legacyWho: String(policy).trim().toLowerCase() === 'open' ? 'everyone' : 'owners',
      gatewayOpen: truthy(pick('ZALO_ALLOW_ALL_USERS')) || truthy(pick('GATEWAY_ALLOW_ALL_USERS')),
    };
    key = next;
    return value;
  };
}

/** Một lớp: chỉ giữ khoá biết và đúng kiểu — giống `_layer` bên Python (9 nút + 4 nút xưởng + hạn mức xưởng). */
function layer(raw) {
  if (!isObj(raw)) return {};
  const out = {};
  for (const k of SWITCHES) if (typeof raw[k] === 'boolean') out[k] = raw[k];
  const features = pickBools(raw.features, [...FEATURE_KEYS, ...STUDIO_KEYS]);
  if (Object.keys(features).length) out.features = features;
  for (const k of QUOTA_KEYS) if (isQuota(raw[k])) out[k] = raw[k];
  return out;
}

/** Mục gốc `studio` (giống `_studio_section` bên Python); không phải object → null. */
function normalizeStudio(raw) {
  if (!isObj(raw)) return null;
  const out = { people: {} };
  for (const k of ['quota', 'image', 'video']) if (isQuota(raw[k])) out[k] = raw[k];
  for (const [uid, entry] of Object.entries(isObj(raw.people) ? raw.people : {})) {
    if (!GROUP_ID.test(uid) || !isObj(entry) || !isQuota(entry.quota)) continue;
    const name = tidy(entry.name, MAX_PERSON_NAME);
    out.people[uid] = { ...(name ? { name } : {}), quota: entry.quota,
      ...(isQuota(entry.image) ? { image: entry.image } : {}), ...(isQuota(entry.video) ? { video: entry.video } : {}) };
  }
  return out;
}

/**
 * Mục `folders` (thư mục nhóm), giống `_folders` bên Python: `{ fid: { name, groups: [id], ...lớp } }`.
 * Mỗi nhóm thuộc tối đa một thư mục — nhóm có ở nhiều thư mục (tệp sửa tay) thì thư mục đứng trước giữ nhóm.
 */
export function normalizeFolders(raw) {
  const out = {};
  const taken = new Set();
  const takenPeople = new Set();
  for (const [fid, entry] of Object.entries(isObj(raw) ? raw : {})) {
    if (!FOLDER_ID.test(fid) || !isObj(entry) || Object.keys(out).length >= MAX_FOLDERS) continue;
    const groups = (Array.isArray(entry.groups) ? entry.groups : []).filter((id) => typeof id === 'string' && GROUP_ID.test(id) && !taken.has(id)).slice(0, MAX_GROUPS);
    groups.forEach((id) => taken.add(id));
    // Người trong thư mục (khi nhắn riêng): [{ uid, name }] — mỗi người một thư mục, như nhóm.
    const people = [];
    for (const p of Array.isArray(entry.people) ? entry.people : []) {
      const uid = String((isObj(p) ? p.uid : p) ?? '');
      if (!ZALO_UID.test(uid) || takenPeople.has(uid) || people.length >= MAX_FOLDER_PEOPLE) continue;
      takenPeople.add(uid);
      const name = isObj(p) ? tidy(p.name, MAX_NAME) : '';
      people.push(name ? { uid, name } : { uid });
    }
    const color = FOLDER_COLORS.includes(entry.color) ? entry.color : null;
    const rules = tidyRules(entry.rules);
    out[fid] = { name: tidy(entry.name, MAX_FOLDER_NAME) || 'Thư mục', ...(color ? { color } : {}), groups, ...(people.length ? { people } : {}), ...(rules ? { rules } : {}), ...layer(entry) };
  }
  return out;
}

/** Chuẩn hoá nội dung tệp; ném lỗi khi không phải lược đồ phiên bản 1. */
export function normalize(raw) {
  if (!isObj(raw) || raw.version !== 1) throw new Error('không phải permissions.json phiên bản 1');
  const groups = {};
  for (const [id, entry] of Object.entries(isObj(raw.groups) ? raw.groups : {})) {
    if (!GROUP_ID.test(id)) continue;
    const l = layer(entry);
    const name = isObj(entry) && typeof entry.name === 'string' ? entry.name.trim().slice(0, MAX_NAME) : '';
    groups[id] = name ? { name, ...l } : l;
  }
  // Mục `dm` (giai đoạn 5) và `studio` (giai đoạn 6) phải sống qua mọi lần lưu nhóm/mặc định.
  const dm = normalizeDm(raw.dm);
  const studio = normalizeStudio(raw.studio);
  // Mục `tools` (giai đoạn 7B, spec §18.6): công cụ tắt riêng với người không phải chủ nhân — cũng phải sống qua mọi lần lưu.
  const tools = normalizeTools(raw.tools);
  const folders = normalizeFolders(raw.folders);
  return { version: 1, defaults: layer(raw.defaults), groups, ...(Object.keys(folders).length ? { folders } : {}),
    ...(dm ? { dm } : {}), ...(studio ? { studio } : {}), ...(tools ? { tools } : {}) };
}

export const TOOL_NAME = /^[a-z0-9_]{1,64}$/;
export const MAX_TOOLS_OFF = 200;

/** Như `_tools_off` bên Python: `{ off: [tên công cụ hợp lệ, không trùng] }`; không phải object → null. */
export function normalizeTools(raw) {
  if (!isObj(raw)) return null;
  const off = Array.isArray(raw.off) ? [...new Set(raw.off.filter((n) => typeof n === 'string' && TOOL_NAME.test(n)))].slice(0, MAX_TOOLS_OFF) : [];
  return { off };
}

/** 4 nút xưởng gửi lên: thiếu → undefined (giữ như cũ — bản giao diện cũ không gửi); có thì phải đủ và đúng kiểu. */
function parseStudioSwitches(raw, what) {
  if (raw === undefined || raw === null) return undefined;
  if (!isObj(raw) || Object.keys(raw).some((k) => !STUDIO_KEYS.includes(k)) || STUDIO_KEYS.some((k) => typeof raw[k] !== 'boolean')) {
    throw new InvalidPermissions(`Nút xưởng tạo sản phẩm ${what} không hợp lệ — tải lại trang rồi thử lại.`);
  }
  return Object.fromEntries(STUDIO_KEYS.map((k) => [k, raw[k]]));
}

/** Ô hạn mức tuỳ chọn: thiếu → giá trị `fallback`; null → theo lớp trên; còn lại phải là số 0–50. */
const optQuota = (v, what, fallback) => {
  if (v === undefined) return fallback;
  if (v === null || isQuota(v)) return v;
  throw new InvalidPermissions(`${what} là số nguyên từ 0 đến ${MAX_STUDIO_QUOTA}, hoặc để trống — sửa rồi lưu lại.`);
};

/** Thân PUT /api/permissions/studio: `{ quota, image?, video?, people: [{ uid, name?, quota, image?, video? }] }`. */
export function parseStudio(body) {
  if (!isObj(body) || !isQuota(body.quota)) throw new InvalidPermissions(`Số lượt mặc định là số nguyên từ 0 đến ${MAX_STUDIO_QUOTA} — sửa rồi lưu lại.`);
  const image = optQuota(body.image, 'Số ảnh AI mặc định', DEFAULT_IMAGE_QUOTA) ?? DEFAULT_IMAGE_QUOTA;
  const video = optQuota(body.video, 'Số video AI mặc định', DEFAULT_VIDEO_QUOTA) ?? DEFAULT_VIDEO_QUOTA;
  if (!Array.isArray(body.people)) throw new InvalidPermissions('Danh sách người không hợp lệ — tải lại trang rồi thử lại.');
  if (body.people.length > MAX_STUDIO_PEOPLE) throw new InvalidPermissions(`Hạn mức riêng tối đa ${MAX_STUDIO_PEOPLE} người — bỏ bớt rồi lưu lại.`);
  const seen = new Set();
  const people = [];
  for (const p of body.people) {
    const uid = String(isObj(p) ? p.uid ?? '' : '').trim();
    if (!ZALO_UID.test(uid)) {
      throw new InvalidPermissions(`"${uid.slice(0, 30)}" không phải UID Zalo — UID là dãy 15–22 chữ số; nhờ người đó nhắn /sethome cho bot để biết.`);
    }
    if (!isQuota(p.quota)) throw new InvalidPermissions(`Số lượt của một người là số nguyên từ 0 đến ${MAX_STUDIO_QUOTA} — sửa rồi lưu lại.`);
    if (seen.has(uid)) continue;
    seen.add(uid);
    people.push({ uid, name: tidy(p.name, MAX_PERSON_NAME), quota: p.quota,
      image: optQuota(p.image, 'Số ảnh AI của một người', null), video: optQuota(p.video, 'Số video AI của một người', null) });
  }
  return { quota: body.quota, image, video, people };
}

/**
 * Kiểm thân PUT /api/permissions/dm: `{ who, features: 8 nút, people: [{ uid, name?, features: 8 nút | null }] }`.
 * `features: null` ở một người = theo nút chung. UID trùng giữ mục đầu.
 */
export function parseDm(body) {
  if (!isObj(body) || !DM_WHO.includes(body.who)) throw new InvalidPermissions('Chưa chọn ai được nhắn riêng với bot — tải lại trang rồi thử lại.');
  const full = (f) => isObj(f) && !Object.keys(f).some((k) => !DM_FEATURE_KEYS.includes(k)) && DM_FEATURE_KEYS.every((k) => typeof f[k] === 'boolean');
  const pick8 = (f) => Object.fromEntries(DM_FEATURE_KEYS.map((k) => [k, f[k]]));
  if (!full(body.features)) throw new InvalidPermissions('Danh sách tính năng không hợp lệ — tải lại trang rồi thử lại.');
  if (!Array.isArray(body.people)) throw new InvalidPermissions('Danh sách người không hợp lệ — tải lại trang rồi thử lại.');
  if (body.people.length > MAX_DM_PEOPLE) throw new InvalidPermissions(`Danh sách tối đa ${MAX_DM_PEOPLE} người — bỏ bớt rồi lưu lại.`);
  const seen = new Set();
  const people = [];
  for (const p of body.people) {
    const uid = String(isObj(p) ? p.uid ?? '' : '').trim();
    if (!ZALO_UID.test(uid)) {
      throw new InvalidPermissions(`"${uid.slice(0, 30)}" không phải UID Zalo — UID là dãy 15–22 chữ số; nhờ người đó nhắn /sethome cho bot để biết.`);
    }
    if (p.features != null && !full(p.features)) throw new InvalidPermissions('Tính năng riêng của một người không hợp lệ — tải lại trang rồi thử lại.');
    if (seen.has(uid)) continue;
    seen.add(uid);
    const name = typeof p.name === 'string' ? p.name.replace(/\s+/g, ' ').trim().slice(0, MAX_PERSON_NAME) : '';
    const studio = parseStudioSwitches(p.studio, 'của một người');
    people.push({ uid, name, features: p.features == null ? null : pick8(p.features), ...(studio ? { studio } : {}) });
  }
  const studio = parseStudioSwitches(body.studio, 'khi nhắn riêng');
  return { who: body.who, features: pick8(body.features), people, ...(studio ? { studio } : {}) };
}

/**
 * Kiểm thân request: đủ hai công tắc và đủ 9 nút, tất cả boolean. Tuỳ chọn (spec §17): `studio` = 4 nút xưởng,
 * `studioQuota` = số lượt mỗi người mỗi ngày của nhóm (null = theo mặc định).
 */
export function parseSettings(body) {
  const base = parseSettings9(body);
  const studio = parseStudioSwitches(body.studio, '');
  if (studio) base.studio = studio;
  const what = { studioQuota: 'Số lượt xưởng', imageQuota: 'Số ảnh AI mỗi ngày', videoQuota: 'Số video AI mỗi ngày' };
  for (const k of QUOTA_KEYS) {
    if (body[k] === undefined) continue;
    if (body[k] !== null && !isQuota(body[k])) {
      throw new InvalidPermissions(`${what[k]} là số nguyên từ 0 đến ${MAX_STUDIO_QUOTA}, hoặc để trống để theo mặc định — sửa rồi lưu lại.`);
    }
    base[k] = body[k];
  }
  return base;
}

/**
 * Thân PUT /api/permissions/groups (chỉnh nhiều nhóm một lượt): `{ ids: [mã nhóm], patch: { active?, replyOnlyTagged?,
 * features?: { khoá: bool }, studio?: { khoá: bool } } }`. Chỉ khoá có trong `patch` được đổi; phải có ít nhất một khoá.
 */
export function parseGroupsPatch(body) {
  const ids = isObj(body) && Array.isArray(body.ids) ? body.ids : null;
  if (!ids || !ids.length || ids.some((id) => typeof id !== 'string' || !GROUP_ID.test(id))) {
    throw new InvalidPermissions('Danh sách nhóm không hợp lệ — tải lại trang rồi thử lại.');
  }
  const unique = [...new Set(ids)];
  if (unique.length > MAX_GROUPS) throw new InvalidPermissions(`Mỗi lần chỉnh tối đa ${MAX_GROUPS} nhóm.`);
  const p = body.patch;
  const bad = () => new InvalidPermissions('Thay đổi không hợp lệ — tải lại trang rồi thử lại.');
  if (!isObj(p) || Object.keys(p).some((k) => ![...SWITCHES, 'features', 'studio'].includes(k))) throw bad();
  const patch = {};
  for (const k of SWITCHES) {
    if (p[k] === undefined) continue;
    if (typeof p[k] !== 'boolean') throw bad();
    patch[k] = p[k];
  }
  for (const [k, keys] of [['features', FEATURE_KEYS], ['studio', STUDIO_KEYS]]) {
    if (p[k] === undefined) continue;
    if (!isObj(p[k]) || Object.entries(p[k]).some(([key, v]) => !keys.includes(key) || typeof v !== 'boolean')) throw bad();
    if (Object.keys(p[k]).length) patch[k] = { ...p[k] };
  }
  if (!Object.keys(patch).length) throw new InvalidPermissions('Chưa chọn thay đổi nào — chọn Bật hoặc Tắt ở ít nhất một mục.');
  return { ids: unique, patch };
}

function parseSettings9(body) {
  if (!isObj(body)) throw new InvalidPermissions('Dữ liệu phân quyền không hợp lệ — tải lại trang rồi thử lại.');
  for (const k of SWITCHES) {
    if (typeof body[k] !== 'boolean') throw new InvalidPermissions('Thiếu công tắc Hoạt động hoặc Chỉ trả lời khi được tag — tải lại trang rồi thử lại.');
  }
  const f = body.features;
  if (!isObj(f) || Object.keys(f).some((k) => !FEATURE_KEYS.includes(k)) || FEATURE_KEYS.some((k) => typeof f[k] !== 'boolean')) {
    throw new InvalidPermissions('Danh sách tính năng không hợp lệ — tải lại trang rồi thử lại.');
  }
  return { active: body.active, replyOnlyTagged: body.replyOnlyTagged, features: Object.fromEntries(FEATURE_KEYS.map((k) => [k, f[k]])) };
}

/**
 * @param {{ file: string, globalReplyOnlyTagged?: boolean | (() => boolean) }} opts
 *   globalReplyOnlyTagged — cờ ZALO_GROUP_REPLY_ONLY_TAGGED bot đang dùng (xem makeGlobalReplyOnlyTagged).
 *   Dùng để hiển thị khi tệp chưa ghi khoá này, và để ghi hạt giống `defaults.replyOnlyTagged` ở lần lưu đầu.
 */
export function createPermissionsStore({ file, globalReplyOnlyTagged = true, dmEnv = () => ({ legacyWho: 'owners', gatewayOpen: true }) }) {
  const globalFlag = () => (typeof globalReplyOnlyTagged === 'function' ? globalReplyOnlyTagged() : globalReplyOnlyTagged);
  const builtin = () => ({ active: true, replyOnlyTagged: globalFlag(), features: Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])), studio: studioOff() });
  // Trong tệp, nút xưởng nằm chung `features`; ở giao diện tách ra `studio` (thiếu khoá = tắt).
  const merge = (base, l) => ({
    active: l.active ?? base.active,
    replyOnlyTagged: l.replyOnlyTagged ?? base.replyOnlyTagged,
    features: { ...base.features, ...pickBools(l.features, FEATURE_KEYS) },
    studio: { ...base.studio, ...pickBools(l.features, STUDIO_KEYS) },
  });

  /** `{ data, exists, corrupt }` — tệp hỏng thì data rỗng (bot cũng đang dùng mặc định), không đổi tên tệp. */
  function read() {
    if (!existsSync(file)) return { data: { version: 1, defaults: {}, groups: {} }, exists: false, corrupt: false };
    try {
      // Sửa tay bằng Notepad có thể để lại BOM; plugin đọc bằng utf-8-sig nên dashboard cũng bỏ BOM.
      return { data: normalize(JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))), exists: true, corrupt: false };
    } catch (err) {
      console.warn(`[dashboard] ${file} hỏng — bot đang dùng mặc định: ${err.message}`);
      return { data: { version: 1, defaults: {}, groups: {} }, exists: true, corrupt: true };
    }
  }

  function write(data) {
    if (existsSync(file)) {
      copyFileSync(file, `${file}.bak`);
      try { chmodSync(`${file}.bak`, 0o600); } catch { /* Windows */ }
    }
    writeJsonAtomic(file, data);
  }

  /**
   * Lần lưu đầu tiên khi `defaults` chưa có cờ tag: ghi cờ thật của bot vào `defaults` một lần (hạt giống),
   * để từ đó cờ tag được so khác biệt như mọi khoá khác. Bản cũ từng ghi cờ tag vào từng nhóm — mục nhóm
   * nào ghi đúng bằng giá trị mặc định mới thì bỏ khoá đó (không đổi hành vi); mục chỉ còn tên thì xoá.
   * `next` = giá trị cờ tag của `defaults` sau lần lưu này (mặc định: cờ thật của bot).
   */
  function seedReplyOnlyTagged(data, next = globalFlag()) {
    if (data.defaults.replyOnlyTagged !== undefined) return;
    data.defaults.replyOnlyTagged = next;
    for (const [id, g] of Object.entries(data.groups)) {
      if (g.replyOnlyTagged !== next) continue;
      const { replyOnlyTagged: _drop, ...rest } = g;
      if (Object.keys(rest).some((k) => k !== 'name')) data.groups[id] = rest;
      else delete data.groups[id];
    }
  }

  /** Mục nhắn riêng đã gộp: chưa có trong tệp → `who` theo ZALO_DM_POLICY (`explicit: false`), mọi nút bật. */
  const dmView = (dm) => {
    const env = dmEnv();
    const features = { ...Object.fromEntries(DM_FEATURE_KEYS.map((k) => [k, true])), ...pickBools(dm?.features, DM_FEATURE_KEYS) };
    const studio = { ...studioOff(), ...pickBools(dm?.features, STUDIO_KEYS) };
    const people = Object.entries(dm?.people || {}).map(([uid, p]) => ({
      uid, name: p.name || '', custom: Object.keys(p.features || {}).length > 0,
      features: { ...features, ...pickBools(p.features, DM_FEATURE_KEYS) }, studio: { ...studio, ...pickBools(p.features, STUDIO_KEYS) },
    }));
    return { who: dm?.who || env.legacyWho, explicit: Boolean(dm?.who), gatewayOpen: env.gatewayOpen, features, studio, people };
  };

  /** Hạn mức xưởng: mặc định mỗi người mỗi ngày + danh sách người có hạn mức riêng. */
  const studioView = (st) => ({
    quota: st?.quota ?? DEFAULT_STUDIO_QUOTA, image: st?.image ?? DEFAULT_IMAGE_QUOTA, video: st?.video ?? DEFAULT_VIDEO_QUOTA,
    people: Object.entries(st?.people || {}).map(([uid, p]) => ({ uid, name: p.name || '', quota: p.quota, image: p.image ?? null, video: p.video ?? null })),
  });

  /** Thư mục chứa nhóm (id) hoặc null. */
  const folderOf = (data, groupId) => Object.entries(data.folders || {}).find(([, f]) => f.groups.includes(groupId))?.[0] || null;
  /** Cài đặt nền của nhóm: thư mục đã gộp (nếu nhóm thuộc thư mục) hoặc mặc định. Hạn mức xưởng của thư mục đi kèm. */
  const baseOf = (data, defaults, groupId) => {
    const fid = folderOf(data, groupId);
    const f = fid ? data.folders[fid] : null;
    return f ? { ...merge(defaults, f), ...quotasOf(f), folder: fid } : { ...defaults, ...noQuotas(), folder: null };
  };

  const view = ({ data, exists, corrupt }) => {
    const defaults = merge(builtin(), data.defaults);
    const groups = Object.fromEntries(Object.entries(data.groups).map(([id, g]) => {
      const base = baseOf(data, defaults, id);
      return [id, { name: g.name || '', custom: true, folder: base.folder, ...merge(base, g),
        ...Object.fromEntries(QUOTA_KEYS.map((k) => [k, g[k] ?? base[k]])) }];
    }));
    const folders = Object.entries(data.folders || {}).map(([id, f], i) => ({
      id, name: f.name, color: f.color || FOLDER_COLORS[i % FOLDER_COLORS.length], groups: [...f.groups], people: (f.people || []).map((p) => ({ uid: p.uid, name: p.name || '' })), rules: f.rules || '', ...merge(defaults, f), ...quotasOf(f),
    }));
    return { exists, corrupt, defaults, groups, folders, dm: dmView(data.dm), studio: studioView(data.studio), toolsOff: data.tools?.off || [] };
  };

  /** Lớp chỉ giữ khoá khác `base` (đã gộp) — dùng cho nhóm (nền: thư mục/mặc định) và thư mục (nền: mặc định). */
  const diffLayer = (settings, base, prev) => {
    const entry = {};
    for (const k of SWITCHES) if (settings[k] !== base[k]) entry[k] = settings[k];
    const features = Object.fromEntries(FEATURE_KEYS.filter((k) => settings.features[k] !== base.features[k]).map((k) => [k, settings.features[k]]));
    const studio = settings.studio ?? { ...base.studio, ...pickBools(prev.features, STUDIO_KEYS) };
    for (const k of STUDIO_KEYS) if (studio[k] !== base.studio[k]) features[k] = studio[k];
    if (Object.keys(features).length) entry.features = features;
    for (const k of QUOTA_KEYS) {
      const quota = settings[k] === undefined ? prev[k] ?? null : settings[k];
      if (quota !== null && quota !== base[k]) entry[k] = quota;
    }
    const changed = [...SWITCHES.filter((k) => settings[k] !== base[k]), ...Object.keys(features), ...QUOTA_KEYS.filter((k) => k in entry)];
    return { entry, changed };
  };

  /** Ghi mục của một nhóm vào `data` (chưa ghi tệp): chỉ khoá khác nền; không còn khoá nào thì xoá mục. Trả `changed`. */
  const putGroup = (data, groupId, settings, name, keep) => {
    const prevName = data.groups[groupId]?.name;
    // Nền của nhóm: thư mục chứa nó (nếu có), không thì mặc định — nhóm chỉ ghi khoá khác nền.
    const base = baseOf(data, merge(builtin(), data.defaults), groupId);
    const { entry, changed } = diffLayer(settings, base, data.groups[groupId] || {});
    const cleanName = String(name || prevName || '').trim().slice(0, MAX_NAME);
    if (Object.keys(entry).length && !data.groups[groupId] && Object.keys(data.groups).length >= MAX_GROUPS) {
      throw new InvalidPermissions(`Đã có ${MAX_GROUPS} nhóm được chỉnh riêng, chưa thêm được nhóm nữa — đưa bớt nhóm về mặc định rồi thử lại.`);
    }
    if (Object.keys(entry).length) data.groups[groupId] = cleanName ? { name: cleanName, ...entry } : entry;
    // `keep`: nhóm thuộc danh sách cũ "chỉ chủ nhân" — mục chỉ có tên vẫn là "đã phân quyền riêng" với bot.
    else if (keep) data.groups[groupId] = { name: cleanName || 'Nhóm chưa rõ tên' };
    else delete data.groups[groupId];
    return changed;
  };

  const folderOrThrow = (data, fid) => {
    if (!FOLDER_ID.test(String(fid)) || !data.folders?.[fid]) throw new InvalidPermissions('Không thấy thư mục này — tải lại trang rồi thử lại.');
    return data.folders[fid];
  };
  const folderName = (name) => {
    const clean = tidy(name, MAX_FOLDER_NAME);
    if (!clean) throw new InvalidPermissions('Thư mục cần một cái tên — vd. "Lớp học", "Đoàn trường".');
    return clean;
  };

  return {
    /** Trạng thái đã gộp cho giao diện: `{ exists, corrupt, defaults, groups: { id: { name, custom, active, replyOnlyTagged, features } } }`. */
    get() { return view(read()); },
    /** Lưu mặc định: ghi đủ mọi khoá (người dùng đã chọn từng nút). */
    setDefaults(settings) {
      const { data } = read();
      seedReplyOnlyTagged(data, settings.replyOnlyTagged);
      // Bản giao diện cũ không gửi nút xưởng → giữ nút xưởng đang có trong tệp.
      const studio = settings.studio ?? pickBools(data.defaults.features, STUDIO_KEYS);
      data.defaults = { active: settings.active, replyOnlyTagged: settings.replyOnlyTagged, features: { ...settings.features, ...onlyOn(studio) } };
      write(data);
      return view({ data, exists: true, corrupt: false });
    },
    /**
     * Lưu một nhóm: chỉ ghi khoá khác mặc định (spec §8.1), để nút chưa đụng tới đi theo mặc định sau này.
     * Không còn khoá nào khác → xoá mục của nhóm. Trả `{ state, changed: string[] }` (các khoá khác mặc định).
     */
    setGroup(groupId, settings, name = '', { keep = false } = {}) {
      if (!GROUP_ID.test(groupId)) throw new InvalidPermissions('Nhóm không hợp lệ — chọn lại từ danh sách.');
      const { data } = read();
      seedReplyOnlyTagged(data);
      const changed = putGroup(data, groupId, settings, name, keep);
      write(data);
      return { state: view({ data, exists: true, corrupt: false }), changed };
    },
    /**
     * Áp một thay đổi cho nhiều nhóm (đã qua parseGroupsPatch): mỗi nhóm lấy cài đặt đang hiệu lực của chính nó,
     * đè các khoá trong `patch`, rồi ghi như setGroup (chỉ khoá khác nền thư mục/mặc định). Một lần ghi tệp.
     * `nameOf(id)` → tên nhóm; `keepOf(id)` → nhóm thuộc danh sách cũ "chỉ chủ nhân". Trả `{ state, changed }`
     * (`changed` = số nhóm có chỉnh riêng sau lần lưu).
     */
    setGroups(ids, patch, { nameOf = () => '', keepOf = () => false } = {}) {
      const { data } = read();
      seedReplyOnlyTagged(data);
      const defaults = merge(builtin(), data.defaults);
      let changed = 0;
      for (const id of ids) {
        const cur = merge(baseOf(data, defaults, id), data.groups[id] || {});
        const settings = { active: patch.active ?? cur.active, replyOnlyTagged: patch.replyOnlyTagged ?? cur.replyOnlyTagged,
          features: { ...cur.features, ...patch.features }, studio: { ...cur.studio, ...patch.studio } };
        if (putGroup(data, id, settings, nameOf(id), keepOf(id)).length) changed += 1;
      }
      write(data);
      return { state: view({ data, exists: true, corrupt: false }), changed };
    },
    /** Tạo thư mục rỗng (theo mặc định). Trả `{ state, id }`. */
    createFolder(name) {
      const clean = folderName(name);
      const { data } = read();
      data.folders = data.folders || {};
      if (Object.keys(data.folders).length >= MAX_FOLDERS) throw new InvalidPermissions(`Tối đa ${MAX_FOLDERS} thư mục — xoá bớt rồi tạo mới.`);
      let id;
      do { id = randomBytes(5).toString('hex').slice(0, 8); } while (data.folders[id]);
      // Màu chưa thư mục nào dùng (hết thì quay vòng) — để các thư mục khác màu nhau ngay từ đầu.
      const used = new Set(Object.values(data.folders).map((f) => f.color));
      const color = FOLDER_COLORS.find((c) => !used.has(c)) || FOLDER_COLORS[Object.keys(data.folders).length % FOLDER_COLORS.length];
      data.folders[id] = { name: clean, color, groups: [] };
      write(data);
      return { state: view({ data, exists: true, corrupt: false }), id };
    },
    renameFolder(fid, name) {
      const clean = folderName(name);
      const { data } = read();
      folderOrThrow(data, fid).name = clean;
      write(data);
      return view({ data, exists: true, corrupt: false });
    },
    /** Quy tắc riêng của thư mục (rỗng = bỏ): bot làm theo khi trả lời nhóm/người trong thư mục. */
    setFolderRules(fid, rules) {
      if (typeof rules !== 'string') throw new InvalidPermissions('Quy tắc không hợp lệ — tải lại trang rồi thử lại.');
      if (rules.trim().length > MAX_FOLDER_RULES) throw new InvalidPermissions(`Quy tắc dài quá ${MAX_FOLDER_RULES} ký tự — rút gọn bớt.`);
      const { data } = read();
      const folder = folderOrThrow(data, fid);
      const clean = tidyRules(rules);
      if (clean) folder.rules = clean; else delete folder.rules;
      write(data);
      return view({ data, exists: true, corrupt: false });
    },
    setFolderColor(fid, color) {
      if (!FOLDER_COLORS.includes(color)) throw new InvalidPermissions('Màu không hợp lệ — chọn lại trong bảng màu.');
      const { data } = read();
      folderOrThrow(data, fid).color = color;
      write(data);
      return view({ data, exists: true, corrupt: false });
    },
    /** Xoá thư mục: nhóm bên trong quay về theo mặc định, phần chỉnh riêng của từng nhóm giữ nguyên. */
    deleteFolder(fid) {
      const { data } = read();
      folderOrThrow(data, fid);
      delete data.folders[fid];
      write(data);
      return view({ data, exists: true, corrupt: false });
    },
    /** Đặt danh sách nhóm của thư mục; nhóm đang ở thư mục khác thì chuyển sang (mỗi nhóm một thư mục). */
    setFolderMembers(fid, ids) {
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !GROUP_ID.test(id))) throw new InvalidPermissions('Danh sách nhóm không hợp lệ — tải lại trang rồi thử lại.');
      const unique = [...new Set(ids)];
      if (unique.length > MAX_GROUPS) throw new InvalidPermissions(`Một thư mục tối đa ${MAX_GROUPS} nhóm.`);
      const { data } = read();
      const folder = folderOrThrow(data, fid);
      for (const [other, f] of Object.entries(data.folders)) if (other !== fid) f.groups = f.groups.filter((id) => !unique.includes(id));
      folder.groups = unique;
      write(data);
      return view({ data, exists: true, corrupt: false });
    },
    /**
     * Đặt danh sách NGƯỜI của thư mục (`[{ uid, name }]`): khi họ nhắn riêng, bot dùng cài đặt thư mục và họ được
     * tính là có trong danh sách nhắn riêng. Người đang ở thư mục khác thì chuyển sang (mỗi người một thư mục).
     */
    /**
     * Thêm người vào thư mục (Liên hệ: đồng ý kết bạn rồi xếp luôn, hoặc chuyển 1/nhiều người): giữ người đang có,
     * tên mới thay tên cũ; người đang ở thư mục khác thì chuyển sang (mỗi người chỉ thuộc một thư mục).
     */
    addFolderPeople(fid, people) {
      if (!Array.isArray(people)) throw new InvalidPermissions('Danh sách người không hợp lệ.');
      const { data } = read();
      const current = folderOrThrow(data, fid).people || [];
      const incoming = new Map(people.map((p) => [String(p?.uid ?? ''), p]));
      const merged = current.map((p) => (incoming.has(p.uid) ? { uid: p.uid, name: tidy(incoming.get(p.uid).name, MAX_NAME) || p.name } : p));
      const have = new Set(current.map((p) => p.uid));
      return this.setFolderPeople(fid, [...merged, ...people.filter((p) => !have.has(String(p?.uid ?? '')))]);
    },
    setFolderPeople(fid, people) {
      if (!Array.isArray(people) || people.some((p) => !isObj(p) || !ZALO_UID.test(String(p.uid ?? '')))) {
        throw new InvalidPermissions('Danh sách người không hợp lệ — UID Zalo là dãy 15–22 chữ số.');
      }
      const seen = new Set();
      const clean = [];
      for (const p of people) {
        const uid = String(p.uid);
        if (seen.has(uid)) continue;
        seen.add(uid);
        const name = tidy(p.name, MAX_NAME);
        clean.push(name ? { uid, name } : { uid });
      }
      if (clean.length > MAX_FOLDER_PEOPLE) throw new InvalidPermissions(`Một thư mục tối đa ${MAX_FOLDER_PEOPLE} người.`);
      const { data } = read();
      const folder = folderOrThrow(data, fid);
      for (const [other, f] of Object.entries(data.folders)) {
        if (other !== fid && f.people) { f.people = f.people.filter((p) => !seen.has(p.uid)); if (!f.people.length) delete f.people; }
      }
      if (clean.length) folder.people = clean; else delete folder.people;
      write(data);
      return view({ data, exists: true, corrupt: false });
    },
    /** Lưu cài đặt thư mục (đã qua parseSettings): chỉ ghi khoá khác mặc định — nhóm bên trong thừa hưởng ngay. */
    setFolderSettings(fid, settings) {
      const { data } = read();
      const folder = folderOrThrow(data, fid);
      seedReplyOnlyTagged(data);
      const defaults = { ...merge(builtin(), data.defaults), ...noQuotas() };
      const { entry, changed } = diffLayer(settings, defaults, folder);
      data.folders[fid] = { name: folder.name, ...(folder.color ? { color: folder.color } : {}), groups: folder.groups, ...(folder.people?.length ? { people: folder.people } : {}), ...(folder.rules ? { rules: folder.rules } : {}), ...entry };
      write(data);
      return { state: view({ data, exists: true, corrupt: false }), changed };
    },
    /**
     * Bật/tắt nhanh cả thư mục: đặt "Hoạt động" của thư mục và bỏ "Hoạt động" chỉnh riêng của các nhóm bên trong,
     * để mọi nhóm trong thư mục cùng theo một trạng thái. Trả `{ state, cleared }` (số nhóm vừa bỏ chỉnh riêng).
     */
    setFolderActive(fid, active) {
      if (typeof active !== 'boolean') throw new InvalidPermissions('Thiếu trạng thái bật/tắt — tải lại trang rồi thử lại.');
      const { data } = read();
      const folder = folderOrThrow(data, fid);
      const defaults = merge(builtin(), data.defaults);
      if (active === defaults.active) delete folder.active; else folder.active = active;
      let cleared = 0;
      for (const id of folder.groups) {
        const g = data.groups[id];
        if (!g || g.active === undefined) continue;
        const { active: _drop, ...rest } = g;
        cleared += 1;
        if (Object.keys(rest).some((k) => k !== 'name')) data.groups[id] = rest; else delete data.groups[id];
      }
      write(data);
      return { state: view({ data, exists: true, corrupt: false }), cleared };
    },
    /**
     * Lưu mục nhắn riêng (đã qua parseDm): `who` + đủ 8 nút chung; mỗi người chỉ ghi nút khác nút chung.
     * Tệp vẫn là phiên bản 1 — plugin/dashboard v1.21–1.22 bỏ qua khoá `dm` khi đọc.
     */
    setDm(settings) {
      const { data } = read();
      const prevStudio = { ...studioOff(), ...pickBools(data.dm?.features, STUDIO_KEYS) };
      const studio = settings.studio ?? prevStudio;
      const people = {};
      for (const p of settings.people) {
        const diff = p.features ? Object.fromEntries(DM_FEATURE_KEYS.filter((k) => p.features[k] !== settings.features[k]).map((k) => [k, p.features[k]])) : {};
        // Người có tính năng riêng: nút xưởng riêng (gửi lên, hoặc giữ như cũ nếu bản giao diện cũ không gửi).
        const own = p.features ? p.studio ?? { ...studio, ...pickBools(data.dm?.people?.[p.uid]?.features, STUDIO_KEYS) } : studio;
        for (const k of STUDIO_KEYS) if (own[k] !== studio[k]) diff[k] = own[k];
        people[p.uid] = { ...(p.name ? { name: p.name } : {}), ...(Object.keys(diff).length ? { features: diff } : {}) };
      }
      data.dm = { who: settings.who, features: { ...settings.features, ...onlyOn(studio) }, people };
      write(data);
      return view({ data, exists: true, corrupt: false });
    },
    /** Lưu danh sách công cụ tắt với người không phải chủ nhân (trang Công cụ, chỉ Quản trị). `names` đã kiểm ở route. */
    setToolsOff(names) {
      const { data } = read();
      data.tools = { off: [...new Set(names)].sort() };
      write(data);
      return view({ data, exists: true, corrupt: false });
    },
    /** Lưu hạn mức xưởng (đã qua parseStudio): số lượt mặc định + người có hạn mức riêng. */
    setStudio(settings) {
      const { data } = read();
      data.studio = {
        quota: settings.quota, image: settings.image ?? DEFAULT_IMAGE_QUOTA, video: settings.video ?? DEFAULT_VIDEO_QUOTA,
        people: Object.fromEntries(settings.people.map((p) => [p.uid, { ...(p.name ? { name: p.name } : {}), quota: p.quota,
          ...(isQuota(p.image) ? { image: p.image } : {}), ...(isQuota(p.video) ? { video: p.video } : {}) }])),
      };
      write(data);
      return view({ data, exists: true, corrupt: false });
    },
  };
}
