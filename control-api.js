/**
 * Route /control/* cho dashboard. Luôn đòi ZALO_BRIDGE_TOKEN — nghe 127.0.0.1
 * không phải là xác thực: mọi tiến trình trên máy đều gọi được.
 * Một token cho cả cầu nối Hermes lẫn dashboard: một bí mật, một chỗ thu hồi.
 */
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const ZALO_UID = /^[1-9]\d{14,21}$/;
const MAX_TEXT = 2000;
const MAX_ACTOR = 64;
const DIGITS = /^\d{1,40}$/;
const MAX_MENTIONS = 30;

/** Trích dẫn khi trả lời từ dashboard: chỉ tin chữ (dashboard đã tra từ kho tin). */
export function checkQuote(q, bad) {
  if (q == null) return null;
  if (typeof q !== 'object') throw bad('Trích dẫn không hợp lệ');
  const out = { msgId: String(q.msgId ?? ''), cliMsgId: String(q.cliMsgId ?? ''), uidFrom: String(q.uidFrom ?? ''), content: String(q.content ?? '').slice(0, 2000), ts: Number(q.ts), isSelf: q.isSelf === true };
  if (!DIGITS.test(out.msgId) || (out.cliMsgId && !DIGITS.test(out.cliMsgId)) || (!out.isSelf && !DIGITS.test(out.uidFrom)) || !Number.isFinite(out.ts)) throw bad('Trích dẫn không hợp lệ');
  return out;
}

/** Gắn tag: mỗi mục trỏ đúng một đoạn "@…" trong nội dung; chỉ ở nhóm. */
export function checkMentions(list, text, threadType, bad) {
  if (list == null || (Array.isArray(list) && !list.length)) return null;
  if (!Array.isArray(list) || list.length > MAX_MENTIONS || threadType !== 1) throw bad('Gắn tag không hợp lệ');
  return list.map((m) => {
    const pos = Number(m?.pos); const len = Number(m?.len); const uid = String(m?.uid ?? '');
    if (!DIGITS.test(uid) || !Number.isInteger(pos) || !Number.isInteger(len) || pos < 0 || len < 2 || len > 100 || pos + len > text.length || text[pos] !== '@') throw bad('Gắn tag không hợp lệ');
    return { uid, pos, len };
  });
}

