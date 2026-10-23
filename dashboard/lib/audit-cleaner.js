// Dọn Nhật ký (chỉ Quản trị): xoá dòng audit_log cũ trong SQLite của bot. Mọi chỗ khác dashboard chỉ đọc tệp này —
// đây là lối ghi duy nhất, mở kết nối riêng (WAL + chờ khoá) rồi đóng ngay, không đụng bảng nào khác.
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function createAuditCleaner({ path }) {
  return {
    /** Xoá dòng có created_at_ms < beforeMs; trả số dòng đã xoá (0 khi chưa có tệp). */
    clearBefore(beforeMs) {
      if (!path || !existsSync(path)) return 0;
      const db = new DatabaseSync(path, { timeout: 5000 });
      try {
        return Number(db.prepare('DELETE FROM audit_log WHERE created_at_ms < ?').run(Number(beforeMs)).changes);
      } finally { db.close(); }
    },
  };
}
