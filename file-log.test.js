import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installFileLog } from './file-log.js';

function tempLogPath(t) {
  const dir = mkdtempSync(join(tmpdir(), 'file-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'logs', 'sidecar.log');
}

function fakeConsole() {
  const printed = [];
  return {
    printed,
    log: (...args) => printed.push(['log', ...args]),
    info: (...args) => printed.push(['info', ...args]),
    warn: (...args) => printed.push(['warn', ...args]),
    error: (...args) => printed.push(['error', ...args]),
  };
}

test('log vẫn in ra terminal và được chép vào file kèm thời điểm, cấp độ', (t) => {
  const path = tempLogPath(t);
  const target = fakeConsole();
  const restore = installFileLog({ path, target });

  target.warn('[bot] mất kết nối', { code: 1006 });
  restore();
  target.warn('sau khi gỡ thì không chép nữa');

  assert.equal(target.printed.length, 2);
  assert.deepEqual(target.printed[0], ['warn', '[bot] mất kết nối', { code: 1006 }]);
  assert.match(
    readFileSync(path, 'utf8'),
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2} WARN \[bot\] mất kết nối \{ code: 1006 \}\n$/,
  );
});

test('file log vượt ngưỡng thì dời sang .1 rồi ghi tiếp file mới', (t) => {
  const path = tempLogPath(t);
  const target = fakeConsole();
  const restore = installFileLog({ path, target, maxBytes: 80 });

  target.log('dòng thứ nhất '.repeat(5));
  target.log('dòng thứ hai');
  restore();

  assert.ok(existsSync(`${path}.1`));
  assert.match(readFileSync(`${path}.1`, 'utf8'), /dòng thứ nhất/);
  assert.match(readFileSync(path, 'utf8'), /^\S+ \S+ LOG dòng thứ hai\n$/);
});
