export class SidecarDown extends Error {
  constructor(message = 'Không liên lạc được với kết nối Zalo') { super(message); this.name = 'SidecarDown'; }
}

/** Đã gửi yêu cầu nhưng quá hạn chờ: bot có thể vẫn đang làm (vd. đang gửi tin) — không được coi là "bot tắt". */
export class SidecarTimeout extends Error {
  constructor(message = 'Kết nối Zalo chưa trả lời kịp') { super(message); this.name = 'SidecarTimeout'; }
}

export function createSidecarClient({ baseUrl = 'http://127.0.0.1:3872', token, fetchImpl = fetch, timeoutMs = 4000, sendTimeoutMs = 20_000 }) {
  // distinctTimeout: chỉ lệnh gửi phân biệt "quá hạn" với "không kết nối được"; lệnh khác quá hạn vẫn là SidecarDown
  // (watchdog, trạng thái, tên nhóm coi bot treo như bot tắt).
  async function call(path, { method = 'GET', body, limitMs = timeoutMs, distinctTimeout = false } = {}) {
    let res;
    let json = {};
    // Dùng setTimeout thường (không phải AbortSignal.timeout, vốn bị unref) để hạn giờ cả lúc đọc thân phản hồi.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), limitMs);
    try {
      res = await fetchImpl(`${baseUrl}/control${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      try { json = await res.json(); } catch (err) { if (ctrl.signal.aborted) throw err; /* thân rỗng */ }
    } catch (err) {
      throw distinctTimeout && ctrl.signal.aborted ? new SidecarTimeout() : new SidecarDown();
    } finally { clearTimeout(timer); }
    if (!res.ok || json.ok === false) throw Object.assign(new Error(json.error || `Lỗi ${res.status}`), { statusCode: res.status });
    return json;
  }
  return {
    health: async () => (await call('/health')).health,
    qrStart: () => call('/qr/start', { method: 'POST' }),
    qr: async () => { const { status, image, user } = await call('/qr'); return { status, image, user }; },
    logout: () => call('/logout', { method: 'POST' }),
    // Gửi tin qua Zalo có thể mất vài giây (mạng chậm, ảnh xem trước liên kết) — hạn riêng dài hơn.
    send: async (m) => (await call('/send', { method: 'POST', body: m, limitMs: sendTimeoutMs, distinctTimeout: true })).result,
    loginCode: (m) => call('/login-code', { method: 'POST', body: m }),
    groups: async () => (await call('/groups')).groups,
    // Gửi ảnh/tệp lớn qua Zalo có thể lâu (tải lên) — hạn 60 giây, quá hạn chưa chắc là thất bại.
    sendFile: async (m) => (await call('/send-file', { method: 'POST', body: m, limitMs: 60_000, distinctTimeout: true })).result,
    recall: async (m) => (await call('/recall', { method: 'POST', body: m, limitMs: sendTimeoutMs })).result,
    groupMembers: async (groupId) => {
      const { total, members, adminIds, creatorId } = await call(`/group-members?groupId=${encodeURIComponent(groupId)}`, { limitMs: sendTimeoutMs });
      return { total, members, adminIds: Array.isArray(adminIds) ? adminIds.map(String) : [], creatorId: creatorId ? String(creatorId) : '' };
    },
    // Liên hệ và Lịch hẹn (spec §18.4). Danh sách bạn có thể dài — hạn chờ như lệnh gửi.
    // Phiên chat kiểu Zalo. Ảnh đại diện không bắt buộc: chờ ngắn, lỗi thì trang vẫn hiện chữ cái đầu.
    chatInfo: async ({ threadId, threadType }) => (await call(`/chat-info?threadId=${encodeURIComponent(threadId)}&threadType=${Number(threadType)}`, { limitMs: sendTimeoutMs })).info,
    avatars: async (uids, { limitMs = 2500 } = {}) => (await call('/avatars', { method: 'POST', body: { uids }, limitMs })).avatars,
    groupAvatars: async (ids, { limitMs = 2500 } = {}) => (await call('/group-avatars', { method: 'POST', body: { ids }, limitMs })).avatars,
    pinnedThreads: async ({ limitMs = 2500 } = {}) => (await call('/pinned-threads', { limitMs })).pinned,
    pinThread: (m) => call('/pin-thread', { method: 'POST', body: m, limitMs: sendTimeoutMs }),
    board: async (groupId) => (await call(`/board?groupId=${encodeURIComponent(groupId)}`, { limitMs: sendTimeoutMs })).board,
    friends: async ({ fresh = false } = {}) => (await call(`/friends${fresh ? '?fresh=1' : ''}`, { limitMs: sendTimeoutMs })).friends,
    friendRequests: async () => (await call('/friend-requests', { limitMs: sendTimeoutMs })).requests,
    answerFriendRequest: (m) => call('/friend-requests/answer', { method: 'POST', body: m, limitMs: sendTimeoutMs }),
    reminders: async ({ threadId, threadType }) => (await call(
      `/reminders?threadId=${encodeURIComponent(threadId)}&threadType=${encodeURIComponent(threadType)}`, { limitMs: sendTimeoutMs },
    )).reminders,
    removeReminder: (m) => call('/reminders/remove', { method: 'POST', body: m, limitMs: sendTimeoutMs }),
    broadcasts: async () => { const { jobs, sentToday } = await call('/broadcasts'); return { jobs, sentToday }; },
    createBroadcast: async (m) => (await call('/broadcasts', { method: 'POST', body: m, limitMs: sendTimeoutMs, distinctTimeout: true })).job,
    broadcastAction: async (id, action) => (await call(`/broadcasts/${encodeURIComponent(id)}/${action}`, { method: 'POST' })).job,
  };
}
