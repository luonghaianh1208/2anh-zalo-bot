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
 * Zalo giới hạn KÍCH THƯỚC của mảng định dạng, khoảng 256 ký tự JSON.
 *
 * Vượt quá thì API trả về "Lỗi không xác định" — không nhắc gì tới style, nên
 * rất dễ đi tìm nhầm chỗ. Đo trên tài khoản thật:
 *
 *     8 style in đậm ngắn  → 256 ký tự JSON → gửi được
 *     7 style thật của bài → 237            → gửi được
 *     8 style thật của bài → 277            → HỎNG
 *     9 style in đậm ngắn  → 288            → HỎNG
 *
 * Nên đây không phải giới hạn theo số lượng: style màu (`c_f27806`) tốn chỗ
 * gấp tám lần in đậm (`b`), và đoạn càng dài thì con số càng nhiều chữ số.
 * Đếm số style sẽ lúc đúng lúc sai, đo bằng chính chuỗi gửi đi mới chắc.
 *
 * Vì sao chuyện này quan trọng: một câu trả lời bình thường của Hermes sinh
 * ra 30–50 style. Không cắt bớt thì gần như MỌI câu trả lời có định dạng đều
 * không gửi nổi — bot đọc xong, soạn xong, rồi im lặng, và trong nhóm chỉ
 * thấy nó bị tag mà không nói gì.
 *
 * Giữ lại theo mức quan trọng chứ không cắt bừa từ cuối: tiêu đề (cỡ chữ) giữ
 * cấu trúc bài, màu do người dùng tự đánh dấu là chỗ họ muốn nhấn, in đậm giữ
 * từ khoá, còn nghiêng với gạch ngang chỉ là gia vị. Phần bị bỏ vẫn hiện thành
 * chữ thường — mất định dạng chứ không mất nội dung.
 */
const STYLE_BUDGET = 240;   // chừa chỗ so với ngưỡng đo được (~256)

function capStyles(styles) {
  if (JSON.stringify(styles).length <= STYLE_BUDGET) return styles;

  const rank = (s) => {
    if (s.st && s.st.startsWith('f_')) return 0;   // tiêu đề (cỡ chữ)
    if (s.st && s.st.startsWith('c_')) return 1;   // màu, khi người dùng tự đánh dấu
    if (s.st === 'b') return 2;                    // in đậm
    if (s.st === 's') return 3;                    // gạch ngang
    return 4;                                      // nghiêng và phần còn lại
  };

  const byImportance = styles
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i);

  const kept = [];
  for (const item of byImportance) {
    const next = [...kept, item];
    if (JSON.stringify(next.map((x) => x.s)).length > STYLE_BUDGET) continue;
    kept.push(item);
  }
  return kept.sort((a, b) => a.i - b.i).map((x) => x.s);
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

    // Tiêu đề: # ## ### → đậm + phóng to, #### trở xuống → chỉ đậm.
    //
    // Hai style chồng lên nhau (b + f_18) = 65 ký tự, gấp đôi một style.
    // Ngân sách định dạng ~256, nên bài 5 tiêu đề sẽ mất hết in đậm trong
    // phần thân. Nhưng tiêu đề được ưu tiên giữ (xếp hạng cao nhất trong
    // capStyles), nên phần thân mới bị cắt — đánh đổi đáng giá vì tiêu đề
    // to+đậm dễ đọc hơn nhiều so với từ khoá in đậm trong câu.
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    let isHeadingBig = false;
    if (heading) {
      line = heading[2];
      if (heading[1].length <= 3) {
        isHeadingBig = true;   // sẽ gán cả b và f_18 sau khi có text.length
      } else {
        wholeLineStyle = BOLD;
      }
    }

    // Trích dẫn: > … → nghiêng cả dòng
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (!heading && quote) {
      line = quote[1];
      wholeLineStyle = ITALIC;
    }

    // Gạch đầu dòng: -, * → •  (giữ nguyên thụt lề)
    line = line.replace(/^(\s*)[-*]\s+/, '$1• ');

    // Đầu chỉ mục số thứ tự (ví dụ: '1. ', '2. ', '1) '):
    // Nhận diện phần số ở đầu dòng để định dạng ĐẬM + PHÓNG TO (b + f_18)
    // Giúp các mục số nổi bật, mắt dễ lướt bắt ý ngay lập tức.
    let listNumLen = 0;
    if (!heading) {
      const numMatch = line.match(/^(\s*)(\d+[\.)]\s+)/);
      if (numMatch) {
        listNumLen = numMatch[2].length;
      }
    }

    const { text, styles: inline } = renderInline(line, offset);
    lineStyles = inline;

    if (isHeadingBig && text.length) {
      // Đậm + phóng to: hai style cho cùng một dòng tiêu đề.
      lineStyles.push({ start: offset, len: text.length, st: BOLD });
      lineStyles.push({ start: offset, len: text.length, st: BIG });
    } else if (wholeLineStyle && text.length) {
      lineStyles.push({ start: offset, len: text.length, st: wholeLineStyle });
    }

    if (listNumLen > 0) {
      // Đầu chỉ mục số: áp dụng ĐẬM + PHÓNG TO riêng cho phần số thứ tự
      lineStyles.push({ start: offset, len: listNumLen, st: BOLD });
      lineStyles.push({ start: offset, len: listNumLen, st: BIG });
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
  // Tách theo ranh giới tiêu đề hoặc dòng phân đoạn Markdown
  const blocks = raw.split(/(?=\n\s*(?:#{1,6}\s+|---+\s*\n))/);

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

    // Ngưỡng: Nếu thêm b mà làm styles vượt quá ngân sách (220 bytes) hoặc vượt 1600 ký tự
    // Thì tách tin ngay để giữ trọn vẹn cả ĐẬM + PHÓNG TO cho mọi tiêu đề!
    if ((jsonLen > 220 || f.msg.length > 1600) && currentBlock.length > 0) {
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
