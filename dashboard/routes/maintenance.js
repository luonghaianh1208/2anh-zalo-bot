// Bảo trì — chỉ Quản trị. Cập nhật: phiên bản bot/Hermes, kiểm tra và chạy cập nhật Hermes.
// Sao lưu: bản sao lưu cài đặt (.zip: config, .env, SOUL, trí nhớ, skill, dữ liệu Zalo, lịch) — tạo, tải về, khôi
// phục (từ bản trên máy hoặc tệp tải lên), xoá; điểm khôi phục nhanh của Hermes — tạo, khôi phục.
// Khôi phục luôn tạo một bản sao lưu hiện trạng trước, rồi cần khởi động lại trợ lý.
import express from 'express';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireAuth, requireRole } from '../lib/http-guards.js';

export const MAX_RESTORE_UPLOAD = 300 * 1024 * 1024;

export function maintenanceRoutes({ maintenance, hermesAdmin, restartFlags, activity }) {
  const r = express.Router();
  const guard = [requireAuth, requireRole('admin')];
  const fail = (res, err, fallback) => {
    const status = Number.isInteger(err?.statusCode) ? err.statusCode : (err?.type === 'entity.too.large' ? 413 : 500);
    if (status === 413) return res.status(413).json({ ok: false, error: 'Tệp quá 300 MB.' });
    if (status !== 500) return res.status(status).json({ ok: false, error: err.message });
    console.error('[dashboard]', err?.message || err);
    return res.status(500).json({ ok: false, error: fallback });
  };
  const log = (req, action, detail) => { try { activity.append({ actor: req.user.username, action, detail }); } catch (e) { console.error('[dashboard] không ghi được Nhật ký:', e); } };
  const strip = ({ ok, ...rest }) => rest;
  const dir = () => maintenance.backupDir;
  const snapshots = async () => { try { return (await hermesAdmin.read('snapshot.list')).snapshots; } catch { return null; } };

  r.get('/admin/maintenance', ...guard, async (req, res) => {
    try { res.json({ ok: true, ...(await maintenance.versions()), backups: maintenance.backups(), snapshots: hermesAdmin ? await snapshots() : null }); } catch (err) { fail(res, err, 'Chưa đọc được thông tin bảo trì.'); }
  });
  r.post('/admin/maintenance/hermes-check', ...guard, async (req, res) => {
    try { res.json({ ok: true, check: await maintenance.checkHermes() }); } catch (err) { fail(res, err, 'Chưa kiểm tra được bản Hermes mới.'); }
  });
  r.get('/admin/maintenance/hermes-update', ...guard, (req, res) => {
    try { res.json({ ok: true, update: maintenance.updateState() }); } catch (err) { fail(res, err, 'Chưa đọc được tiến độ cập nhật.'); }
  });
  r.post('/admin/maintenance/hermes-update', ...guard, async (req, res) => {
    try { const update = await maintenance.updateHermes(); log(req, 'hermes_update', 'hermes update --yes --backup'); res.json({ ok: true, update }); } catch (err) { fail(res, err, 'Chưa chạy được cập nhật Hermes.'); }
  });

  // Cập nhật bot: ai đăng nhập cũng thấy "có bản mới" (thanh trạng thái), chỉ Quản trị bấm cập nhật được.
  r.get('/update-notice', requireAuth, async (req, res) => {
    try { res.json({ ok: true, ...(await maintenance.botNotice()) }); } catch (err) { fail(res, err, 'Chưa kiểm tra được bản mới.'); }
  });
  r.get('/admin/maintenance/bot-update', ...guard, (req, res) => {
    try { res.json({ ok: true, botUpdate: maintenance.botUpdateState() }); } catch (err) { fail(res, err, 'Chưa đọc được tiến độ cập nhật.'); }
  });
  r.post('/admin/maintenance/bot-update', ...guard, async (req, res) => {
    try {
      const to = String(req.body?.to ?? '');
      const botUpdate = await maintenance.updateBot(to);
      log(req, 'bot_update', `${botUpdate.from} → ${to}`);
      res.json({ ok: true, botUpdate });
    } catch (err) { fail(res, err, 'Chưa chạy được cập nhật bot.'); }
  });

  if (!hermesAdmin) return r;
  const restored = (req, action, detail) => { restartFlags.mark('assistant', `Khôi phục: ${detail}`); log(req, action, detail); };

  r.post('/admin/backups', ...guard, async (req, res) => {
    try { const out = await hermesAdmin.write('backup.create', { dir: dir() }, { timeoutMs: 600_000 }); log(req, 'backup_create', out.file); res.json({ ok: true, ...strip(out), backups: maintenance.backups() }); } catch (err) { fail(res, err, 'Chưa tạo được bản sao lưu.'); }
  });
  r.get('/admin/backups/:file', ...guard, (req, res) => {
    try { const p = maintenance.backupPath(req.params.file); log(req, 'backup_download', req.params.file); res.download(p, req.params.file, { dotfiles: 'allow' }); } catch (err) { fail(res, err, 'Chưa tải được bản sao lưu.'); }
  });
  r.post('/admin/backups/:file/remove', ...guard, (req, res) => {
    try { rmSync(maintenance.backupPath(req.params.file), { force: true }); log(req, 'backup_remove', req.params.file); res.json({ ok: true, backups: maintenance.backups() }); } catch (err) { fail(res, err, 'Chưa xoá được bản sao lưu.'); }
  });
  r.post('/admin/backups/:file/restore', ...guard, async (req, res) => {
    try {
      const out = await hermesAdmin.write('backup.restore', { dir: dir(), path: maintenance.backupPath(req.params.file) }, { timeoutMs: 600_000 });
      restored(req, 'backup_restore', req.params.file);
      res.json({ ok: true, ...strip(out), backups: maintenance.backups() });
    } catch (err) { fail(res, err, 'Chưa khôi phục được.'); }
  });
  r.post('/admin/backups-upload/restore', ...guard, express.raw({ type: 'application/octet-stream', limit: MAX_RESTORE_UPLOAD }), async (req, res) => {
    let tmp = '';
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ ok: false, error: 'Chưa nhận được tệp — chọn lại tệp.' });
      tmp = mkdtempSync(join(tmpdir(), 'zalo-restore-'));
      const path = join(tmp, 'backup.zip');
      writeFileSync(path, req.body);
      const out = await hermesAdmin.write('backup.restore', { dir: dir(), path }, { timeoutMs: 600_000 });
      restored(req, 'backup_restore', 'tệp tải lên');
      res.json({ ok: true, ...strip(out), backups: maintenance.backups() });
    } catch (err) { fail(res, err, 'Chưa khôi phục được.'); } finally { if (tmp) rmSync(tmp, { recursive: true, force: true }); }
  });

  r.post('/admin/snapshots', ...guard, async (req, res) => {
    try { const out = await hermesAdmin.write('snapshot.create', { label: 'dashboard' }, { timeoutMs: 600_000 }); log(req, 'snapshot_create', out.id); res.json({ ok: true, ...strip(out), snapshots: await snapshots() }); } catch (err) { fail(res, err, 'Chưa tạo được điểm khôi phục.'); }
  });
  r.post('/admin/snapshots/:id/restore', ...guard, async (req, res) => {
    try { const out = await hermesAdmin.write('snapshot.restore', { id: req.params.id }, { timeoutMs: 600_000 }); restored(req, 'snapshot_restore', out.id); res.json({ ok: true, ...strip(out) }); } catch (err) { fail(res, err, 'Chưa khôi phục được điểm này.'); }
  });
  return r;
}
