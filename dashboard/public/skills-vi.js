// Skill bằng tiếng Việt: mô tả dễ hiểu, lĩnh vực và mục đích dùng để lọc. Tên skill giữ nguyên (trợ lý gọi theo tên).
// Dữ liệu ở skills-vi-data.js. Skill mới chưa có trong đó vẫn hiện: mô tả gốc, lĩnh vực đoán theo nhóm của Hermes.
import { SKILL_VI } from './skills-vi-data.js';

export const SKILL_DOMAINS = [
  ['giao-duc', 'Giáo dục & dạy học'],
  ['van-ban', 'Văn bản & hành chính'],
  ['van-phong', 'Văn phòng & năng suất'],
  ['truyen-thong', 'Nội dung & truyền thông'],
  ['sang-tao', 'Thiết kế, ảnh, video'],
  ['nghien-cuu', 'Nghiên cứu & tra cứu'],
  ['du-lieu', 'Dữ liệu & AI'],
  ['lap-trinh', 'Lập trình & phần mềm'],
  ['he-thong', 'Máy chủ & bảo mật'],
  ['tac-tu', 'Tác tử & tự động hoá'],
  ['doi-song', 'Đời sống & thiết bị'],
];

export const SKILL_USES = [
  ['tao-tep', 'Tạo tệp (Word, PDF, slide…)'],
  ['soan-thao', 'Viết & soạn thảo'],
  ['hoc-tap', 'Dạy học, ra đề'],
  ['tra-cuu', 'Tra cứu & tóm tắt'],
  ['hinh-anh', 'Ảnh, video, âm thanh'],
  ['phan-tich', 'Phân tích dữ liệu'],
  ['giao-tiep', 'Gửi tin, email, đăng bài'],
  ['quan-ly', 'Quản lí việc & ghi chú'],
  ['tu-dong', 'Tự động hoá & hẹn giờ'],
  ['ky-thuat', 'Lập trình, triển khai'],
];

// Nhóm của Hermes (thư mục skills/<nhóm>/) → lĩnh vực, cho skill chưa có bản dịch.
const CATEGORY_DOMAIN = {
  productivity: 'van-phong', 'note-taking': 'van-phong', email: 'van-phong',
  creative: 'sang-tao', media: 'sang-tao', writing: 'truyen-thong', 'social-media': 'truyen-thong',
  research: 'nghien-cuu', 'software-development': 'lap-trinh', github: 'lap-trinh', web: 'lap-trinh',
  mlops: 'du-lieu', devops: 'he-thong', 'autonomous-ai-agents': 'tac-tu', 'smart-home': 'doi-song',
};

/** Skill kèm mô tả tiếng Việt (`descVi`), lĩnh vực (`domains`) và mục đích (`uses`); thiếu thì nhóm "khac". */
export function viSkill(s) {
  const v = Object.hasOwn(SKILL_VI, s.name) ? SKILL_VI[s.name] : null;
  const guess = CATEGORY_DOMAIN[s.category];
  return {
    ...s,
    descVi: v?.[0] || s.description || '',
    domains: v?.[1]?.length ? v[1] : [guess || 'khac'],
    uses: v?.[2]?.length ? v[2] : ['khac'],
  };
}

/** Lọc theo lĩnh vực, mục đích ('all' = tất cả) và chữ gõ (tên, mô tả Việt và gốc, nhóm; không dấu). */
export function filterSkills(list, { domain = 'all', use = 'all', q = '', fold = (t) => t.toLowerCase() } = {}) {
  const k = fold(q).trim();
  return list.filter((s) => (domain === 'all' || s.domains.includes(domain))
    && (use === 'all' || s.uses.includes(use))
    && (!k || fold(`${s.name} ${s.descVi} ${s.description || ''} ${s.category || ''}`).includes(k)));
}

/** Số skill mỗi nhãn (để hiện cạnh nút lọc và ẩn nhãn không có skill nào). */
export function countTags(list, key) {
  const out = {};
  for (const s of list) for (const t of s[key]) out[t] = (out[t] || 0) + 1;
  return out;
}

/** Nút lọc cho một hàng: Tất cả + nhãn có skill (kèm số), "Khác" ở cuối khi có. */
export function filterChips(all, defs, counts) {
  const named = defs.filter(([id]) => counts[id]).map(([id, label]) => [id, label, counts[id]]);
  return [['all', 'Tất cả', all], ...named, ...(counts.khac ? [['khac', 'Khác', counts.khac]] : [])];
}
