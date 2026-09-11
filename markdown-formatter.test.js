import test from 'node:test';
import assert from 'node:assert/strict';

import { formatAndChunkZaloMarkdown, formatZaloMarkdown } from './markdown-formatter.js';

const MAX_STYLES = 40;
const MAX_CHARS = 2000;
const MAX_PAYLOAD_BYTES = 3000;

function payloadBytes(chunk) {
  return Buffer.byteLength(chunk.msg, 'utf8') + JSON.stringify(chunk.styles).length;
}

function assertWithinBudget(chunks) {
  assert.ok(chunks.length > 0, 'phải có ít nhất một chunk');
  for (const chunk of chunks) {
    assert.ok(chunk.msg.length <= MAX_CHARS, `chunk dài ${chunk.msg.length} ký tự`);
    assert.ok(chunk.styles.length <= MAX_STYLES, `chunk có ${chunk.styles.length} styles`);
    assert.ok(payloadBytes(chunk) <= MAX_PAYLOAD_BYTES, `chunk nặng ${payloadBytes(chunk)} byte`);
  }
}

test('formatAndChunkZaloMarkdown tách tin tiếng Việt nhiều emoji + in đậm theo ngân sách byte', () => {
  // Tái hiện thông báo thật bị Zalo từ chối bằng "Lỗi không xác định": chưa tới
  // 2000 ký tự và 40 style, nhưng chữ có dấu + emoji + JSON style vượt 3000 byte.
  const block = (n) => [
    `${n}. 📝 **Vòng ${n} - Vòng thi chính thức (01/09 – 15/10/2026):**`,
    '- **Nội dung:** Thí sinh đăng ký cá nhân hoặc nhóm hai bạn, nộp bài luận ngắn trả lời câu hỏi về tương lai xanh của mình 🌏💚 qua trang web chính thức của Ban Tổ chức.',
    '',
  ].join('\n');
  const input = `# THÔNG TIN CHI TIẾT CÁC VÒNG THI\n\n${Array.from({ length: 8 }, (_, i) => block(i + 1)).join('\n')}`;
  const whole = formatZaloMarkdown(input.trim());
  assert.ok(whole.msg.length <= MAX_CHARS && whole.styles.length <= MAX_STYLES, 'dữ liệu test phải lọt giới hạn cũ');
  assert.ok(payloadBytes(whole) > MAX_PAYLOAD_BYTES, 'dữ liệu test phải vượt ngân sách byte');

  const chunks = formatAndChunkZaloMarkdown(input);

  assert.ok(chunks.length >= 2);
  assertWithinBudget(chunks);
  assert.equal(chunks.map((chunk) => chunk.msg).join(''), whole.msg);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.styles.length, 0), whole.styles.length);
});

test('formatZaloMarkdown giữ đầy đủ styles, không cắt ở 40', () => {
  const input = Array.from({ length: 45 }, (_, i) => `**mục ${i + 1}**`).join('\n');
  const formatted = formatZaloMarkdown(input);

  assert.equal(formatted.styles.length, 45);
});

test('formatAndChunkZaloMarkdown tách theo style budget và giữ đủ style', () => {
  const input = Array.from({ length: 85 }, (_, i) => `**mục ${i + 1}**`).join('\n');
  const chunks = formatAndChunkZaloMarkdown(input);

  assertWithinBudget(chunks);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.styles.length, 0), 85);
  assert.equal(chunks.map((chunk) => chunk.msg).join('\n').includes('mục 85'), true);
});

test('formatZaloMarkdown phóng to và in đậm tiêu đề/chỉ mục', () => {
  const formatted = formatZaloMarkdown('# Tiêu đề\n1. Nội dung');
  const headingStyles = formatted.styles.filter((style) => style.start === 0 && style.len === 'Tiêu đề'.length);
  const listStyles = formatted.styles.filter((style) => style.start === 'Tiêu đề\n'.length && style.len === '1. '.length);

  assert.equal(headingStyles.length, 2);
  assert.equal(listStyles.length, 2);
});

test('formatAndChunkZaloMarkdown tách dòng dài theo character budget', () => {
  const chunks = formatAndChunkZaloMarkdown('a'.repeat(4500));

  assertWithinBudget(chunks);
  assert.equal(chunks.map((chunk) => chunk.msg).join(''), 'a'.repeat(4500));
});

test('formatAndChunkZaloMarkdown giữ style offset đúng trong từng chunk', () => {
  const input = Array.from({ length: 45 }, (_, i) => `**mục ${i + 1}**`).join('\n');
  const chunks = formatAndChunkZaloMarkdown(input);

  assertWithinBudget(chunks);
  for (const chunk of chunks) {
    for (const style of chunk.styles) {
      assert.ok(style.start >= 0);
      assert.ok(style.len > 0);
      assert.ok(style.start + style.len <= chunk.msg.length);
      assert.notEqual(chunk.msg.slice(style.start, style.start + style.len).trim(), '');
    }
  }
});

test('formatAndChunkZaloMarkdown xử lý inline markdown dày đặc không có khoảng trắng', () => {
  const chunks = formatAndChunkZaloMarkdown('**x**'.repeat(85));

  assertWithinBudget(chunks);
  assert.equal(chunks.map((chunk) => chunk.msg).join(''), 'x'.repeat(85));
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.styles.length, 0), 85);
});

test('formatAndChunkZaloMarkdown không rò delimiter khi bold span dài bị chia chunk', () => {
  const text = 'a'.repeat(4500);
  const chunks = formatAndChunkZaloMarkdown(`**${text}**`);

  assertWithinBudget(chunks);
  assert.equal(chunks.map((chunk) => chunk.msg).join(''), text);
  assert.equal(chunks.some((chunk) => chunk.msg.includes('**')), false);
  assert.equal(chunks.every((chunk) => chunk.styles.length === 1), true);
});

test('formatAndChunkZaloMarkdown giữ nội dung code block như plain text khi bị chia chunk', () => {
  const codeLine = '# không là heading\n**không in đậm**\n';
  const chunks = formatAndChunkZaloMarkdown(`\`\`\`\n${codeLine.repeat(90)}\`\`\``);

  assertWithinBudget(chunks);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.styles.length, 0), 0);
  assert.equal(chunks.map((chunk) => chunk.msg).join('').includes('# không là heading'), true);
  assert.equal(chunks.map((chunk) => chunk.msg).join('').includes('**không in đậm**'), true);
});

test('formatZaloMarkdown đặt style đúng vào số thứ tự khi list có thụt dòng', () => {
  const formatted = formatZaloMarkdown('  1. Nội dung');
  const listStyles = formatted.styles.filter((style) => style.len === '1. '.length);

  assert.equal(listStyles.length, 2);
  assert.equal(listStyles.every((style) => formatted.msg.slice(style.start, style.start + style.len) === '1. '), true);
});