function tokenOk(header, expected) {
  const supplied = Buffer.from(String(header || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(String(expected || ''));
  return want.length > 0 && supplied.length === want.length && timingSafeEqual(supplied, want);
}

export function createControlRouter({ token, health, qr, logout, send, loginCode, groups, groupMembers = null, recall = null, sendFile = null, outboxDir = null, directory = null, broadcasts = null }) {
  const router = express.Router();
  router.use((req, res, next) => (tokenOk(req.get('authorization'), token)
    ? next() : res.status(401).json({ ok: false, error: 'unauthorized' })));

  const wrap = (fn) => async (req, res) => {
    try { res.json({ ok: true, ...(await fn(req)) }); } catch (err) {
      const status = err.validation ? 400 : 502;
      res.status(status).json({ ok: false, error: String(err?.message || err) });
    }
  };
  const bad = (message) => Object.assign(new Error(message), { validation: true });

  const checkActor = (actor) => {
    const who = typeof actor === 'string' ? actor.trim() : '';
    if (!who || who.length > MAX_ACTOR) throw bad(`Thiếu người gửi hoặc dài quá ${MAX_ACTOR} ký tự`);
    return who;
  };

  /** Đường dẫn thật của tệp nằm trong outbox; `rel` để kiểm thêm vị trí bên trong. Ngoài outbox → lỗi. */
  const inOutbox = (path) => {
    let real;
    try { real = realpathSync(String(path ?? '')); } catch { throw bad('Không thấy tệp cần gửi'); }
    const root = (() => { try { return realpathSync(outboxDir); } catch { return resolve(outboxDir); } })();
    const rel = relative(root, real);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw bad('Tệp không nằm trong thư mục gửi của dashboard');
    return { real, rel };
  };

  router.get('/health', wrap(async () => ({ health: health() })));
  router.post('/qr/start', wrap(async () => { await qr.start(); return {}; }));
  // Phiên bị Zalo đá vẫn mang nhãn logged-in: không bao giờ báo "đã đăng nhập" cho nó,
  // nếu không trang QR tưởng thành công rồi chuyển đi trong khi bot đã điếc.
  router.get('/qr', wrap(async () => {
    const state = await qr.state();
    if (state?.status === 'logged-in' && health()?.zalo?.needsRelogin) return { status: 'idle', image: null, user: null };
    return state;
  }));
  router.post('/logout', wrap(async () => { await logout(); return {}; }));
  router.post('/send', wrap(async (req) => {
    const { threadId, threadType, text, actor, quote, mentions } = req.body || {};
    const body = String(text ?? '').trim();
    if (!/^\d+$/.test(String(threadId ?? ''))) throw bad('threadId không hợp lệ');
    if (threadType !== 0 && threadType !== 1) throw bad('threadType phải là 0 hoặc 1');
    if (!body || body.length > MAX_TEXT) throw bad(`Nội dung trống hoặc quá ${MAX_TEXT} ký tự`);
    const who = checkActor(actor);
    // Vị trí tag tính trên nội dung đã cắt khoảng trắng — dashboard phải gửi đúng bản đó, không thì lệch vị trí.
    if (mentions?.length && String(text) !== body) throw bad('Nội dung có tag phải được cắt khoảng trắng hai đầu trước khi gửi');
    const q = checkQuote(quote, bad);
    const tags = checkMentions(mentions, body, threadType, bad);
    return { result: await send({ threadId: String(threadId), threadType, text: body, actor: who, ...(q ? { quote: q } : {}), ...(tags ? { mentions: tags } : {}) }) };
  }));
  router.post('/login-code', wrap(async (req) => {
    const { zaloUid, code, actor } = req.body || {};
    if (!ZALO_UID.test(String(zaloUid ?? ''))) throw bad('UID Zalo không hợp lệ');
    if (!/^\d{6}$/.test(String(code ?? ''))) throw bad('Mã phải gồm đúng 6 chữ số');
    await loginCode({ zaloUid: String(zaloUid), code: String(code), actor: checkActor(actor) });
    return {};
  }));
  router.get('/groups', wrap(async () => ({ groups: await groups() })));
  // Gửi ảnh/tệp từ Phiên chat: chỉ nhận tệp nằm trong thư mục tạm của dashboard (outboxDir) — không bao giờ gửi
  // một đường dẫn tuỳ ý trên máy chủ ra Zalo.
  if (sendFile && outboxDir) {
    router.post('/send-file', wrap(async (req) => {
      const { threadId, threadType, path, actor } = req.body || {};
      if (!/^\d+$/.test(String(threadId ?? ''))) throw bad('threadId không hợp lệ');
      if (threadType !== 0 && threadType !== 1) throw bad('threadType phải là 0 hoặc 1');
      return { result: await sendFile({ threadId: String(threadId), threadType, path: inOutbox(path).real, actor: checkActor(actor) }) };
    }));
  }
  // Thu hồi tin do chính bot gửi (bấm từ Phiên chat). Bot tự kiểm đúng là tin của mình.
  if (recall) {
    router.post('/recall', wrap(async (req) => {
      const { threadId, threadType, msgId, cliMsgId, actor } = req.body || {};
      if (!/^\d+$/.test(String(threadId ?? ''))) throw bad('threadId không hợp lệ');
      if (threadType !== 0 && threadType !== 1) throw bad('threadType phải là 0 hoặc 1');
      if (!DIGITS.test(String(msgId ?? '')) || !DIGITS.test(String(cliMsgId ?? ''))) throw bad('Tin này thiếu mã Zalo — không thu hồi được');
      return { result: await recall({ threadId: String(threadId), threadType, msgId: String(msgId), cliMsgId: String(cliMsgId), actor: checkActor(actor) }) };
    }));
  }
  if (groupMembers) {
    router.get('/group-members', wrap(async (req) => {
      const groupId = String(req.query.groupId ?? '');
      if (!/^\d+$/.test(groupId)) throw bad('groupId không hợp lệ');
      return groupMembers(groupId);
    }));
  }

  // Gửi hàng loạt: bot tự chạy nền theo nhịp đã chọn. Tệp đính kèm nằm trong outbox/broadcast/<mã>/ và bị xoá khi đợt
  // kết thúc, nên chỉ nhận đúng dạng đó — xoá cả thư mục chứa tệp không được đụng tới thứ khác.
  if (broadcasts) {
    router.get('/broadcasts', wrap(async () => broadcasts.list()));
    router.post('/broadcasts', wrap(async (req) => {
      const { text, targets, pace, file, actor } = req.body || {};
      const who = checkActor(actor);
      let attached = null;
      if (file) {
        if (!outboxDir) throw bad('Máy này chưa bật gửi tệp từ dashboard');
        const { real, rel } = inOutbox(file.path);
        const parts = rel.split(sep);
        if (parts.length !== 3 || parts[0] !== 'broadcast') throw bad('Tệp đính kèm không đúng chỗ');
        attached = { path: real, name: String(file.name ?? '').slice(0, 120) };
      }
      return { job: broadcasts.create({ text, file: attached, targets: Array.isArray(targets) ? targets : [], pace, actor: who }) };
    }));
    router.post('/broadcasts/:id/:action', wrap(async (req) => {
      const { id, action } = req.params;
      if (!['pause', 'resume', 'cancel'].includes(action)) throw bad('Thao tác không hợp lệ');
      return { job: broadcasts[action](id) };
    }));
  }

  // Liên hệ và Lịch hẹn (spec §18.4): đọc bạn bè/lời mời/lời nhắc; ghi luôn đòi actor để audit_log có tên người làm.
  if (directory) {
    router.get('/friends', wrap(async (req) => ({ friends: await directory.friends({ fresh: req.query.fresh === '1' }) })));
    router.get('/friend-requests', wrap(async () => ({ requests: await directory.friendRequests() })));
    router.post('/friend-requests/answer', wrap(async (req) => {
      const { uid, accept, actor } = req.body || {};
      return directory.answerFriendRequest({ uid: String(uid ?? ''), accept, actor: checkActor(actor) });
    }));
    router.get('/reminders', wrap(async (req) => ({
      reminders: await directory.reminders({ threadId: String(req.query.threadId ?? ''), threadType: Number(req.query.threadType) }),
    })));
    // Phiên chat kiểu Zalo: đầu khung + bảng Thông tin, ảnh đại diện người gửi, bảng tin nhóm (chỉ đọc).
    router.get('/chat-info', wrap(async (req) => ({
      info: await directory.chatInfo({ threadId: String(req.query.threadId ?? ''), threadType: Number(req.query.threadType) }),
    })));
    router.post('/avatars', wrap(async (req) => {
      const { uids } = req.body || {};
      if (!Array.isArray(uids) || uids.length > 200) throw bad('uids phải là danh sách tối đa 200 UID');
      return { avatars: await directory.avatars(uids.map(String)) };
    }));
    router.post('/group-avatars', wrap(async (req) => {
      const { ids } = req.body || {};
      if (!Array.isArray(ids) || ids.length > 200) throw bad('ids phải là danh sách tối đa 200 nhóm');
      return { avatars: await directory.groupAvatars(ids.map(String)) };
    }));
    router.get('/pinned-threads', wrap(async () => ({ pinned: await directory.pinnedThreads() })));
    router.post('/pin-thread', wrap(async (req) => {
      const { threadId, threadType, pinned, actor } = req.body || {};
      return directory.setPinned({ threadId: String(threadId ?? ''), threadType, pinned, actor: checkActor(actor) });
    }));
    router.get('/board', wrap(async (req) => ({ board: await directory.board({ groupId: String(req.query.groupId ?? '') }) })));
    router.post('/reminders/remove', wrap(async (req) => {
      const { reminderId, threadId, threadType, actor } = req.body || {};
      return directory.removeReminder({ reminderId: String(reminderId ?? ''), threadId: String(threadId ?? ''), threadType, actor: checkActor(actor) });
    }));
  }
  return router;
}
