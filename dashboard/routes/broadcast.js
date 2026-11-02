// Gửi hàng loạt — cả hai vai trò. Bot tự chạy nền và ghi audit_log từng tin; route này lo danh sách người nhận
// và ghi Nhật ký ai bắt đầu/dừng đợt nào. Chỉ nhận nơi có trong danh sách (nhóm của bot, bạn bè, người từng nhắn
// riêng, người trong sổ hoặc thư mục): trình duyệt không tự thêm được một UID lạ để nhắn cho người không quen.
import express from 'express';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireAuth } from '../lib/http-guards.js';
import { mergeContacts } from '../lib/contacts.js';
import { failSidecar } from '../lib/route-errors.js';
import { MAX_SEND_FILE, SEND_FILE_TYPES, safeSendName } from './chats.js';

const FILE_ID = /^[a-f0-9]{16}$/;
const JOB_ID = /^bc-[a-z0-9-]{1,40}$/;
const ACTIONS = { pause: 'broadcast_pause', resume: 'broadcast_resume', cancel: 'broadcast_cancel' };
const PENDING_MAX_MS = 24 * 3600_000;

/** Thư mục tệp đã tải lên nhưng chưa bắt đầu đợt: bỏ dở quá một ngày thì dọn. */
function sweepPending(dir, now) {
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    const path = join(dir, name);
    try { if (now - statSync(path).mtimeMs > PENDING_MAX_MS) rmSync(path, { recursive: true, force: true }); } catch { /* đã bị xoá */ }
  }
}

