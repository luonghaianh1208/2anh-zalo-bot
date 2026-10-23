/**
 * Màn Nhật ký (spec §6, §9): gộp audit_log của bot (đọc SQLite) với activity.jsonl của dashboard.
 * Chủ bot thấy chữ dễ hiểu; Quản trị thấy thêm mã kỹ thuật trong `code`.
 */
import { fallbackName } from './thread-names.js';

export const ACTION_LABELS = {
  // audit_log của bot
  send: 'Bot trả lời tin nhắn',
  sendMessage: 'Bot gửi tin nhắn',
  sendVoice: 'Bot gửi tin thoại',
  sendSticker: 'Bot gửi nhãn dán',
  sendLink: 'Bot gửi liên kết',
  uploadAttachment: 'Bot gửi tệp',
  undo: 'Thu hồi tin của bot',
  send_system_notice: 'Bot gửi thông báo hệ thống',
  dashboard_send: 'Nhắn tay từ dashboard',
  dashboard_login_code: 'Gửi mã đăng nhập dashboard',
  createReminder: 'Tạo lời nhắc',
  removeReminder: 'Xoá lời nhắc',
  createPoll: 'Tạo bình chọn',
  changeGroupName: 'Đổi tên nhóm',
  addUserToGroup: 'Thêm người vào nhóm',
  removeUserFromGroup: 'Mời người ra khỏi nhóm',
  addGroupDeputy: 'Thêm phó nhóm',
  removeGroupDeputy: 'Bỏ phó nhóm',
  // activity.jsonl của dashboard
  login: 'Đăng nhập dashboard',
  logout_all: 'Đăng xuất mọi nơi',
  session_revoke: 'Đăng xuất từ xa một thiết bị',
  audit_clear: 'Dọn nhật ký',
  skill_member_on: 'Mở skill cho thành viên',
  skill_member_off: 'Đóng skill với thành viên',
  setup_admin: 'Tạo tài khoản Quản trị đầu tiên',
  user_create: 'Tạo tài khoản dashboard',
  user_update: 'Sửa tài khoản dashboard',
  restart_assistant: 'Khởi động lại trợ lý',
  zalo_qr_start: 'Mở mã QR đăng nhập Zalo',
  zalo_logout: 'Đăng xuất Zalo',
  telegram_settings: 'Đổi cài đặt Telegram cảnh báo',
  permissions_defaults: 'Đổi phân quyền mặc định',
  permissions_group: 'Đổi phân quyền nhóm',
  permissions_dm: 'Đổi quyền nhắn riêng',
  permissions_studio: 'Đổi hạn mức xưởng tạo sản phẩm',
  brand_update: 'Đổi thương hiệu',
  brand_logo: 'Đổi logo',
  brand_logo_remove: 'Gỡ logo',
  brand_reset: 'Khôi phục thương hiệu mặc định',
  owners_update: 'Đổi chủ nhân bot',
  people_update: 'Sửa sổ người quen',
  people_delete: 'Xoá người khỏi sổ người quen',
  agent_memory_edit: 'Sửa bộ nhớ của trợ lý',
  agent_memory_add: 'Thêm vào bộ nhớ của trợ lý',
  agent_memory_tags: 'Sửa loại thẻ bộ nhớ',
  agent_memory_organize: 'Áp dụng bản AI sắp xếp bộ nhớ',
  agent_memory_organize_undo: 'Hoàn tác sắp xếp bộ nhớ',
  ai_key_set: 'Thay khoá API',
  ai_key_remove: 'Gỡ khoá API',
  ai_key_add: 'Thêm khoá API dự phòng',
  ai_key_activate: 'Chuyển sang khoá API khác',
  ai_key_remove_backup: 'Xoá khoá API dự phòng',
  media_engines: 'Đổi cài đặt tạo ảnh & video',
  media_draw_test: 'Vẽ thử một ảnh',
  agent_memory_delete: 'Xoá mục trong bộ nhớ của trợ lý',
  dashboard_friend_accept: 'Chấp nhận lời mời kết bạn từ dashboard',
  dashboard_friend_reject: 'Từ chối lời mời kết bạn từ dashboard',
  dashboard_reminder_remove: 'Xoá lời nhắc Zalo từ dashboard',
  reminder_remove: 'Xoá nhiều lời nhắc Zalo từ dashboard',
  cron_pause: 'Tạm dừng việc hẹn giờ của trợ lý',
  cron_resume: 'Chạy lại việc hẹn giờ của trợ lý',
  cron_remove: 'Xoá việc hẹn giờ của trợ lý',
  cron_create: 'Tạo lịch hẹn cho trợ lý',
  cron_edit: 'Sửa lịch hẹn của trợ lý',
  kb_upload: 'Tải tài liệu lên kho tri thức',
  kb_delete: 'Xoá tài liệu khỏi kho tri thức',
  kb_note: 'Viết tài liệu mới trong kho tri thức',
  kb_edit: 'Sửa tài liệu trong kho tri thức',
  kb_replace: 'Thay tệp trong kho tri thức',
  kb_source: 'Đổi nguồn kho tri thức',
  kb_folder_create: 'Tạo thư mục tài liệu trong kho tri thức',
  kb_folder_edit: 'Sửa thư mục tài liệu trong kho tri thức',
  kb_folder_delete: 'Xoá thư mục tài liệu trong kho tri thức',
  kb_move: 'Chuyển tài liệu sang thư mục khác trong kho tri thức',
  insight_summary: 'Nhờ AI tóm tắt chủ đề nhóm',
  second_brain_note: 'Thêm ghi chú vào Second brain',
  // Giai đoạn 8 (spec §19.6)
  learned_memory_edit: 'Sửa trí nhớ tự học',
  learned_memory_delete: 'Xoá mục trí nhớ tự học',
  learned_memory_forget: 'Xoá toàn bộ trí nhớ tự học của một nhóm/người',
  learned_memory_settings: 'Đổi chu kỳ rút trí nhớ tự học',
  learned_memory_extract: 'Rút trí nhớ tự học ngay',
  // Giai đoạn 7B (spec §18.6)
  agent_model: 'Đổi model của trợ lý',
  agent_reasoning: 'Đổi mức suy nghĩ của trợ lý',
  agent_soul: 'Sửa tính cách của trợ lý',
  agent_soul_restore: 'Khôi phục tính cách của trợ lý',
  tools_off: 'Bật/tắt công cụ với người ngoài',
  mcp_enable: 'Bật kết nối MCP',
  mcp_disable: 'Tắt kết nối MCP',
  settings_update: 'Đổi cấu hình bot',
  welcome_update: 'Đổi lời chào thành viên mới',
};

