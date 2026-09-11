import { TextStyle } from 'zca-js';

/**
 * Chuyển Markdown sang định dạng chữ gốc của Zalo.
 *
 * Zalo không hiểu Markdown, nhưng có hệ style riêng (đậm, nghiêng, gạch,
 * và bốn màu) đi kèm tin nhắn dưới dạng danh sách {start, len, st}. Hàm này
 * dịch đầu ra Markdown của Hermes Agent sang hệ đó, nên agent cứ viết
 * Markdown bình thường như khi trả lời trên Telegram.
 *
 * Bảng quy đổi
 *   # ## ###            → đậm + phóng to (tiêu đề)
 *   #### trở xuống      → đậm + phóng to (tiêu đề phụ, hiếm dùng)
 *   **đậm**, __đậm__    → đậm           (từ khoá, con số)
 *   *nghiêng*, _nghiêng_→ nghiêng
 *   ~~gạch ngang~~      → gạch ngang
 *   `mã`                → đậm           (Zalo không có chữ đơn cách)
 *   ```khối mã```       → giữ nguyên nội dung
 *   > trích dẫn         → nghiêng
 *   - mục, * mục        → •
 *   [chữ](liên-kết)     → chữ (liên-kết)
 *   [red]…[/red]        → đỏ            (khi cần chỉ định màu tay)
 *   [green] [orange] [yellow] và bí danh tiếng Việt [do] [xanh] [cam] [vang]
 *
 * Trả về { msg, styles } đúng dạng api.sendMessage của zca-js.
 */

const COLORS = {
  red: TextStyle.Red || 'c_db342e',
  green: TextStyle.Green || 'c_15a85f',
  orange: TextStyle.Orange || 'c_f27806',
  yellow: TextStyle.Yellow || 'c_f7b503',
};
const BOLD = TextStyle.Bold || 'b';
// Cỡ chữ lớn. Dùng chồng với in đậm cho tiêu đề và số thứ tự để mắt dễ bắt ý;
// chunker sẽ tự tách tin khi số style chạm ngưỡng an toàn.
const BIG = TextStyle.Big || 'f_18';
const ITALIC = TextStyle.Italic || 'i';
const STRIKE = TextStyle.StrikeThrough || 's';

const ALIASES = [
  [/\[do\]/gi, '[red]'], [/\[\/do\]/gi, '[/red]'],
  [/\[xanh\]/gi, '[green]'], [/\[\/xanh\]/gi, '[/green]'],
  [/\[cam\]/gi, '[orange]'], [/\[\/cam\]/gi, '[/orange]'],
  [/\[vang\]/gi, '[yellow]'], [/\[\/vang\]/gi, '[/yellow]'],
];

/**
 * Chuẩn hoá định dạng chữ cho Zalo:
 *
 * Thực tế Zalo chấp nhận số lượng lớn style In Đậm (b) — thử nghiệm với 30+ style
 * in đậm trong cùng một tin nhắn vẫn gửi thành công 100%.
 *
 * Để giao diện tin nhắn đẹp, rõ ràng, trang trọng theo chuẩn công văn giáo dục
 * (như mẫu ở Ảnh 2):
 * - Tiêu đề (# ## ###): In Đậm (b) + phóng to toàn bộ dòng tiêu đề.
 * - Đầu các chỉ mục số (1. 2. 3.): In Đậm (b) + phóng to phần số.
 * - Các nhãn mục con (• Hiện tại:, • Góp ý:, • Phân tích:): In Đậm (b).
 * - Các từ khóa quan trọng (**từ khóa**): In Đậm (b) trọn vẹn, không bị nuốt chữ.
 *
 * Giới hạn an toàn 40 styles được xử lý ở formatAndChunkZaloMarkdown():
 * chia thành nhiều tin thay vì cắt bớt style.
 */
