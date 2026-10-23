import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActivityLog } from './activity-log.js';

test('ghi và đọc mới nhất trước, phân trang theo before', (t) => {
  const d = mkdtempSync(join(tmpdir(), 'zd-act-')); t.after(() => rmSync(d, { recursive: true, force: true }));
  let clock = 1000;
  const log = createActivityLog(join(d, 'a.jsonl'), { now: () => clock++ });
  log.append({ actor: 'anh', action: 'login', ok: true });
  log.append({ actor: 'khach', action: 'login', ok: false, detail: 'sai mật khẩu' });
  const all = log.list({});
  assert.deepEqual(all.map((e) => e.actor), ['khach', 'anh']);
  assert.deepEqual(log.list({ before: all[0].at }).map((e) => e.actor), ['anh']);
});

test('actor bị cắt ở 64 ký tự như detail ở 500', (t) => {
  const d = mkdtempSync(join(tmpdir(), 'zd-act-')); t.after(() => rmSync(d, { recursive: true, force: true }));
  const log = createActivityLog(join(d, 'a.jsonl'));
  const e = log.append({ actor: 'x'.repeat(5000), action: 'login', detail: 'y'.repeat(900) });
  assert.equal(e.actor.length, 64);
  assert.equal(e.detail.length, 500);
  assert.equal(log.list({})[0].actor.length, 64);
});

test('xoay vòng khi vượt dung lượng, vẫn đọc được bản cũ', (t) => {
  const d = mkdtempSync(join(tmpdir(), 'zd-act-')); t.after(() => rmSync(d, { recursive: true, force: true }));
  const p = join(d, 'a.jsonl');
  let clock = 2000;
  const log = createActivityLog(p, { maxBytes: 200, now: () => clock++ });
  for (let i = 0; i < 10; i++) log.append({ actor: 'a', action: `x${i}` });
  assert.ok(existsSync(`${p}.1`));
  assert.equal(log.list({ limit: 100 })[0].action, 'x9');
});

test('dòng hỏng, null hoặc thiếu at bị bỏ qua; limit không phải số dùng mặc định', (t) => {
  const d = mkdtempSync(join(tmpdir(), 'zd-act-')); t.after(() => rmSync(d, { recursive: true, force: true }));
  const file = join(d, 'a.jsonl');
  writeFileSync(file, 'null\n"chuỗi"\n{hỏng\n{"actor":"x"}\n{"at":5,"actor":"anh","action":"login","ok":true}\n');
  const log = createActivityLog(file);
  assert.deepEqual(log.list({}).map((e) => e.actor), ['anh']);
  assert.equal(log.list({ limit: Number.NaN }).length, 1);
  assert.equal(log.list({ limit: 'abc' }).length, 1);
});

test('prune xoá dòng cũ ở cả tệp xoay vòng, giữ dòng mới', (t) => {
  const d = mkdtempSync(join(tmpdir(), 'zd-act-')); t.after(() => rmSync(d, { recursive: true, force: true }));
  const p = join(d, 'a.jsonl');
  let clock = 1000;
  const log = createActivityLog(p, { now: () => clock });
  log.append({ actor: 'a', action: 'login' });
  writeFileSync(`${p}.1`, `${JSON.stringify({ at: 500, actor: 'cu', action: 'login', ok: true })}\n`);
  clock = 3000;
  log.append({ actor: 'b', action: 'login' });
  assert.equal(log.prune(2000), 2);
  assert.deepEqual(log.list({}).map((e) => e.actor), ['b']);
  assert.equal(existsSync(`${p}.1`), false);
  assert.equal(log.prune(2000), 0);
});
