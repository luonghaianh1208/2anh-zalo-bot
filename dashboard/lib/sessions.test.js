import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore } from './sessions.js';

function mk(t, clock) { const d = mkdtempSync(join(tmpdir(), 'zd-sess-')); t.after(() => rmSync(d, { recursive: true, force: true }));
  const file = join(d, 's.json'); return { file, s: createSessionStore(file, { now: () => clock.t, ttlMs: 1000, idleMs: 300 }) }; }

test('tạo và đọc phiên; tệp chỉ lưu băm', (t) => {
  const clock = { t: 0 }; const { s, file } = mk(t, clock);
  const token = s.create('anh');
  assert.equal(s.get(token).username, 'anh');
  assert.ok(!readFileSync(file, 'utf8').includes(token));
});

test('hết hạn khi không hoạt động và hết hạn tuyệt đối', (t) => {
  const clock = { t: 0 }; const { s } = mk(t, clock);
  const a = s.create('anh');
  clock.t = 200; assert.ok(s.get(a));          // còn hoạt động, gia hạn idle
  clock.t = 450; assert.ok(s.get(a));
  clock.t = 800; assert.equal(s.get(a), null); // quá idle 300 kể từ lần cuối (450)
  const b = s.create('anh');                    // tạo lúc 800
  for (const x of [900, 1100, 1300, 1500, 1700, 1790]) { clock.t = x; assert.ok(s.get(b)); } // luôn hoạt động
  clock.t = 1850; assert.equal(s.get(b), null); // idle chỉ 60 nhưng quá ttl 1000 tính từ lúc tạo (800)
});

test('đăng xuất mọi nơi', (t) => {
  const clock = { t: 0 }; const { s } = mk(t, clock);
  const a = s.create('anh'); const b = s.create('anh'); const c = s.create('khach');
  s.destroyAll('anh');
  assert.equal(s.get(a), null); assert.equal(s.get(b), null); assert.ok(s.get(c));
});

test('reset-admin (tiến trình khác) gỡ phiên thì dashboard đang chạy cũng mất phiên, không làm sống lại', (t) => {
  const clock = { t: 0 }; const { s: server, file } = mk(t, clock);
  const opts = { now: () => clock.t, ttlMs: 1000, idleMs: 300 };
  const a = server.create('anh'); const b = server.create('anh'); const k = server.create('khach');
  assert.ok(server.get(a));
  const cli = createSessionStore(file, opts); // như dashboard:reset-admin
  cli.destroyAll('anh');
  assert.equal(server.get(a), null);
  assert.equal(server.get(b), null);
  assert.ok(server.get(k));
  // Server ghi tiếp (tạo phiên mới, flush) không được hồi sinh phiên đã gỡ.
  const c = server.create('khach');
  clock.t = 100; server.get(c);
  const fresh = createSessionStore(file, opts);
  assert.equal(fresh.get(a), null);
  assert.equal(fresh.get(b), null);
  assert.ok(fresh.get(c));
  assert.ok(fresh.get(k));
});

test('phiên do tiến trình khác tạo được thấy ngay', (t) => {
  const clock = { t: 0 }; const { s: server, file } = mk(t, clock);
  server.get('chua-co');
  const other = createSessionStore(file, { now: () => clock.t, ttlMs: 1000, idleMs: 300 });
  const tok = other.create('anh');
  assert.equal(server.get(tok).username, 'anh');
});

test('phiên còn sống qua khởi động lại (đọc lại từ tệp)', (t) => {
  const clock = { t: 0 }; const { s, file } = mk(t, clock);
  const a = s.create('anh');
  const again = createSessionStore(file, { now: () => clock.t, ttlMs: 1000, idleMs: 300 });
  assert.equal(again.get(a).username, 'anh');
});

test('danh sách thiết bị: nhãn, IP mới nhất, đăng xuất theo mã chỉ trong tài khoản', (t) => {
  const clock = { t: 0 }; const { s, file } = mk(t, clock);
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
  const a = s.create('anh', { ua, ip: '1.2.3.4', method: 'mã Zalo' });
  clock.t = 10; const b = s.create('anh', { ua: 'curl/8', ip: '5.6.7.8', method: 'mật khẩu' });
  const k = s.create('khach');
  clock.t = 20; const idA = s.get(a, '9.9.9.9').id;
  const list = s.list('anh');
  assert.deepEqual(list.map((x) => x.id), [idA, s.get(b).id]);
  assert.equal(list[0].device.label, 'Safari · iPhone');
  assert.equal(list[0].device.mobile, true);
  assert.equal(list[0].ip, '9.9.9.9');
  assert.equal(list[0].method, 'mã Zalo');
  assert.equal(s.list().length, 3);
  assert.ok(!readFileSync(file, 'utf8').includes(idA)); // mã công khai không nằm trong tệp, không lộ khoá
  assert.equal(s.destroyById(idA, 'khach'), null);   // tài khoản khác không gỡ được
  assert.ok(s.get(a));
  assert.deepEqual(s.destroyById(idA, 'anh'), { username: 'anh', device: 'Safari · iPhone' });
  assert.equal(s.get(a), null);
  assert.ok(s.get(b) && s.get(k));
  assert.equal(s.destroyById('khong-co'), null);
});

test('phiên cũ không có thông tin thiết bị vẫn hiện và gỡ được', (t) => {
  const clock = { t: 0 }; const { s, file } = mk(t, clock);
  const tok = s.create('anh');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  for (const v of Object.values(raw.sessions)) { delete v.ua; delete v.ip; delete v.method; }
  writeFileSync(file, JSON.stringify(raw));
  const fresh = createSessionStore(file, { now: () => clock.t, ttlMs: 1000, idleMs: 300 });
  const [only] = fresh.list('anh');
  assert.equal(only.device.label, 'Thiết bị không rõ');
  assert.ok(fresh.destroyById(only.id));
  assert.equal(fresh.get(tok), null);
});
