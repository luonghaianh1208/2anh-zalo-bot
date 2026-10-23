import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCall, priceRows, priceSentence, shortPrice, vnd } from './model-price.js';
import { fold } from './fold.js';

const flash = { unit: 'token', currency: 'VND', input: 2000, output: 2000, min: 50 };
const opus = { unit: 'token', currency: 'VND', input: 25500, output: 25500, min: 600, name: 'Claude Opus' };
const req = { unit: 'request', currency: 'VND', perRequest: 300, name: 'GPT 5.5' };

test('ước tính một lượt gọi AI: theo token (không dưới mức tối thiểu) và theo lượt', () => {
  assert.equal(Math.round(estimateCall(flash)), 51); // 25.000 × 2.000 + 600 × 2.000 trên 1 triệu
  assert.equal(estimateCall({ ...flash, min: 500 }), 500);
  assert.equal(estimateCall(req), 300);
  assert.equal(estimateCall(null), null);
});

test('nhãn giá ngắn và câu giải thích', () => {
  assert.equal(vnd(2000).replace(/\s/g, ''), '2.000đ');
  assert.match(shortPrice(flash), /2\.000đ\/1tr token/);
  assert.match(shortPrice({ ...flash, output: 8000 }), /^vào 2\.000đ · ra 8\.000đ/);
  assert.equal(shortPrice(req), '300đ/lượt');
  assert.match(priceSentence(flash), /tối thiểu 50đ\/lượt — ≈ 51đ mỗi lượt gọi AI/);
  assert.equal(shortPrice(null), '');
});

test('bảng giá: rẻ trước, lọc không dấu theo mã và tên', () => {
  const rows = priceRows({ 'claude-opus': opus, 'deepseek-v4.1-flash': flash, 'req-gpt-5.5': req }, { fold });
  assert.deepEqual(rows.map((r) => r.id), ['deepseek-v4.1-flash', 'req-gpt-5.5', 'claude-opus']);
  assert.deepEqual(priceRows({ 'claude-opus': opus, 'deepseek-v4.1-flash': flash }, { q: 'claude', fold }).map((r) => r.id), ['claude-opus']);
});