export function broadcastRoutes({ sidecar, store, people, permissions, activity, outboxDir = null, now = Date.now }) {
  const r = express.Router();
  const bad = (res, error) => res.status(400).json({ ok: false, error });
  const log = (req, action, detail) => {
    try { activity.append({ actor: req.user.username, action, detail }); } catch (err) { console.error('[dashboard] không ghi được Nhật ký gửi hàng loạt:', err); }
  };

  async function book() {
    const errors = {};
    let friends = [];
    try { friends = await sidecar.friends(); } catch { errors.friends = 'Chưa lấy được danh sách bạn bè từ Zalo.'; }
    let liveGroups = null;
    try { liveGroups = await sidecar.groups(); } catch { errors.groups = 'Chưa lấy được danh sách nhóm từ Zalo — tạm dùng nhóm trong lịch sử.'; }
    let convs = [];
    try { if (store.available()) convs = store.listConversations(); } catch { errors.history = 'Chưa đọc được lịch sử trò chuyện.'; }
    let profiles = [];
    try { profiles = people ? people.list() : []; } catch { errors.people = 'Sổ người quen đang hỏng — xem trang Trí nhớ.'; }
    const folders = permissions.get().folders || [];

    let self = '';
    try { self = String(store.selfUid?.() || ''); } catch { /* chưa có lịch sử */ }
    const dmPeers = convs.filter((c) => c.threadType === 0).map((c) => ({ uid: c.threadId, name: c.peerName, lastAtMs: c.lastAtMs }));
    const inFolders = folders.flatMap((f) => f.people || []);
    const contacts = mergeContacts({ friends, dmPeers, people: [...profiles, ...inFolders] }).filter((c) => c.uid !== self);
    // Tên thật hoặc rỗng, không dùng tên dự phòng "Nhóm 123": tên này được chèn vào nội dung gửi đi.
    const groupRows = liveGroups
      ? liveGroups.map((g) => ({ id: String(g.id), name: String(g.name || '').trim() }))
      : convs.filter((c) => c.threadType === 1).map((c) => ({ id: c.threadId, name: '' }));
    const groups = groupRows.map((g) => ({ ...g, name: g.name === g.id ? '' : g.name }));
    return { groups, contacts, folders, errors };
  }

  r.get('/broadcasts/recipients', requireAuth, async (req, res) => {
    try {
      const { groups, contacts, folders, errors } = await book();
      const known = { groups: new Set(groups.map((g) => g.id)), people: new Set(contacts.map((c) => c.uid)) };
      res.json({
        ok: true, errors, groups,
        people: contacts.map((c) => ({ uid: c.uid, name: c.name, friend: c.friend })),
        folders: folders.map((f) => ({
          id: f.id, name: f.name, color: f.color,
          groups: (f.groups || []).filter((id) => known.groups.has(id)),
          people: (f.people || []).map((p) => p.uid).filter((uid) => known.people.has(uid)),
        })),
      });
    } catch (err) {
      console.error('[dashboard]', err);
      res.status(500).json({ ok: false, error: 'Chưa đọc được danh sách người nhận — tải lại trang rồi thử lại.' });
    }
  });

  r.get('/broadcasts', requireAuth, async (req, res) => {
    try { res.json({ ok: true, ...(await sidecar.broadcasts()) }); } catch (err) { failSidecar(res, err); }
  });

  // Tệp đính kèm tải lên trước (thân nhị phân, X-File-Name); đợt gửi nhận lại bằng fileId.
  r.post('/broadcasts/file', requireAuth, express.raw({ type: 'application/octet-stream', limit: MAX_SEND_FILE }), (req, res) => {
    if (!outboxDir) return res.status(503).json({ ok: false, error: 'Máy này chưa bật gửi tệp từ dashboard.' });
    let raw = '';
    try { raw = decodeURIComponent(String(req.get('x-file-name') || '')); } catch { /* tên hỏng */ }
    const name = safeSendName(raw);
    if (!name) return bad(res, `Chỉ gửi được ảnh, tài liệu, tệp nén, âm thanh, video (${SEND_FILE_TYPES.join(', ')}).`);
    if (!Buffer.isBuffer(req.body) || !req.body.length) return bad(res, 'Chưa nhận được tệp — chọn lại tệp.');
    const pending = join(outboxDir, 'broadcast-pending');
    sweepPending(pending, now());
    const fileId = randomBytes(8).toString('hex');
    try {
      mkdirSync(join(pending, fileId), { recursive: true });
      writeFileSync(join(pending, fileId, name), req.body, { mode: 0o600 });
      res.json({ ok: true, fileId, name });
    } catch (err) {
      console.error('[dashboard]', err);
      res.status(500).json({ ok: false, error: 'Chưa lưu được tệp — thử lại.' });
    }
  });

  r.post('/broadcasts', requireAuth, async (req, res) => {
    const { text, targets, pace, fileId } = req.body || {};
    if (!Array.isArray(targets) || !targets.length) return bad(res, 'Chưa chọn nơi nhận.');
    if (fileId != null && !FILE_ID.test(String(fileId))) return bad(res, 'Tệp đính kèm không hợp lệ — chọn lại tệp.');
    let info;
    try { info = await book(); } catch (err) { return failSidecar(res, err); }
    const names = new Map([
      ...info.groups.map((g) => [`1:${g.id}`, g.name]),
      ...info.contacts.map((c) => [`0:${c.uid}`, c.name]),
    ]);
    const key = (t) => `${t?.type}:${t?.id}`;
    const unknown = targets.filter((t) => !names.has(key(t)));
    if (unknown.length) return bad(res, `${unknown.length} nơi nhận không còn trong danh sách — tải lại trang rồi chọn lại.`);

    let file = null;
    let fileDir = null;
    if (fileId) {
      if (!outboxDir) return res.status(503).json({ ok: false, error: 'Máy này chưa bật gửi tệp từ dashboard.' });
      const from = join(outboxDir, 'broadcast-pending', fileId);
      try {
        const [name] = readdirSync(from);
        if (!name) throw new Error('rỗng');
        fileDir = join(outboxDir, 'broadcast', fileId);
        mkdirSync(join(outboxDir, 'broadcast'), { recursive: true });
        renameSync(from, fileDir);
        file = { path: join(fileDir, name), name };
      } catch { return bad(res, 'Không còn tệp đính kèm — chọn lại tệp.'); }
    }
    try {
      const job = await sidecar.createBroadcast({
        text, pace, file, actor: req.user.username,
        targets: targets.map((t) => ({ id: String(t.id), type: t.type, name: names.get(key(t)) })),
      });
      log(req, 'broadcast_create', `${job.counts.total} nơi nhận${file ? ', có tệp đính kèm' : ''}`);
      res.json({ ok: true, job });
    } catch (err) {
      // Quá hạn chờ thì bot có thể đã nhận đợt này và đang dùng tệp: không được xoá.
      if (fileDir && err?.name !== 'SidecarTimeout') rmSync(fileDir, { recursive: true, force: true });
      failSidecar(res, err);
    }
  });

  r.post('/broadcasts/:id/:action', requireAuth, async (req, res) => {
    const { id, action } = req.params;
    if (!JOB_ID.test(id) || !ACTIONS[action]) return bad(res, 'Thao tác không hợp lệ — tải lại trang rồi thử lại.');
    try {
      const job = await sidecar.broadcastAction(id, action);
      log(req, ACTIONS[action], `${job.counts.sent}/${job.counts.total} nơi đã gửi`);
      res.json({ ok: true, job });
    } catch (err) { failSidecar(res, err); }
  });

  return r;
}
