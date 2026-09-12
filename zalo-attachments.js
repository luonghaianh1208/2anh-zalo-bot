/**
 * Phân loại tệp đính kèm của một tin Zalo: ảnh, video, âm thanh hay tài liệu.
 *
 * Vì sao cần: tin gửi tệp (`msgType` dạng `share.file`) có cùng hình dạng với
 * tin ảnh — đều là một URL trong `content`. Trước đây cầu nối gắn nhãn
 * `image/jpeg` cho mọi URL, nên một tệp PDF bị tải về như ảnh rồi báo "không
 * đọc được ảnh", còn agent thì mô tả tài liệu như một tấm hình.
 *
 * Tin tệp còn kèm một URL ảnh thu nhỏ (`thumb`). Giữ nó lại thì agent nhận
 * được một tấm hình mờ thay vì tài liệu, nên tin tệp chỉ giữ đúng `href`.
 */

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.heic': 'image/heic', '.jxl': 'image/jxl',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed',
};

function extensionOf(value) {
  const clean = String(value ?? '').split(/[?#]/)[0];
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(clean);
  return match ? `.${match[1].toLowerCase()}` : '';
}

function kindOf(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

/** Tin này có phải tin gửi tệp không (share.file, chat.file…). */
export function isFileMessage(msgType) {
  return /file/i.test(String(msgType ?? ''));
}

/**
 * Tin này có đính kèm media thật không.
 *
 * Thẻ chia sẻ link (`chat.recommended`: TikTok, Facebook, Google Meet, Drive…)
 * cũng có `href` và `thumb` như tin ảnh, nên trước đây link bị tải về như ảnh
 * rồi báo "không đọc được ảnh". Link thì để nguyên trong chữ: bot đọc bằng
 * zalo_web_read, vừa đúng nội dung trang vừa không tải nhầm.
 *
 * Chặn theo danh sách loại trừ chứ không phải danh sách cho phép: phần trích dẫn
 * của Zalo (`TQuote`) chỉ có `cliMsgType` dạng SỐ, không có tên loại, nên danh
 * sách cho phép sẽ vứt luôn ảnh của tin được reply.
 */
export function hasRealMedia(msgType) {
  return !/(recommended|webchat|chat\.text|poll|ecard|undo|sticker|link)/i.test(String(msgType ?? ''));
}

/**
 * @returns {{url: string, name: string, mime: string, kind: string}}
 */
export function guessAttachment(url, { name = '', msgType = '' } = {}) {
  const ext = extensionOf(name) || extensionOf(url);
  let mime = MIME_BY_EXT[ext] || '';
  if (!mime) {
    // Không đoán được đuôi: tin tệp coi là tài liệu, còn lại coi là ảnh — Zalo
    // gửi ảnh qua URL không đuôi, nhưng tệp thì luôn có tên kèm đuôi.
    mime = isFileMessage(msgType) ? 'application/octet-stream' : 'image/jpeg';
  }
  return {
    url: String(url),
    name: String(name || '').trim() || (ext ? `file${ext}` : ''),
    mime,
    kind: kindOf(mime),
  };
}

/**
 * Phân loại danh sách URL đã trích từ một tin.
 * @param {object} msg Tin thô của zca-js.
 * @param {string[]} urls
 */
export function classifyAttachments(msg, urls) {
  const content = msg?.data?.content;
  const msgType = msg?.data?.msgType ?? '';
  const title = content && typeof content === 'object' ? String(content.title ?? '') : '';
  const href = content && typeof content === 'object' ? String(content.href ?? '') : '';

  if (!hasRealMedia(msgType)) return [];

  if (isFileMessage(msgType)) {
    // Chỉ giữ chính tệp, bỏ ảnh thu nhỏ đi kèm.
    const fileUrl = urls.includes(href) ? href : urls[0];
    return fileUrl ? [guessAttachment(fileUrl, { name: title, msgType })] : [];
  }
  return urls.map((url) => guessAttachment(url, { name: url === href ? title : '', msgType }));
}
