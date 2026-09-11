import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { format } from 'node:util';

/**
 * Chép mọi dòng console của sidecar ra file, kèm giờ và cấp độ.
 *
 * Sidecar hay chạy ngầm (khởi động cùng máy, cửa sổ terminal đã đóng), nên log
 * chỉ in ra màn hình là mất sạch — sự cố bot "điếc" đêm 10/9/2026 không truy
 * được giờ đứt cũng vì thế. Quá `maxBytes` thì dời file cũ sang `.1` để không
 * đầy ổ đĩa.
 *
 * @returns {() => void} Hàm gỡ, trả console về như cũ.
 */
const METHODS = ['log', 'info', 'warn', 'error'];

export function installFileLog({ path, target = console, maxBytes = 5 * 1024 * 1024, now = () => new Date() }) {
  let size = 0;
  try {
    mkdirSync(dirname(path), { recursive: true });
    size = statSync(path).size;
  } catch { /* file chưa có — bắt đầu từ 0 */ }

  const originals = new Map();
  for (const method of METHODS) {
    const original = target[method];
    originals.set(method, original);
    target[method] = (...args) => {
      original.apply(target, args);
      const line = `${timestamp(now())} ${method.toUpperCase()} ${format(...args)}\n`;
      try {
        const bytes = Buffer.byteLength(line);
        if (size > 0 && size + bytes > maxBytes) {
          renameSync(path, `${path}.1`);
          size = 0;
        }
        appendFileSync(path, line, 'utf8');
        size += bytes;
      } catch { /* ghi log hỏng thì bỏ qua, không được làm sập sidecar */ }
    };
  }

  return () => {
    for (const [method, original] of originals) target[method] = original;
  };
}

/** Giờ địa phương kèm múi giờ, cùng kiểu với log của Hermes để dễ đối chiếu. */
function timestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}