const REASONS = {
  operation_failed: 'Zalo từ chối hoặc mạng lỗi',
  zalo_not_logged_in: 'Bot chưa đăng nhập Zalo',
  owner_required: 'Không đủ quyền',
  cross_thread_denied: 'Không đủ quyền ở hội thoại này',
  confirmation_required: 'Cần xác nhận trước',
  command_denied: 'Lệnh không được phép',
  auth_required: 'Thiếu thông tin người gọi',
  friend_tools_disabled: 'Tính năng kết bạn đang tắt',
  own_message_not_found: 'Không tìm thấy tin để thu hồi',
  dm_not_allowed: 'Người này chưa được phép nhắn riêng với bot',
  feature_disabled: 'Tính năng đang tắt khi nhắn riêng',
};

const ROLE_LABELS = { owner: 'Chủ nhân', public: 'Thành viên' };

/** Cắt ngắn và che chuỗi giống khoá/token trước khi đưa vào mã kỹ thuật. */
function scrub(value) {
  if (value == null) return value;
  return String(value).slice(0, 200)
    .replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, '…')
    .replace(/[A-Za-z0-9_-]{32,}/g, '…');
}

export function describe(x, { role, names = new Map(), groups = new Map(), isUser = () => true }) {
  const admin = role === 'admin';
  if (x.src === 'dashboard') {
    // Dòng đăng nhập hỏng cũ có thể ghi nguyên chữ người ta gõ (kể cả mật khẩu) — chỉ giữ tên nếu là tài khoản có thật.
    const stranger = x.action === 'login' && x.ok === false && !isUser(x.actor);
    return {
      at: x.at, source: 'dashboard', who: stranger ? 'Người lạ' : `${scrub(x.actor)} (dashboard)`,
      what: ACTION_LABELS[x.action] || (admin ? x.action : 'Thao tác khác trên dashboard'),
      where: 'Dashboard', ok: x.ok, result: x.ok ? 'Thành công' : 'Không thành công',
      ...(admin ? { code: { action: scrub(x.action), detail: scrub(x.detail || '') } } : {}),
    };
  }
  let who;
  if (x.actorRole === 'dashboard') who = `${x.actorUid} (dashboard)`;
  else if (x.actorRole === 'system') who = 'Bot (tự động)';
  else who = [ROLE_LABELS[x.actorRole] || 'Người dùng', names.get(x.actorUid)].filter(Boolean).join(' ');
  const type = x.threadType === 1 ? 1 : 0;
  const where = !x.threadId ? '—' : (type === 1 ? groups.get(x.threadId) : names.get(x.threadId)) || fallbackName(x.threadId, type);
  return {
    at: x.at, source: 'zalo', who,
    what: ACTION_LABELS[x.action] || (admin ? x.action : 'Thao tác khác của bot'),
    where, ok: x.ok,
    result: x.ok ? 'Thành công' : `Không thành công${REASONS[x.error] ? ` — ${REASONS[x.error]}` : ''}`,
    ...(admin ? { code: { action: scrub(x.action), category: x.category, actorRole: x.actorRole, error: scrub(x.error) } } : {}),
  };
}

