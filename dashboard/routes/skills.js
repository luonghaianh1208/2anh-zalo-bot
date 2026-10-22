// Skill (kỹ năng) của trợ lý — chỉ Quản trị. Xem, bật/tắt trên Zalo (hiệu lực từ cuộc trò chuyện mới), xem nội dung,
// duyệt/tìm kho skill của Hermes, quét an toàn trước khi cài, cài, tải lên .zip / SKILL.md (qua bộ quét), gỡ.
// Cài/gỡ cần khởi động lại trợ lý để danh sách skill trong lời nhắc hệ thống cập nhật.
import express from 'express';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireAuth, requireRole } from '../lib/http-guards.js';
import { isBlocked } from '../lib/member-skills.js';

export const MAX_SKILL_UPLOAD = 8 * 1024 * 1024;
/** Trần số skill mỗi lần bật/tắt hàng loạt (mỗi skill một lệnh Hermes). */
export const MAX_BULK_SKILLS = 50;
/** Cùng luật tên skill sẵn có của hermes-admin.py (EXISTING_NAME). */
// eslint-disable-next-line no-control-regex
const SKILL_NAME = /^[^\u0000-\u001f\u007f/\\]{1,64}$/;

export function skillRoutes({ hermesAdmin, restartFlags, activity, memberSkills = null }) {
  const r = express.Router();
  const guard = [requireAuth, requireRole('admin')];
  const fail = (res, err, fallback) => {
    const status = Number.isInteger(err?.statusCode) ? err.statusCode : (err?.type === 'entity.too.large' ? 413 : 500);
    if (status === 413) return res.status(413).json({ ok: false, error: 'Tệp quá 8 MB.' });
    if (status !== 500) return res.status(status).json({ ok: false, error: err.message });
    console.error('[dashboard]', err?.message || err);
    return res.status(500).json({ ok: false, error: fallback });
  };
  const log = (req, action, detail) => { try { activity.append({ actor: req.user.username, action, detail }); } catch (e) { console.error('[dashboard] không ghi được Nhật ký:', e); } };
  const strip = ({ ok, ...rest }) => rest;
  const changed = (req, action, name, detail = name) => { restartFlags.mark('assistant', `Skill: ${name}`); log(req, action, detail); };

  r.get('/admin/skills', ...guard, async (req, res) => {
    try {
      const out = strip(await hermesAdmin.read('skills.list'));
      if (memberSkills && Array.isArray(out.skills)) {
        const open = new Set(memberSkills.list());
        out.skills = out.skills.map((s) => ({ ...s, member: open.has(s.name), memberBlocked: isBlocked(s.name) }));
      }
      res.json({ ok: true, ...out });
    } catch (err) { fail(res, err, 'Chưa đọc được danh sách skill.'); }
  });
  /** Mở/đóng một skill cho thành viên (không phải chủ nhân) — plugin đọc lại ngay, không cần khởi động lại. */
  r.put('/admin/skills/member', ...guard, (req, res) => {
    if (!memberSkills) return res.status(404).json({ ok: false, error: 'Bản cài này chưa hỗ trợ skill cho thành viên.' });
    const { name, allowed } = req.body || {};
    if (typeof name !== 'string' || !SKILL_NAME.test(name.trim()) || typeof allowed !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'Tên skill hoặc giá trị không hợp lệ.' });
    }
    try {
      const out = memberSkills.set(name, allowed);
      log(req, allowed ? 'skill_member_on' : 'skill_member_off', out.name);
      res.json({ ok: true, ...out });
    } catch (err) { fail(res, err, 'Chưa lưu được.'); }
  });
  r.get('/admin/skills/view', ...guard, async (req, res) => {
    try { res.json({ ok: true, ...strip(await hermesAdmin.read('skills.view', { name: String(req.query.name ?? '') })) }); } catch (err) { fail(res, err, 'Chưa đọc được skill.'); }
  });
  r.put('/admin/skills/toggle', ...guard, async (req, res) => {
    try {
      const { name, enabled, everywhere } = req.body || {};
      const out = await hermesAdmin.write('skills.toggle', { name, enabled, everywhere: everywhere === true });
      log(req, enabled ? 'skill_enable' : 'skill_disable', out.name);
      res.json({ ok: true, ...strip(out) });
    } catch (err) { fail(res, err, 'Chưa đổi được trạng thái skill.'); }
  });
  /** Bật/tắt nhiều skill: `{ names: [...], enabled, everywhere }` — kiểm tên trước, chạy lần lượt, trả `{ done, failed }`. */
  r.put('/admin/skills/toggle-many', ...guard, async (req, res) => {
    const { names, enabled, everywhere } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ ok: false, error: 'Giá trị bật/tắt không hợp lệ.' });
    if (!Array.isArray(names) || !names.length || names.length > MAX_BULK_SKILLS) return res.status(400).json({ ok: false, error: `Chọn từ 1 đến ${MAX_BULK_SKILLS} skill.` });
    const list = [...new Set(names.map((n) => (typeof n === 'string' ? n.trim() : '')))];
    if (!list.every((n) => SKILL_NAME.test(n))) return res.status(400).json({ ok: false, error: 'Tên skill không hợp lệ.' });
    const done = []; const failed = [];
    for (const name of list) {
      try { const out = await hermesAdmin.write('skills.toggle', { name, enabled, everywhere: everywhere === true }); done.push(out.name); } catch (err) {
        const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
        if (status === 500) console.error('[dashboard]', err?.message || err);
        failed.push({ name, error: status === 500 ? 'Chưa đổi được trạng thái skill.' : err.message });
      }
    }
    if (done.length) log(req, enabled ? 'skill_enable' : 'skill_disable', `${done.length} skill: ${done.join(', ').slice(0, 300)}`);
    res.json({ ok: true, enabled, done, failed });
  });
  r.post('/admin/skills/uninstall', ...guard, async (req, res) => {
    try {
      const out = await hermesAdmin.write('skills.uninstall', { name: req.body?.name });
      changed(req, 'skill_uninstall', out.name);
      res.json({ ok: true, ...strip(out) });
    } catch (err) { fail(res, err, 'Chưa gỡ được skill.'); }
  });
  r.post('/admin/skills/upload', ...guard, express.raw({ type: 'application/octet-stream', limit: MAX_SKILL_UPLOAD }), async (req, res) => {
    let dir = '';
    try {
      let filename = '';
      try { filename = decodeURIComponent(String(req.get('x-file-name') || '')); } catch { /* để trống */ }
      if (!/\.(zip|md)$/i.test(filename)) return res.status(400).json({ ok: false, error: 'Chỉ nhận tệp .zip hoặc SKILL.md.' });
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ ok: false, error: 'Chưa nhận được tệp — chọn lại tệp.' });
      dir = mkdtempSync(join(tmpdir(), 'zalo-skill-'));
      const path = join(dir, /\.md$/i.test(filename) ? 'SKILL.md' : 'skill.zip');
      writeFileSync(path, req.body);
      const out = await hermesAdmin.write('skills.upload', { path, filename });
      if (out.installed) changed(req, 'skill_upload', out.name);
      res.json({ ok: true, ...strip(out) });
    } catch (err) { fail(res, err, 'Chưa cài được skill tải lên.'); } finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
  });

  r.get('/admin/skills/hub/official', ...guard, async (req, res) => {
    try { res.json({ ok: true, ...strip(await hermesAdmin.read('hub.official')) }); } catch (err) { fail(res, err, 'Chưa đọc được danh mục skill.'); }
  });
  r.get('/admin/skills/hub/search', ...guard, async (req, res) => {
    try { res.json({ ok: true, ...strip(await hermesAdmin.read('hub.search', { q: String(req.query.q ?? '').slice(0, 100) })) }); } catch (err) { fail(res, err, 'Chưa tìm được trên kho skill — thử lại.'); }
  });
  r.get('/admin/skills/hub/preview', ...guard, async (req, res) => {
    try { res.json({ ok: true, ...strip(await hermesAdmin.read('hub.preview', { identifier: String(req.query.id ?? ''), source: String(req.query.source ?? '') })) }); } catch (err) { fail(res, err, 'Chưa xem được skill này.'); }
  });
  r.get('/admin/skills/hub/scan', ...guard, async (req, res) => {
    try { res.json({ ok: true, ...strip(await hermesAdmin.write('hub.scan', { identifier: String(req.query.id ?? ''), source: String(req.query.source ?? '') }, { timeoutMs: 120_000 })) }); } catch (err) { fail(res, err, 'Chưa quét được skill này.'); }
  });
  r.post('/admin/skills/hub/install', ...guard, async (req, res) => {
    try {
      const out = await hermesAdmin.write('hub.install', { identifier: String(req.body?.identifier ?? ''), source: String(req.body?.source ?? '') });
      changed(req, 'skill_install', out.name, `${out.name} (${out.identifier})`);
      res.json({ ok: true, ...strip(out) });
    } catch (err) { fail(res, err, 'Chưa cài được skill.'); }
  });
  return r;
}
