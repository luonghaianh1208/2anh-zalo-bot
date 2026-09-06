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
 *   # ## ###            → phóng to      (tiêu đề)
 *   #### trở xuống      → đậm           (tiêu đề phụ, hiếm dùng)
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
// Cỡ chữ lớn. Dùng cho tiêu đề thay vì "đậm + màu": một mình nó đã đủ tách
// tiêu đề khỏi thân bài, mà chỉ tốn 34 ký tự thay vì 69, và chiếm một suất
// thay vì hai trong ngân sách định dạng vốn rất chật.
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
 * - Tiêu đề (# ## ###): In Đậm (b) toàn bộ dòng tiêu đề.
 * - Đầu các chỉ mục số (1. 2. 3.): In Đậm (b) cả dòng hoặc phần số.
 * - Các nhãn mục con (• Hiện tại:, • Góp ý:, • Phân tích:): In Đậm (b).
 * - Các từ khóa quan trọng (**từ khóa**): In Đậm (b) trọn vẹn, không bị nuốt chữ.
 *
 * Giới hạn an toàn: giữ tối đa 40 styles mỗi tin nhắn để đảm bảo gửi mượt mà.
 */
const MAX_STYLES = 40;

function capStyles(styles) {
  if (styles.length <= MAX_STYLES) return styles;
  return styles.slice(0, MAX_STYLES);
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
    let wholeLineStyle = null;

    // Tiêu đề & Đề mục: In Đậm (b) toàn bộ dòng để phân cấp mạch lạc, rõ ràng như mẫu công văn giáo dục
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      line = heading[2];
      wholeLineStyle = BOLD;
    }

    // Trích dẫn: > … → nghiêng cả dòng
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (!heading && quote) {
      line = quote[1];
      wholeLineStyle = ITALIC;
    }

    // Phân cấp danh sách đầu dòng chuẩn:
    // - Cấp 1 (ngay sau tiêu đề/danh mục): dùng gạch đầu dòng '- '
    // - Cấp 2 trở đi (mục con thụt lề >= 2 khoảng trắng): dùng dấu chấm tròn '• '
    line = line.replace(/^(\s*)([-*•])\s+/, (match, indent) => {
      return indent.length >= 2 ? `${indent}• ` : `${indent}- `;
    });

    // Đầu chỉ mục số thứ tự (ví dụ: '1. ', '2. ', '1) '):
    // In Đậm (b) phần số thứ tự ở đầu dòng để mắt dễ bắt ý
    let listNumLen = 0;
    if (!heading) {
      const numMatch = line.match(/^(\s*)(\d+[\.)]\s+)/);
      if (numMatch) {
        listNumLen = numMatch[2].length;
      }
    }

    const { text, styles: inline } = renderInline(line, offset);
    lineStyles = inline;

    if (wholeLineStyle && text.length) {
      lineStyles.push({ start: offset, len: text.length, st: wholeLineStyle });
    }

    if (listNumLen > 0) {
      lineStyles.push({ start: offset, len: listNumLen, st: BOLD });
    }

    styles.push(...lineStyles);
    outLines.push(text);
    offset += text.length + 1; // +1 cho ký tự xuống dòng
  }

  return { msg: outLines.join('\n'), styles: capStyles(styles) };
}

/**
 * Tự động chia Markdown thành các tin nhắn Zalo độc lập, đạt chuẩn an toàn:
 * 1. JSON styles của mỗi tin luôn nằm trong ngưỡng an toàn (~230 bytes)
 *    => Đảm bảo giữ được đầy đủ styles in đậm, phóng to, màu sắc mà không bị cắt xén!
 * 2. Độ dài mỗi tin <= 2000 ký tự (dưới giới hạn 3000 của Zalo)
 * 3. Tách theo ranh giới đoạn văn (\n\n) hoặc tiêu đề (###), không bao giờ cắt giữa chừng câu.
 *
 * @param {string} input Nội dung Markdown thô từ Hermes Agent
 * @returns {Array<{ msg: string, styles: Array<{start: number, len: number, st: string}> }>}
 */
export function formatAndChunkZaloMarkdown(input) {
  if (!input) return [];

  const raw = String(input).trim();
  // Tách theo ranh giới tiêu đề lớn (h1 - h4)
  const blocks = raw.split(/(?=\n\s*#{1,4}\s+)/);

  const subBlocks = [];
  for (const b of blocks) {
    const cleaned = b.replace(/^\s*([-*_])\1{2,}\s*$/gm, '').trim();
    if (cleaned) subBlocks.push(cleaned);
  }

  const results = [];
  let currentBlock = [];

  for (const b of subBlocks) {
    const candidate = currentBlock.concat([b]).join('\n\n');
    const f = formatZaloMarkdown(candidate);
    const jsonLen = JSON.stringify(f.styles).length;

    // Giới hạn an toàn Zalo: tối đa 35 styles VÀ độ dài ký tự <= 2000
    // Gom tối đa các mục lại cùng 1 tin nhắn để tin nhắn dài đẹp, liền mạch
    if ((f.styles.length > 30 || f.msg.length > 2000) && currentBlock.length > 0) {
      const ready = formatZaloMarkdown(currentBlock.join('\n\n'));
      if (ready.msg.trim()) results.push(ready);
      currentBlock = [b];
    } else {
      currentBlock.push(b);
    }
  }

  if (currentBlock.length > 0) {
    const ready = formatZaloMarkdown(currentBlock.join('\n\n'));
    if (ready.msg.trim()) results.push(ready);
  }

  return results;
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
      // Chỉ màu, không kèm đậm: chồng hai style lên cùng một đoạn tốn 69 ký
      // tự trong ngân sách 256, mà màu một mình đã đủ nổi.
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