export function createAuditFeed({ store, activity, threadNames, isUser }) {
  return {
    /** `source`: 'all' | 'zalo' (việc của bot) | 'dashboard' (thao tác người) — lọc ở đây để mỗi trang đủ mục. */
    async list({ role, beforeMs = Number.MAX_SAFE_INTEGER, limit = 50, failedOnly = false, source = 'all' }) {
      const want = limit + 20; // dư ra để kéo dài trang qua các mục trùng mili-giây
      let fromBot = [];
      try { fromBot = source !== 'dashboard' && store.available() ? store.listAudit({ beforeMs, limit: want, failedOnly }) : []; } catch (err) {
        console.error('[dashboard] đọc nhật ký của bot lỗi:', err?.message || err);
      }
      const fromDashboard = source === 'zalo' ? [] : activity.list({ before: beforeMs, limit: want, failedOnly });
      const merged = [
        ...fromBot.map((r) => ({ src: 'zalo', ...r })),
        ...fromDashboard.map((e) => ({ src: 'dashboard', at: e.at, actor: e.actor, action: e.action, detail: e.detail, ok: e.ok })),
      ].sort((a, b) => b.at - a.at);
      // Con trỏ là mốc thời gian (lấy "< before"), nên trang phải chứa trọn mọi mục cùng mốc cuối.
      let n = Math.min(limit, merged.length);
      while (n > 0 && n < merged.length && merged[n].at === merged[n - 1].at) n += 1;
      const page = merged.slice(0, n);
      const uids = page.filter((x) => x.src === 'zalo').flatMap((x) => [x.actorUid, x.threadType === 0 ? x.threadId : null]).filter(Boolean);
      let names = new Map();
      try { if (uids.length && store.available()) names = store.senderNames(uids); } catch (err) {
        console.error('[dashboard] đọc tên người dùng lỗi:', err?.message || err);
      }
      const groups = await threadNames.load();
      return {
        items: page.map((x) => describe(x, { role, names, groups, isUser })),
        nextBefore: merged.length > n ? page[page.length - 1].at : null,
      };
    },
  };
}
