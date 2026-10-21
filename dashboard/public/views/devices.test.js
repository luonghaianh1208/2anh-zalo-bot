import test from 'node:test';
import assert from 'node:assert/strict';
import { agoText } from './devices.js';

test('thời gian hoạt động tương đối', () => {
  const now = 10 * 24 * 3600_000;
  assert.equal(agoText(now - 20_000, now), 'vừa xong');
  assert.equal(agoText(now - 5 * 60_000, now), '5 phút trước');
  assert.equal(agoText(now - 3 * 3600_000, now), '3 giờ trước');
  assert.match(agoText(now - 2 * 24 * 3600_000, now), /\d/);
});
