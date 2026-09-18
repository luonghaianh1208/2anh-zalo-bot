import { readFileSync, statSync } from 'node:fs';

// Roster rỗng tường minh, dành cho caller chưa có roster (kiểm thử). Tiến trình
// thật KHÔNG dùng nó: server.js nạp roster một lần lúc khởi động và ném lỗi nếu
// thiếu, nên chỉ có đúng một chỗ quyết định việc đó.
export function emptyRoster() {
  return { owners: new Set(), guests: new Set(), guestGroups: new Set() };
}

function idsOf(roster, field) {
  const values = roster[field] ?? [];
  if (!Array.isArray(values)) throw new Error(`Roster field ${field} phải là một mảng`);
  return new Set(values.map(String));
}

// Roster thiếu hoặc không đọc được thì ném lỗi, không trả roster rỗng. Roster
// rỗng làm cửa ở bot-handler từ chối *tất cả mọi người kể cả chủ nhân*, và làm
// activeOwnerUids rỗng ở hermes-bridge — tức đúng khiếm khuyết đã gặp thật hôm
// 2026-09-17. Một container không khởi động được thì thấy ngay; một container
// chạy mà không trả lời ai thì mất hàng giờ mới phát hiện, và dấu vết duy nhất
// là một dòng cảnh báo. Quên chạy sync-zalo-roster.sh một lần là đủ gây ra nó.
export function loadRoster(path) {
  if (!path) throw new Error('Chưa cấu hình ZALO_ROSTER_FILE');

  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Không tìm thấy roster: ${path}`, { cause: error });
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Roster JSON không hợp lệ: ${error.message}`, { cause: error });
  }
  if (parsed?.version !== 1) {
    throw new Error(`Phiên bản roster không được hỗ trợ: ${String(parsed?.version)}`);
  }

  const owners = idsOf(parsed, 'owners');
  const guests = idsOf(parsed, 'guests');
  const guestGroups = idsOf(parsed, 'guestGroups');
  for (const uid of owners) {
    if (guests.has(uid)) throw new Error(`UID ${uid} nằm trong cả owners và guests`);
  }
  return { owners, guests, guestGroups };
}

// Mỗi lần kiểm đều stat theo đường dẫn rồi mở lại tệp khi nó đổi. Không giữ
// descriptor hay watch theo inode: roster được thay bằng rename nên inode cũ
// không còn là roster mà sidecar cần đọc.
export function reloadRosterIfChanged(path, roster, previousState = null, reportError = console.error) {
  try {
    const stat = statSync(path);
    const state = { mtimeMs: stat.mtimeMs, size: stat.size, lastError: null };
    if (previousState?.mtimeMs === state.mtimeMs && previousState?.size === state.size) {
      return { roster, state };
    }
    return { roster: loadRoster(path), state };
  } catch (error) {
    // Hàm này chạy mỗi tin nhắn, nên một roster thiếu sẽ sinh một dòng log mỗi
    // tin — đúng kiểu ngập log đã làm chết đường gửi ngày 18/09. Nêu một lần
    // cho mỗi lỗi khác nhau, và nêu lại khi lỗi đổi hoặc sau khi đã hồi phục.
    const reason = String(error?.message || error);
    if (reason !== previousState?.lastError) {
      reportError(`[bot] không nạp lại roster — giữ roster đang dùng: ${reason}`);
    }
    return { roster, state: { ...(previousState || {}), lastError: reason } };
  }
}
