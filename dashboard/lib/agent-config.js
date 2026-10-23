/**
 * Agent (spec §18.6, chỉ Quản trị): model, mức suy nghĩ và tính cách (SOUL.md) của trợ lý Hermes.
 * - Model: như lệnh /model của chủ nhân (hermes-plugin/zalo/model_command.py) — chỉ nhận tên có trong
 *   `<model.base_url>/models`, sửa đúng dòng `model.default` của config.yaml. Gateway đọc lại config theo mtime ở
 *   mỗi tin nên có hiệu lực ngay, không cần khởi động lại. Khoá `model.api_key` chỉ dùng ở máy chủ để hỏi danh sách.
 * - Mức suy nghĩ: `agent.reasoning_effort` — đánh dấu cần khởi động lại trợ lý (không chắc gateway đọc lại nóng).
 * - SOUL.md: `<HERMES_HOME>/SOUL.md`; mỗi lần lưu cất bản cũ vào `<dashboard>/soul-history/` (giữ 30 bản), bản đầu
 *   tiên trước khi dashboard sửa lần nào được giữ riêng là "bản gốc". Hermes đọc SOUL.md khi dựng lời nhắc hệ thống
 *   cho phiên → đánh dấu cần khởi động lại trợ lý.
 * Không có "nhiệt độ" (temperature): Hermes không có cài đặt này cho trợ lý chính.
 */
import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { editConfigYaml, readConfigYaml } from './config-yaml.js';
import { writeFileAtomic } from './json-store.js';

export const REASONING = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const MODEL_NAME = /^[A-Za-z0-9._/@:+-]{1,120}$/;
export const MAX_SOUL = 20_000;
const KEEP_HISTORY = 30;
const SNAPSHOT_ID = /^(\d{13}-[a-z0-9_-]{1,32}|original)$/;

const err = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const splitList = (v) => (Array.isArray(v) ? v.map(String) : String(v ?? '').split(/[,\n]/)).map((s) => s.trim()).filter(Boolean);

