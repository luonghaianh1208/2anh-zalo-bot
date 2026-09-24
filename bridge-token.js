// Giải mã bí mật của cầu nối Hermes từ tệp, thay vì từ biến môi trường.
//
// Vì sao cần tệp: khi chạy bằng container, biến môi trường hiện ra trong
// `docker inspect`, trong danh sách tiến trình của host và trong log crash của
// bất kỳ thư viện nào quyết định in môi trường ra. Một tệp mode 0600 mount vào
// cả hai container thì chỉ có tiến trình đọc được nó mới thấy giá trị, và chỉ
// có một bản duy nhất để xoay vòng.
//
// Chạy trực tiếp trên máy (host-native) không đổi gì: không đặt
// ZALO_BRIDGE_TOKEN_FILE thì mọi thứ vẫn lấy từ ZALO_BRIDGE_TOKEN như cũ.

import { readFileSync } from 'node:fs';

/**
 * Đọc token từ tệp. Thiếu tệp, không đọc được, hoặc tệp rỗng đều là lỗi —
 * không bao giờ âm thầm trả về chuỗi rỗng. Một cầu nối chạy với token rỗng sẽ
 * so sánh thành công với mọi client không gửi token, tức là mở toang cửa.
 *
 * @param {string} path
 * @returns {string}
 */
export function readBridgeTokenFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    // Nêu mã lỗi và đường dẫn, không bao giờ nêu nội dung.
    throw new Error(`Không đọc được ZALO_BRIDGE_TOKEN_FILE (${error?.code || 'read_failed'}): ${path}`);
  }
  const token = raw.trim();
  if (!token) throw new Error(`ZALO_BRIDGE_TOKEN_FILE rỗng: ${path}`);
  return token;
}

/**
 * Tệp thắng biến môi trường, tường minh. Nếu đã chỉ định tệp thì tệp là nguồn
 * duy nhất — hỏng thì dừng, không rơi về env. Rơi về env lặng lẽ là cách một
 * lần mount sai biến thành "vẫn chạy, nhưng bằng bí mật cũ".
 *
 * @param {{file?: string, envToken?: string}} [options]
 * @returns {string}
 */
export function resolveBridgeToken({ file, envToken } = {}) {
  const path = String(file || '').trim();
  if (path) return readBridgeTokenFile(path);
  return String(envToken || '').trim();
}
