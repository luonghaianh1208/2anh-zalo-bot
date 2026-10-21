import test from 'node:test';
import assert from 'node:assert/strict';
import { describeUserAgent } from './user-agent.js';

test('nhãn thiết bị từ User-Agent phổ biến', () => {
  const cases = [
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'Chrome · Windows', false],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0', 'Edge · Windows', false],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 'Safari · iPhone', true],
    ['Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36', 'Samsung Internet · Android', true],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 'Safari · macOS', false],
    ['Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 Zalo android/12345', 'Zalo · Android', true],
  ];
  for (const [ua, label, mobile] of cases) assert.deepEqual(describeUserAgent(ua), { label, mobile }, ua);
});

test('User-Agent trống hoặc lạ', () => {
  assert.deepEqual(describeUserAgent(''), { label: 'Thiết bị không rõ', mobile: false });
  assert.deepEqual(describeUserAgent('curl/8.4.0'), { label: 'Thiết bị không rõ', mobile: false });
});