export function createAgentConfig({ configFile, envValue = () => null, fetchImpl = fetch }) {
  const conf = () => readConfigYaml(configFile);
  return {
    view() {
      const c = conf();
      const extra = c?.platforms?.zalo?.extra || {};
      let endpoint = '';
      try { endpoint = new URL(String(c?.model?.base_url || '')).host; } catch { /* không có */ }
      return {
        model: String(c?.model?.default || ''), provider: String(c?.model?.provider || ''), endpoint,
        choices: splitList(extra.model_choices ?? envValue('ZALO_MODEL_CHOICES')),
        defaultModel: String(extra.model_default ?? envValue('ZALO_MODEL_DEFAULT') ?? '').trim(),
        reasoning: String(c?.agent?.reasoning_effort || 'medium'),
        zaloHint: String(c?.platform_hints?.zalo?.append || '').slice(0, 4000),
      };
    },
    /** Danh sách model của cổng AI đang cấu hình (chuẩn OpenAI `/models`). */
    async models() {
      return (await this.modelsInfo()).map((m) => m.id);
    },
    /** Như models() nhưng kèm tên hiển thị và giá (cổng nào trả `pricing`, vd. Stali — xem normalizePricing). */
    async modelsInfo() {
      const m = conf()?.model || {};
      const base = String(m.base_url || '').replace(/\/+$/, '');
      if (!/^https?:\/\//.test(base)) throw err(409, 'config.yaml chưa có model.base_url — báo người cài đặt.');
      let json;
      try {
        const res = await fetchImpl(`${base}/models`, { headers: m.api_key ? { Authorization: `Bearer ${m.api_key}` } : {}, signal: AbortSignal.timeout(10_000), redirect: 'error' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        json = await res.json();
      } catch { throw err(502, 'Cổng AI chưa trả danh sách model — thử lại sau ít phút.'); }
      return (Array.isArray(json?.data) ? json.data : [])
        .map((x) => ({ id: String(x?.id || ''), name: String(x?.display_name || '').slice(0, 80), pricing: normalizePricing(x?.pricing, x?.billing_unit) }))
        .filter((m) => MODEL_NAME.test(m.id)).slice(0, 500);
    },
    async setModel(name) {
      const model = String(name ?? '').trim();
      if (!MODEL_NAME.test(model)) throw err(400, 'Tên model không hợp lệ — chọn trong danh sách.');
      const list = await this.models();
      if (!list.includes(model)) throw err(400, `Cổng AI không có model ${model} — chọn trong danh sách.`);
      return editConfigYaml(configFile, [{ path: ['model', 'default'], value: model }]);
    },
    setReasoning(value) {
      if (!REASONING.includes(value)) throw err(400, 'Mức suy nghĩ không hợp lệ — chọn lại.');
      return editConfigYaml(configFile, [{ path: ['agent', 'reasoning_effort'], value }]);
    },
  };
}

/** Giá của một model từ `/models` (Stali): theo token → { unit: 'token', input, output (đồng / 1 triệu token), min (tối thiểu
 * mỗi lượt) }; theo lượt → { unit: 'request', perRequest }. Không có hoặc lạ → null. Chỉ nhận số hữu hạn không âm. */
export function normalizePricing(p, unit) {
  if (!p || typeof p !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const currency = typeof p.currency === 'string' ? p.currency.slice(0, 8) : 'VND';
  if (num(p.per_request) !== null && (unit === 'request' || num(p.input_per_1m) === null)) return { unit: 'request', currency, perRequest: num(p.per_request) };
  const input = num(p.input_per_1m); const output = num(p.output_per_1m);
  if (input === null || output === null) return null;
  return { unit: 'token', currency, input, output, min: num(p.min_per_request) ?? 0 };
}

export function createSoul({ hermesHome, historyDir, now = Date.now }) {
  const link = join(hermesHome, 'SOUL.md');
  // SOUL.md là symlink thì ghi vào tệp đích, không thay symlink bằng tệp thường.
  const target = () => { try { return realpathSync(link); } catch { return link; } };
  const snap = (id) => join(historyDir, `${id}.md`);
  const read = () => (existsSync(link) ? readFileSync(link, 'utf8').replace(/^﻿/, '') : '');
  function history() {
    let names = [];
    try { names = readdirSync(historyDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).filter((id) => SNAPSHOT_ID.test(id)); } catch { /* chưa có */ }
    return names.map((id) => ({
      id, original: id === 'original', at: id === 'original' ? statSync(snap(id)).mtimeMs : Number(id.slice(0, 13)),
      by: id === 'original' ? '' : id.slice(14), size: statSync(snap(id)).size,
    })).sort((a, b) => (a.original ? 1 : b.original ? -1 : b.at - a.at));
  }
  function write(text, by) {
    if (typeof text !== 'string') throw err(400, 'Tính cách phải là chữ — tải lại trang rồi thử lại.');
    const t = text.replace(/\r\n/g, '\n');
    if (!t.trim()) throw err(400, 'Tính cách đang trống — viết ít nhất vài dòng, hoặc khôi phục một bản cũ.');
    if (t.length > MAX_SOUL) throw err(400, `Tối đa ${MAX_SOUL} ký tự — rút gọn rồi lưu.`);
    const cur = read();
    if (t === cur) return false;
    mkdirSync(historyDir, { recursive: true, mode: 0o700 });
    const exists = existsSync(link);
    if (exists && !existsSync(snap('original'))) writeFileAtomic(snap('original'), cur);
    if (exists) writeFileAtomic(snap(`${now()}-${String(by).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'x'}`), cur);
    const file = target();
    const st = exists ? statSync(file) : null;
    const mode = st ? st.mode & 0o777 : 0o644;
    writeFileAtomic(file, t, {
      mode, tmpName: 'SOUL.md.dashboard-tmp',
      afterWrite: (tmp) => { if (st) { try { chownSync(tmp, st.uid, st.gid); } catch { /* Windows / không đủ quyền */ } } },
    });
    try { chmodSync(file, mode); } catch { /* Windows */ }
    for (const h of history().filter((x) => !x.original).slice(KEEP_HISTORY)) rmSync(snap(h.id), { force: true });
    return true;
  }
  return {
    view: () => ({ text: read(), exists: existsSync(link), max: MAX_SOUL, history: history() }),
    save: write,
    snapshot(id) {
      if (!SNAPSHOT_ID.test(String(id)) || !existsSync(snap(id))) throw err(404, 'Không có bản này — tải lại trang.');
      return readFileSync(snap(id), 'utf8');
    },
    restore(id, by) { return write(this.snapshot(id), by); },
  };
}