const MAX_STYLES = 40;
const MAX_CHARS = 2000;
// Zalo còn chặn theo khối lượng gói tin, không chỉ số ký tự hay số style. Đối
// chiếu 223 lần gửi thật: mọi tin bị từ chối bằng "Lỗi không xác định" đều có
// byte UTF-8 của chữ + độ dài JSON style từ 3448 trở lên, mọi tin lọt đều không
// quá 3437. Chữ có dấu tốn 2–3 byte, emoji 4 byte, nên một tin chưa tới 2000 ký
// tự vẫn vượt được. Để 3000 chừa khoảng an toàn dưới ngưỡng đo được.
const MAX_PAYLOAD_BYTES = 3000;

function payloadBytes(formatted) {
  return Buffer.byteLength(formatted.msg, 'utf8') + JSON.stringify(formatted.styles).length;
}

export function formatZaloMarkdown(input) {
  if (!input) return { msg: '', styles: [] };

  let raw = String(input);
  for (const [pattern, replacement] of ALIASES) raw = raw.replace(pattern, replacement);

  const styles = [];
  const outLines = [];
  let offset = 0; // vị trí ký tự đầu dòng hiện tại trong chuỗi kết quả

  const lines = raw.split(/\r?\n/);
  let inCodeBlock = false;
  let prevBlank = false; // để gộp các dòng trống liên tiếp

  for (let line of lines) {
    // ``` mở/đóng khối mã — bỏ dấu rào, giữ nội dung bên trong nguyên vẹn
    if (/^\s*```/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      outLines.push(line);
      offset += line.length + 1;
      prevBlank = false;
      continue;
    }

    // Đường kẻ ngang --- → bỏ hẳn, Zalo không có.
    // Không động tới prevBlank: dòng --- vô hình, nên dòng trống trước và
    // sau nó phải được gộp lại với nhau thành một.
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      continue;
    }

    // Gộp các dòng trống liên tiếp thành một. Markdown thường để dòng trống
    // trước và sau dấu --- hay giữa các đoạn; giữ nguyên thì trên Zalo thành
    // hai ba dòng trắng liên tiếp, trông như một khoảng trống lớn.
    const isBlank = line.trim() === '';
    if (isBlank && prevBlank) continue;
    prevBlank = isBlank;

    let lineStyles = [];
    let wholeLineStyles = [];

    // Tiêu đề & Đề mục: In Đậm (b) toàn bộ dòng để phân cấp mạch lạc, rõ ràng như mẫu công văn giáo dục
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      line = heading[2];
      wholeLineStyles = [BOLD, BIG];
    }

    // Trích dẫn: > … → nghiêng cả dòng
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (!heading && quote) {
      line = quote[1];
      wholeLineStyles = [ITALIC];
    }

    // Phân cấp danh sách đầu dòng chuẩn:
    // - Cấp 1 (ngay sau tiêu đề/danh mục): dùng gạch đầu dòng '- '
    // - Cấp 2 trở đi (mục con thụt lề >= 2 khoảng trắng): dùng dấu chấm tròn '• '
    line = line.replace(/^(\s*)([-*•])\s+/, (match, indent) => {
      return indent.length >= 2 ? `${indent}• ` : `${indent}- `;
    });

    // Đầu chỉ mục số thứ tự (ví dụ: '1. ', '2. ', '1) '):
    // In Đậm (b) phần số thứ tự ở đầu dòng để mắt dễ bắt ý
    let listNumStart = 0;
    let listNumLen = 0;
    if (!heading) {
      const numMatch = line.match(/^(\s*)(\d+[\.)]\s+)/);
      if (numMatch) {
        listNumStart = numMatch[1].length;
        listNumLen = numMatch[2].length;
      }
    }

    const { text, styles: inline } = renderInline(line, offset);
    lineStyles = inline;

    if (wholeLineStyles.length && text.length) {
      for (const st of wholeLineStyles) {
        lineStyles.push({ start: offset, len: text.length, st });
      }
    }

    if (listNumLen > 0) {
      lineStyles.push({ start: offset + listNumStart, len: listNumLen, st: BOLD });
      lineStyles.push({ start: offset + listNumStart, len: listNumLen, st: BIG });
    }

    styles.push(...lineStyles);
    outLines.push(text);
    offset += text.length + 1; // +1 cho ký tự xuống dòng
  }

  return { msg: outLines.join('\n'), styles };
}

/**
 * Tự động chia Markdown thành các tin nhắn Zalo độc lập.
 *
 * Không cắt bớt style nữa: nếu nội dung quá nhiều định dạng, hàm này tách nhỏ
 * trước khi gửi để mỗi tin vẫn giữ đủ toàn bộ style nằm trong phần của nó.
 *
 * @param {string} input Nội dung Markdown thô từ Hermes Agent
 * @returns {Array<{ msg: string, styles: Array<{start: number, len: number, st: string}> }>}
 */
export function formatAndChunkZaloMarkdown(input) {
  if (!input) return [];

  const formatted = formatZaloMarkdown(String(input).trim());
  if (!formatted.msg.trim()) return [];
  if (!exceedsZaloBudget(formatted)) return [formatted];

  return chunkFormattedMessage(formatted);
}

function exceedsZaloBudget(formatted) {
  return formatted.msg.length > MAX_CHARS
    || formatted.styles.length > MAX_STYLES
    || payloadBytes(formatted) > MAX_PAYLOAD_BYTES;
}

function chunkFormattedMessage(formatted) {
  const chunks = [];
  let start = 0;

  while (start < formatted.msg.length) {
    const end = findChunkEnd(formatted, start);
    chunks.push(sliceFormattedMessage(formatted, start, end));
    start = end;
  }

  return chunks.filter((chunk) => chunk.msg.trim());
}

function findChunkEnd(formatted, start) {
  let end = Math.min(start + MAX_CHARS, formatted.msg.length);
  end = preferReadableBoundary(formatted.msg, start, end);

  while (styleCountInRange(formatted.styles, start, end) > MAX_STYLES && end > start + 1) {
    end = lastStyleBoundaryBefore(formatted.styles, start, end) || Math.floor((start + end) / 2);
    end = Math.max(start + 1, Math.min(end, start + MAX_CHARS));
  }

  // Thu nhỏ tiếp tới khi cả chữ lẫn style lọt ngân sách byte, vẫn ưu tiên cắt ở
  // chỗ đọc được. Mỗi vòng `end` giảm hẳn nên vòng lặp luôn dừng.
  let bytes = payloadBytes(sliceFormattedMessage(formatted, start, end));
  while (bytes > MAX_PAYLOAD_BYTES && end > start + 1) {
    const target = start + Math.floor((end - start) * MAX_PAYLOAD_BYTES / bytes);
    end = preferReadableBoundary(formatted.msg, start, Math.max(start + 1, Math.min(target, end - 1)));
    if (end > start + 1 && isHighSurrogate(formatted.msg.charCodeAt(end - 1))) end -= 1;
    bytes = payloadBytes(sliceFormattedMessage(formatted, start, end));
  }

  return end;
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function preferReadableBoundary(msg, start, end) {
  if (end >= msg.length) return msg.length;

  const window = msg.slice(start, end);
  for (const marker of ['\n\n', '\n', '. ', '; ', ', ', ' ']) {
    const idx = window.lastIndexOf(marker);
    if (idx > 0 && idx >= window.length * 0.6) {
      return start + idx + marker.length;
    }
  }
  return end;
}

function styleCountInRange(styles, start, end) {
  return styles.filter((style) => style.start < end && style.start + style.len > start).length;
}

function lastStyleBoundaryBefore(styles, start, end) {
  const boundaries = styles
    .flatMap((style) => [style.start, style.start + style.len])
    .filter((pos) => pos > start && pos < end)
    .sort((a, b) => b - a);
  return boundaries.find((pos) => styleCountInRange(styles, start, pos) <= MAX_STYLES) || null;
}

function sliceFormattedMessage(formatted, start, end) {
  const styles = [];
  for (const style of formatted.styles) {
    const styleStart = style.start;
    const styleEnd = style.start + style.len;
    if (styleStart >= end || styleEnd <= start) continue;

    const clippedStart = Math.max(styleStart, start);
    const clippedEnd = Math.min(styleEnd, end);
    styles.push({
      start: clippedStart - start,
      len: clippedEnd - clippedStart,
      st: style.st,
    });
  }

  return { msg: formatted.msg.slice(start, end), styles };
}

/**
 * Xử lý markup trong một dòng. `base` là vị trí của dòng trong chuỗi kết quả,
 * dùng để tính offset tuyệt đối cho style.
 */
function renderInline(line, base) {
  const styles = [];
  let out = '';
  let i = 0;

  const push = (start, len, st) => {
    if (len > 0) styles.push({ start: base + start, len, st });
  };

  while (i < line.length) {
    const rest = line.slice(i);

    // [color]…[/color]
    const color = matchColorTag(rest);
    if (color) {
      const inner = renderInline(color.inner, base + out.length);
      const start = out.length;
      out += inner.text;
      styles.push(...inner.styles);
      // Chỉ màu, không kèm đậm: chồng hai style lên cùng một đoạn tốn gấp đôi
      // ngân sách gói tin, mà màu một mình đã đủ nổi.
      push(start, inner.text.length, COLORS[color.name]);
      i += color.consumed;
      continue;
    }

    // [chữ](liên kết)
    const link = rest.match(/^\[([^\]\n]+)\]\(([^)\s]+)\)/);
    if (link) {
      const label = link[1];
      const url = link[2];
      const start = out.length;
      out += label;
      push(start, label.length, BOLD);
      out += ` (${url})`;
      i += link[0].length;
      continue;
    }

    // ~~gạch ngang~~
    const strike = rest.match(/^~~([\s\S]+?)~~/);
    if (strike) {
      const inner = renderInline(strike[1], base + out.length);
      const start = out.length;
      out += inner.text;
      styles.push(...inner.styles);
      push(start, inner.text.length, STRIKE);
      i += strike[0].length;
      continue;
    }

    // **đậm** hoặc __đậm__
    const bold = rest.match(/^(\*\*|__)([\s\S]+?)\1/);
    if (bold) {
      const inner = renderInline(bold[2], base + out.length);
      const start = out.length;
      out += inner.text;
      styles.push(...inner.styles);
      push(start, inner.text.length, BOLD);
      i += bold[0].length;
      continue;
    }

    // `mã` → in đậm cho nổi (Zalo không có kiểu chữ đơn cách)
    const code = rest.match(/^`([^`\n]+)`/);
    if (code) {
      const start = out.length;
      out += code[1];
      push(start, code[1].length, BOLD);
      i += code[0].length;
      continue;
    }

    // *nghiêng* hoặc _nghiêng_ — chỉ khi đứng ở ranh giới từ, để không phá
    // các tên biến kiểu snake_case hay phép nhân a*b
    const italic = rest.match(/^([*_])([^\s*_][^*_\n]*?)\1/);
    if (italic && isWordBoundary(line, i)) {
      const start = out.length;
      out += italic[2];
      push(start, italic[2].length, ITALIC);
      i += italic[0].length;
      continue;
    }

    out += line[i];
    i += 1;
  }

  return { text: out, styles };
}

function matchColorTag(rest) {
  for (const name of Object.keys(COLORS)) {
    const open = `[${name}]`;
    if (rest.slice(0, open.length).toLowerCase() !== open) continue;
    const closeIdx = rest.toLowerCase().indexOf(`[/${name}]`, open.length);
    if (closeIdx === -1) continue;
    return {
      name,
      inner: rest.slice(open.length, closeIdx),
      consumed: closeIdx + name.length + 3,
    };
  }
  return null;
}

function isWordBoundary(line, i) {
  if (i === 0) return true;
  return /[\s(["'—–-]/.test(line[i - 1]);
}
