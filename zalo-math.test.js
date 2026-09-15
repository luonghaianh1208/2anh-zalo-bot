import test from 'node:test';
import assert from 'node:assert/strict';
import { latexToUnicode } from './zalo-math.js';

test('chỉ số trên/dưới trong công thức đổi sang Unicode', () => {
  assert.equal(latexToUnicode('Ion $K^+$, $Na^+$, $Ca^{2+}$ và $H_2O$'), 'Ion K⁺, Na⁺, Ca²⁺ và H₂O');
  assert.equal(latexToUnicode('Diện tích x^2 + y^{10}'), 'Diện tích x² + y¹⁰');
  assert.equal(latexToUnicode('Khí CO_2 và SO_{4}^{2-}'), 'Khí CO₂ và SO₄²⁻');
});

test('mũi tên, toán tử so sánh và ký tự Hy Lạp', () => {
  assert.equal(latexToUnicode('$A \\rightarrow B \\Rightarrow C$'), 'A → B ⇒ C');
  assert.equal(latexToUnicode('$a \\le b$, $c \\ge d$, $e \\ne f$, $\\pm 2$, x \\approx 3'), 'a ≤ b, c ≥ d, e ≠ f, ± 2, x ≈ 3');
  assert.equal(latexToUnicode('$\\alpha, \\beta, \\Delta, \\mu$'), 'α, β, Δ, μ');
  assert.equal(latexToUnicode('Phản ứng \\(\\Delta H < 0\\)'), 'Phản ứng ΔH < 0');
});

test('phân số, căn, độ và chữ trong công thức', () => {
  assert.equal(latexToUnicode('$\\frac{1}{2}$ và $\\frac{a+b}{c}$'), '1/2 và (a+b)/c');
  assert.equal(latexToUnicode('$\\sqrt{x+1}$, $\\sqrt{2}$'), '√(x+1), √2');
  assert.equal(latexToUnicode('Nhiệt độ $25^\\circ C$'), 'Nhiệt độ 25° C');
  assert.equal(latexToUnicode('$$v = 3 \\cdot 10^8 \\text{ m/s}$$'), 'v = 3 · 10⁸  m/s');
});

test('không có ký tự Unicode tương ứng thì giữ dạng đọc được', () => {
  assert.equal(latexToUnicode('$x^{Q}$ và $y_{AB}$'), 'x^Q và y_(AB)');
});

test('mã, snake_case, giá tiền, email và tag giữ nguyên', () => {
  const untouched = [
    'Gọi `zalo_send_voice` với `x^2` nhé',
    '```\nconst a = b_2 ^ c;\n```',
    'Biến file_2 và user_id_3',
    'Giá $5 và $10, hoặc 50$',
    'Mail a_b@x.vn, @Lương Hải Anh Cnt',
    'https://example.com/a_2/b?x=1^2',
  ];
  for (const text of untouched) assert.equal(latexToUnicode(text), text, text);
});
