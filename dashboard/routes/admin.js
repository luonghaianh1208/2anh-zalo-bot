import express from 'express';
import { requireAuth, requireRole } from '../lib/http-guards.js';
import { ZALO_UID, validatePassword, validateZaloUid } from '../lib/users.js';
import { parseOwners } from '../lib/owners.js';

export function adminRoutes({ users, sessions, activity, restartAssistant, restartSidecar, owners, store, restartFlags = null }) {
  const r = express.Router();
  const guard = [requireAuth, requireRole('admin')];
  // Cùng quy ước với routes/zalo.js: chỉ lộ err.message khi lỗi có statusCode 4xx rõ ràng.
  const fail = (res, err, fallback) => {
    const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
    if (status >= 400 && status < 500) return res.status(status).json({ ok: false, error: err.message });
    console.error('[dashboard]', err);
    return res.status(500).json({ ok: false, error: fallback });
  };
  const bad = (m) => Object.assign(new Error(m), { statusCode: 400 });

  r.get('/admin/users', ...guard, (req, res) => res.json({ ok: true, users: users.list() }));

  // Phiên đăng nhập của mọi tài khoản — Quản trị đăng xuất từ xa một thiết bị bất kỳ.
  r.get('/admin/sessions', ...guard, (req, res) => {
    res.json({ ok: true, sessions: sessions.list().map((s) => ({ ...s, current: s.id === req.sessionId })) });
  });
  r.post('/admin/sessions/:id/logout', ...guard, (req, res) => {
    if (req.params.id === req.sessionId) return res.status(400).json({ ok: false, error: 'Đây là thiết bị bạn đang dùng — bấm "Đăng xuất" ở trang Tài khoản nếu muốn thoát.' });
    const gone = sessions.destroyById(req.params.id);
    if (!gone) return res.status(404).json({ ok: false, error: 'Thiết bị này đã đăng xuất hoặc hết phiên — tải lại danh sách.' });
    activity.append({ actor: req.user.username, action: 'session_revoke', detail: `${gone.username} · ${gone.device}` });
    res.json({ ok: true });
  });

  r.post('/admin/users', ...guard, (req, res) => {
    try {
      const u = users.create(req.body || {});
      activity.append({ actor: req.user.username, action: 'user_create', detail: `${u.username} (${u.role})` });
      res.json({ ok: true, user: u });
    } catch (err) { fail(res, err, 'Chưa tạo được tài khoản — thử lại, nếu vẫn lỗi hãy báo người cài đặt.'); }
  });

  r.patch('/admin/users/:username', ...guard, (req, res) => {
    try {
      const target = String(req.params.username || '').trim().toLowerCase();
      const { role, zaloUid, disabled, password } = req.body || {};
      if (disabled !== undefined && typeof disabled !== 'boolean') throw bad('Giá trị khoá tài khoản không hợp lệ — tải lại trang rồi thử lại.');
      if (role !== undefined && role !== 'admin' && role !== 'owner') throw bad('Vai trò phải là Quản trị hoặc Chủ bot — chọn lại vai trò rồi thử lại.');
      if (password !== undefined && password !== '') { if (typeof password !== 'string') throw bad('Mật khẩu không hợp lệ — nhập lại mật khẩu.'); validatePassword(password); }
      if (zaloUid !== undefined) validateZaloUid(zaloUid);
      const locks = disabled === true || role === 'owner';
      if (target === req.user.username && locks) throw bad('Không thể tự khoá/hạ quyền tài khoản đang dùng — nhờ một Quản trị khác thực hiện.');
      const u = users.update(target, { role, zaloUid, disabled });
      if (password) users.setPassword(target, password);
      if (disabled === true || password) sessions.destroyAll(target);
      activity.append({ actor: req.user.username, action: 'user_update', detail: target });
      res.json({ ok: true, user: users.list().find((x) => x.username === target) || u });
    } catch (err) { fail(res, err, 'Chưa cập nhật được tài khoản — thử lại, nếu vẫn lỗi hãy báo người cài đặt.'); }
  });

  // Chủ nhân bot (spec §7.1, §9): tên lấy từ lịch sử tin nhắn (tin riêng trước) và tài khoản dashboard có cùng UID.
  function ownersView() {
    const uids = owners.list();
    let names = new Map();
    try { if (uids.length && store?.available()) names = store.senderNames(uids); } catch (err) {
      console.error('[dashboard] đọc tên chủ nhân lỗi:', err?.message || err);
    }
    const accounts = users.list();
    // .env của thư mục bot ghi đè → kết nối Zalo đang chạy theo danh sách khác. Đặt cờ chờ để dải vàng hiện và vẫn còn
    // sau khi người dùng xoá dòng đó: lúc ấy shadowed() đã là false nhưng kết nối Zalo vẫn cần khởi động lại.
    const over = owners.overrides();
    const shadowed = over.sidecar;
    if (shadowed) {
      try { owners.markPending('shadowed'); } catch (err) { console.error('[dashboard] không đặt được cờ chờ khởi động lại:', err?.message || err); }
    }
    return {
      ok: true,
      owners: uids.map((uid) => ({
        uid, valid: ZALO_UID.test(uid), name: names.get(uid) || '',
        dashboardUsers: accounts.filter((u) => u.zaloUid === uid).map((u) => u.username),
      })),
      pendingRestart: Boolean(owners.pending()),
      shadowed,
      osOverride: over.os,
    };
  }

  r.get('/admin/owners', ...guard, (req, res) => {
    try { res.json(ownersView()); } catch (err) { fail(res, err, 'Chưa đọc được danh sách chủ nhân — tải lại trang, nếu vẫn lỗi hãy báo người cài đặt.'); }
  });

  r.put('/admin/owners', ...guard, (req, res) => {
    try {
      const uids = parseOwners(req.body?.owners);
      const before = owners.list();
      if (owners.set(uids, req.user.username)) {
        const diff = [...uids.filter((u) => !before.includes(u)).map((u) => `+${u}`), ...before.filter((u) => !uids.includes(u)).map((u) => `-${u}`)];
        activity.append({ actor: req.user.username, action: 'owners_update', detail: diff.join(' ') });
      }
      res.json(ownersView());
    } catch (err) { fail(res, err, 'Chưa lưu được danh sách chủ nhân — thử lại, nếu vẫn lỗi hãy báo người cài đặt.'); }
  });

  // Cờ chờ khởi động lại của Agent / Kết nối MCP / Cấu hình (spec §18.6) — dải vàng trên trang Quản trị.
  r.get('/admin/restart-flags', ...guard, (req, res) => {
    try { res.json({ ok: true, ...(restartFlags ? restartFlags.get() : { assistant: null, sidecar: null }), owners: Boolean(owners?.pending()) }); } catch (err) { fail(res, err, 'Chưa đọc được trạng thái — tải lại trang.'); }
  });

  // Khởi động lại trợ lý. Có thay đổi chủ nhân đang chờ thì khởi động lại cả kết nối Zalo trước —
  // nó cũng chỉ đọc ZALO_ALLOWED_USERS lúc khởi động (quyền lệnh chủ nhân, ai được nhận tin báo lỗi).
  r.post('/admin/restart-assistant', ...guard, async (req, res) => {
    try {
      const pendingAtStart = owners?.pending();
      const flags = restartFlags ? restartFlags.get() : { assistant: null, sidecar: null };
      // Kết nối Zalo lỗi không được chặn việc khởi động lại trợ lý: vẫn khởi động trợ lý, giữ cờ chờ, báo thành công một phần.
      let sidecarFailed = false;
      if (pendingAtStart || flags.sidecar) {
        try { await restartSidecar(); } catch (err) {
          sidecarFailed = true;
          console.error('[dashboard] khởi động lại kết nối Zalo lỗi:', err?.message || err);
        }
      }
      await restartAssistant();
      const applied = Boolean(pendingAtStart) && !sidecarFailed;
      // Chỉ xoá cờ nếu kết nối Zalo đã khởi động lại và không có thay đổi mới chen vào (thay đổi đó chưa được áp dụng).
      if (applied && owners.pending()?.since === pendingAtStart.since) owners.clearPending();
      if (flags.sidecar && !sidecarFailed) restartFlags.clear('sidecar', flags.sidecar.rev);
      if (flags.assistant) restartFlags.clear('assistant', flags.assistant.rev);
      const reasons = [...(flags.assistant?.reasons || []), ...(flags.sidecar?.reasons || [])];
      activity.append({ actor: req.user.username, action: 'restart_assistant', detail: [sidecarFailed ? 'kết nối Zalo chưa khởi động lại được' : applied ? 'áp dụng danh sách chủ nhân mới' : '', reasons.join(', ')].filter(Boolean).join(' · ') });
      res.json({
        ok: true, appliedOwners: applied, sidecarFailed,
        ...(sidecarFailed ? { warning: 'Đã khởi động lại trợ lý, nhưng chưa khởi động lại được kết nối Zalo — chạy lại trình cài đặt hoặc đặt ZALO_SIDECAR_RESTART_CMD.' } : {}),
      });
    } catch (err) { fail(res, err, 'Chưa khởi động lại được trợ lý — thử lại sau ít phút, nếu vẫn lỗi hãy báo người cài đặt.'); }
  });
  return r;
}
