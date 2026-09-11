/**
 * Đổi "@Tên hiển thị" trong tin bot gửi vào nhóm thành tag Zalo thật.
 *
 * Bot tự quyết lúc nào cần tag (xem hướng dẫn trình bày); ở đây chỉ gắn cho
 * đúng người. Tên phải khớp trọn một người trong danh bạ và không có dấu hiệu
 * còn tiếp; hai người trùng tên thì để nguyên dạng chữ — tag nhầm người tệ hơn
 * không tag.
 */

const NAME_CHAR = /[\p{L}\p{N}_]/u;
// "@Trang Nguyễn": chữ hoa ngay sau dấu cách nghĩa là tên còn tiếp — có thể là
// một người khác không có trong danh bạ, nên không tag "Trang".
const NAME_CONTINUES = /^ \p{Lu}/u;

function normalize(text) {
  return text.toLocaleLowerCase('vi');
}

/**
 * @param {string} msg Chữ đã qua bộ dịch Markdown (vị trí tính trên chuỗi này).
 * @param {{uid: string, name: string}[]} members
 * @param {{selfUid?: string, continuesInNextChunk?: boolean}} options
 *   continuesInNextChunk: chunk này chưa phải chunk cuối — tên nằm sát cuối có
 *   thể bị cắt đôi ("@Trang " | "Nguyễn …") nên không tag.
 * @returns {{pos: number, len: number, uid: string}[]}
 */
export function findMentions(msg, members, { selfUid = '', continuesInNextChunk = false } = {}) {
  const text = String(msg ?? '');
  if (!text.includes('@') || !Array.isArray(members) || !members.length) return [];

  const uidsByName = new Map();
  for (const member of members) {
    const uid = String(member?.uid ?? '');
    const name = String(member?.name ?? '').trim();
    if (!uid || !name || uid === String(selfUid)) continue;
    const key = normalize(name);
    const entry = uidsByName.get(key) ?? { length: name.length, uids: new Set() };
    entry.uids.add(uid);
    uidsByName.set(key, entry);
  }
  // Tên dài trước: "@Lương Hải Anh Cnt" không được khớp nhầm thành "@Lương".
  const names = [...uidsByName.entries()].sort((a, b) => b[1].length - a[1].length);

  const mentions = [];
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    if (at > 0 && NAME_CHAR.test(text[at - 1])) continue; // a@b trong email
    const match = names.find(([key, { length }]) => {
      const after = text.slice(at + 1 + length);
      return normalize(text.slice(at + 1, at + 1 + length)) === key
        && !NAME_CHAR.test(after[0] ?? '')
        && !NAME_CONTINUES.test(after)
        && !(continuesInNextChunk && after.trim() === '');
    });
    if (!match) continue;
    const [, { length, uids }] = match;
    if (uids.size !== 1) continue;
    mentions.push({ pos: at, len: length + 1, uid: [...uids][0] });
    at += length;
  }
  return mentions;
}

/**
 * Danh bạ từng nhóm, nhớ tạm để không tra lại mỗi tin gửi.
 *
 * `fetchMembers(groupId)` trả `{ members, cacheable }`. Kết quả không đầy đủ
 * (tra thành viên lỗi) thì không nhớ, và nếu còn bản cũ thì dùng bản cũ. Lỗi
 * hẳn thì trả bản cũ hoặc rỗng — tin vẫn đi, chỉ không có tag.
 */
export function createMemberDirectory({ fetchMembers, ttlMs = 10 * 60 * 1000, now = Date.now } = {}) {
  const cache = new Map();
  return {
    async get(groupId) {
      const key = String(groupId);
      const hit = cache.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.members;
      try {
        const { members = [], cacheable = true } = (await fetchMembers(key)) || {};
        if (cacheable) {
          cache.set(key, { at: now(), members });
          return members;
        }
        return hit ? hit.members : members;
      } catch (err) {
        console.warn('[bridge] không lấy được danh sách thành viên để gắn tag:', err?.message || err);
        return hit?.members ?? [];
      }
    },
  };
}
