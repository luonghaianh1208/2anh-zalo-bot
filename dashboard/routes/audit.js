import express from 'express';
import { requireAuth, requireRole } from '../lib/http-guards.js';
import { createAuditFeed } from '../lib/audit-feed.js';
import { failStore } from '../lib/route-errors.js';

/** Mốc dọn được chọn trên trang Nhật ký: xoá dòng cũ hơn N ngày; 0 = xoá hết. */
export const CLEAR_DAYS = [0, 7, 30, 90];
const DAY_MS = 24 * 60 * 60 * 1000;

export function auditRoutes({ store, activity, threadNames, users, auditCleaner = null, now = Date.now }) {
  const r = express.Router();
  /** Dọn Nhật ký — chỉ Quản trị: xoá cả dòng của bot (SQLite) lẫn của dashboard, rồi ghi lại một dòng "đã dọn". */
  r.post('/admin/audit/clear', requireAuth, requireRole('admin'), (req, res) => {
    const days = req.body?.days;
    if (!CLEAR_DAYS.includes(days)) return res.status(400).json({ ok: false, error: 'Mốc dọn không hợp lệ — tải lại trang rồi thử lại.' });
    const before = days ? now() - days * DAY_MS : now() + 1;
    try {
      const bot = auditCleaner ? auditCleaner.clearBefore(before) : 0;
      const dashboard = activity.prune(before);
      activity.append({ actor: req.user.username, action: 'audit_clear', detail: `${days ? `cũ hơn ${days} ngày` : 'tất cả'}: ${bot + dashboard} dòng` });
      res.json({ ok: true, removed: bot + dashboard, bot, dashboard });
    } catch (err) { failStore(res, err, 'Chưa dọn được nhật ký — thử lại sau ít phút.'); }
  });
  const feed = createAuditFeed({ store, activity, threadNames, isUser: (name) => Boolean(users.get(String(name))) });
  r.get('/audit', requireAuth, async (req, res) => {
    const status = req.query.status ?? '';
    const before = req.query.before ?? '';
    const source = req.query.source ?? 'all';
    if (status !== '' && status !== 'failed') return res.status(400).json({ ok: false, error: 'Bộ lọc không hợp lệ — tải lại trang rồi thử lại.' });
    if (!['all', 'zalo', 'dashboard'].includes(source)) return res.status(400).json({ ok: false, error: 'Bộ lọc không hợp lệ — tải lại trang rồi thử lại.' });
    if (before !== '' && !(typeof before === 'string' && /^\d{1,16}$/.test(before))) {
      return res.status(400).json({ ok: false, error: 'Vị trí trang không hợp lệ — tải lại trang rồi thử lại.' });
    }
    try {
      res.json({ ok: true, ...(await feed.list({
        role: req.user.role,
        beforeMs: before ? Number(before) : Number.MAX_SAFE_INTEGER,
        failedOnly: status === 'failed',
        source,
      })) });
    } catch (err) { failStore(res, err, 'Chưa đọc được nhật ký — tải lại trang, nếu vẫn lỗi hãy báo người cài đặt.'); }
  });
  return r;
}
