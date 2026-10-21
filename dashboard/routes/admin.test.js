import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeps, startApp, loginAs } from '../test-helpers.js';

test('Chủ bot không gọi được route Quản trị', async (t) => {
  const deps = makeDeps(t); const { call } = await startApp(t, deps);
  const cookie = await loginAs(t, deps, call, { username: 'khach', role: 'owner' });
  for (const [method, path] of [['GET', '/api/admin/users'], ['POST', '/api/admin/users'], ['PATCH', '/api/admin/users/khach'], ['POST', '/api/admin/restart-assistant'], ['GET', '/api/admin/telegram']]) {
    assert.equal((await call(path, { method, cookie, body: method === 'GET' ? undefined : {} })).status, 403, `${method} ${path}`);
  }
});

test('Quản trị tạo Chủ bot, khoá thì phiên của người đó mất', async (t) => {
  const deps = makeDeps(t); const { call } = await startApp(t, deps);
  const admin = await loginAs(t, deps, call);
  const created = await call('/api/admin/users', { method: 'POST', cookie: admin, body: { username: 'Khach', role: 'owner', password: 'matkhau-dai' } });
  assert.equal(created.status, 200);
  assert.equal(created.json.user.username, 'khach');
  assert.equal(JSON.stringify(created.json).includes('passwordHash'), false);
  const khach = (await call('/api/auth/verify', { method: 'POST', body: { username: 'khach', password: 'matkhau-dai' } })).cookie;
  assert.equal((await call('/api/me', { cookie: khach })).status, 200);
  assert.equal((await call('/api/admin/users/khach', { method: 'PATCH', cookie: admin, body: { disabled: true } })).status, 200);
  assert.equal((await call('/api/me', { cookie: khach })).status, 401);
  const list = await call('/api/admin/users', { cookie: admin });
  assert.equal(list.json.users.length, 2);
  assert.equal(JSON.stringify(list.json).includes('passwordHash'), false);
  const actions = deps.activity.list().map((e) => `${e.actor}:${e.action}`);
  assert.ok(actions.includes('anh:user_create') && actions.includes('anh:user_update'));
});

test('không tự khoá, không tự hạ quyền', async (t) => {
  const deps = makeDeps(t); const { call } = await startApp(t, deps);
  const admin = await loginAs(t, deps, call);
  const a = await call('/api/admin/users/anh', { method: 'PATCH', cookie: admin, body: { disabled: true } });
  assert.equal(a.status, 400);
  assert.equal(a.json.error, 'Không thể tự khoá/hạ quyền tài khoản đang dùng — nhờ một Quản trị khác thực hiện.');
  assert.equal((await call('/api/admin/users/anh', { method: 'PATCH', cookie: admin, body: { role: 'owner' } })).status, 400);
  assert.equal(deps.users.get('anh').role, 'admin');
});

test('sửa UID/vai trò ngay trong bảng: đúng dạng body giao diện gửi; tự sửa UID của mình được', async (t) => {
  const deps = makeDeps(t); const { call } = await startApp(t, deps);
  const admin = await loginAs(t, deps, call);
  deps.users.create({ username: 'khach', role: 'owner', password: 'matkhau-dai' });
  const r = await call('/api/admin/users/khach', { method: 'PATCH', cookie: admin, body: { zaloUid: '2234567890123456', role: 'admin' } });
  assert.equal(r.status, 200);
  assert.equal(deps.users.get('khach').zaloUid, '2234567890123456');
  assert.equal(deps.users.get('khach').role, 'admin');
  assert.equal((await call('/api/admin/users/khach', { method: 'PATCH', cookie: admin, body: { zaloUid: '' } })).status, 200);
  assert.equal(deps.users.get('khach').zaloUid, '');
  assert.equal((await call('/api/admin/users/khach', { method: 'PATCH', cookie: admin, body: { zaloUid: '0123' } })).status, 400);
  // Tự sửa: giao diện chỉ gửi zaloUid (không gửi role) → được; gửi role owner → vẫn bị chặn.
  assert.equal((await call('/api/admin/users/anh', { method: 'PATCH', cookie: admin, body: { zaloUid: '3234567890123456' } })).status, 200);
  assert.equal(deps.users.get('anh').zaloUid, '3234567890123456');
  assert.equal((await call('/api/admin/users/anh', { method: 'PATCH', cookie: admin, body: { zaloUid: '3234567890123456', role: 'owner' } })).status, 400);
  assert.equal(deps.users.get('anh').role, 'admin');
});

test('có Quản trị khác thì hạ được; vẫn còn Quản trị đang bật', async (t) => {
  const deps = makeDeps(t); const { call } = await startApp(t, deps);
  const admin = await loginAs(t, deps, call);
  deps.users.create({ username: 'admin2', role: 'admin', password: 'matkhau-dai' });
  assert.equal((await call('/api/admin/users/admin2', { method: 'PATCH', cookie: admin, body: { role: 'owner' } })).status, 200);
  assert.equal(deps.users.get('admin2').role, 'owner');
  assert.equal(deps.users.hasAdmin(), true);
});

test('đổi mật khẩu bằng PATCH gỡ phiên; mật khẩu yếu bị 400; người lạ 404', async (t) => {
  const deps = makeDeps(t); const { call } = await startApp(t, deps);
  const admin = await loginAs(t, deps, call);
  deps.users.create({ username: 'khach', role: 'owner', password: 'matkhau-dai' });
  const khach = (await call('/api/auth/verify', { method: 'POST', body: { username: 'khach', password: 'matkhau-dai' } })).cookie;
  assert.equal((await call('/api/admin/users/khach', { method: 'PATCH', cookie: admin, body: { password: 'ngan' } })).status, 400);
  assert.equal((await call('/api/me', { cookie: khach })).status, 200);
  assert.equal((await call('/api/admin/users/khach', { method: 'PATCH', cookie: admin, body: { password: 'matkhau-moi-1' } })).status, 200);
  assert.equal((await call('/api/me', { cookie: khach })).status, 401);
  assert.equal(deps.users.verifyPassword('khach', 'matkhau-moi-1'), true);
  assert.equal((await call('/api/admin/users/khongco', { method: 'PATCH', cookie: admin, body: { disabled: true } })).status, 404);
});

test('tạo trùng tên 400 (không phân biệt hoa thường); PATCH tên viết hoa được chuẩn hoá', async (t) => {
  const deps = makeDeps(t); const { call } = await startApp(t, deps);
  const admin = await loginAs(t, deps, call);
  assert.equal((await call('/api/admin/users', { method: 'POST', cookie: admin, body: { username: 'ANH', role: 'owner' } })).status, 400);
  deps.users.create({ username: 'khach', role: 'owner' });
  assert.equal((await call('/api/admin/users/KHACH', { method: 'PATCH', cookie: admin, body: { zaloUid: '1234567890123456' } })).status, 200);
  assert.equal(deps.users.get('khach').zaloUid, '1234567890123456');
});

test('khởi động lại trợ lý: gọi deps, ghi nhật ký; lỗi 5xx không lộ chi tiết', async (t) => {
  let n = 0;
  const deps = makeDeps(t, { restartAssistant: async () => { n++; } });
  const { call } = await startApp(t, deps);
  const admin = await loginAs(t, deps, call);
  assert.equal((await call('/api/admin/restart-assistant', { method: 'POST', cookie: admin, body: {} })).status, 200);
  assert.equal(n, 1);
  assert.ok(deps.activity.list().some((e) => e.action === 'restart_assistant' && e.actor === 'anh'));

  const deps2 = makeDeps(t, { restartAssistant: async () => { throw new Error('spawn ENOENT secret/path'); } });
  const { call: call2 } = await startApp(t, deps2);
  const admin2 = await loginAs(t, deps2, call2);
  const orig = console.error; console.error = () => {};
  let res;
  try { res = await call2('/api/admin/restart-assistant', { method: 'POST', cookie: admin2, body: {} }); } finally { console.error = orig; }
  assert.equal(res.status, 500);
  assert.ok(!res.json.error.includes('secret'));
});

test('disabled/role sai kiểu bị 400, không bypass chặn tự khoá, không áp dụng nửa chừng', async (t) => {
  const deps = makeDeps(t); const { call } = await startApp(t, deps);
  const admin = await loginAs(t, deps, call);
  deps.users.create({ username: 'khach', role: 'owner', password: 'matkhau-dai' });
  for (const bad of ['true', 1, 'false']) {
    assert.equal((await call('/api/admin/users/anh', { method: 'PATCH', cookie: admin, body: { disabled: bad } })).status, 400);
  }
  assert.equal(deps.users.get('anh').disabled, false);
  assert.equal((await call('/api/admin/users/khach', { method: 'PATCH', cookie: admin, body: { role: 'root' } })).status, 400);
  // mật khẩu xấu: không áp dụng disabled
  assert.equal((await call('/api/admin/users/khach', { method: 'PATCH', cookie: admin, body: { disabled: true, password: 'ngan' } })).status, 400);
  assert.equal(deps.users.get('khach').disabled, false);
  assert.equal((await call('/api/admin/users/khach', { method: 'PATCH', cookie: admin, body: { disabled: true, zaloUid: 'abc' } })).status, 400);
  assert.equal(deps.users.get('khach').disabled, false);
});

test('spawn lỗi bất đồng bộ (ENOENT): route trả 5xx, không sập', async (t) => {
  const { EventEmitter } = await import('node:events');
  const { makeRestartAssistant } = await import('../lib/restart-assistant.js');
  const spawnImpl = () => { const c = new EventEmitter(); c.unref = () => {}; setImmediate(() => c.emit('error', new Error('spawn systemctl ENOENT'))); return c; };
  const deps = makeDeps(t, { restartAssistant: makeRestartAssistant({ platform: 'linux', hermesHome: '/h', spawnImpl }) });
  const { call } = await startApp(t, deps);
  const admin = await loginAs(t, deps, call);
  const orig = console.error; console.error = () => {};
  let res;
  try { res = await call('/api/admin/restart-assistant', { method: 'POST', cookie: admin, body: {} }); } finally { console.error = orig; }
  assert.equal(res.status, 500);
  assert.ok(!res.json.error.includes('ENOENT'));
});

test('danh sách người dùng có "đăng nhập gần nhất": đăng nhập đúng mới ghi, sai thì không', async (t) => {
  const deps = makeDeps(t); const { call } = await startApp(t, deps);
  deps.users.create({ username: 'khach', role: 'owner', password: 'matkhau-dai' });
  const admin = await loginAs(t, deps, call);
  assert.equal((await call('/api/auth/verify', { method: 'POST', body: { username: 'khach', password: 'sai-mat-khau' } })).status, 401);
  let list = (await call('/api/admin/users', { cookie: admin })).json.users;
  assert.equal(list.find((u) => u.username === 'khach').lastLoginAt, null);
  assert.ok(list.find((u) => u.username === 'anh').lastLoginAt > 0);
  const before = Date.now();
  await call('/api/auth/verify', { method: 'POST', body: { username: 'khach', password: 'matkhau-dai' } });
  list = (await call('/api/admin/users', { cookie: admin })).json.users;
  assert.ok(list.find((u) => u.username === 'khach').lastLoginAt >= before);
});

test('cờ chờ khởi động lại (giai đoạn 7B): Chủ bot 403; khởi động lại trợ lý xoá cờ, cờ kết nối Zalo thì khởi động lại cả kết nối Zalo', async (t) => {
  const order = [];
  const deps = makeDeps(t, { restartAssistant: async () => { order.push('assistant'); }, restartSidecar: async () => { order.push('sidecar'); } });
  const { call } = await startApp(t, deps);
  const owner = await loginAs(t, deps, call, { username: 'khach', role: 'owner' });
  assert.equal((await call('/api/admin/restart-flags', { cookie: owner })).status, 403);
  const admin = await loginAs(t, deps, call);
  deps.restartFlags.mark('assistant', 'Đổi model');
  deps.restartFlags.mark('sidecar', 'Cấu hình: kết bạn');
  const before = await call('/api/admin/restart-flags', { cookie: admin });
  assert.deepEqual(before.json.assistant.reasons, ['Đổi model']);
  assert.equal((await call('/api/admin/restart-assistant', { method: 'POST', cookie: admin })).status, 200);
  assert.deepEqual(order, ['sidecar', 'assistant']);
  const after = await call('/api/admin/restart-flags', { cookie: admin });
  assert.equal(after.json.assistant, null);
  assert.equal(after.json.sidecar, null);
  assert.match(deps.activity.list().find((e) => e.action === 'restart_assistant').detail, /Đổi model, Cấu hình: kết bạn/);
});

test('Quản trị xem phiên mọi tài khoản và đăng xuất từ xa; Chủ bot không gọi được', async (t) => {
  const deps = makeDeps(t); const { call } = await startApp(t, deps);
  const admin = await loginAs(t, deps, call);
  const khach = await loginAs(t, deps, call, { username: 'khach', role: 'owner' });
  assert.equal((await call('/api/admin/sessions', { cookie: khach })).status, 403);
  const list = await call('/api/admin/sessions', { cookie: admin });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.sessions.map((s) => s.username).sort(), ['anh', 'khach']);
  const mine = list.json.sessions.find((s) => s.current);
  const theirs = list.json.sessions.find((s) => s.username === 'khach');
  assert.equal(mine.username, 'anh');
  assert.equal((await call(`/api/admin/sessions/${theirs.id}/logout`, { method: 'POST', cookie: khach })).status, 403);
  assert.equal((await call(`/api/admin/sessions/${mine.id}/logout`, { method: 'POST', cookie: admin })).status, 400);
  assert.equal((await call(`/api/admin/sessions/${theirs.id}/logout`, { method: 'POST', cookie: admin })).status, 200);
  assert.equal((await call('/api/me', { cookie: khach })).status, 401);
  assert.equal((await call(`/api/admin/sessions/${theirs.id}/logout`, { method: 'POST', cookie: admin })).status, 404);
  assert.ok(deps.activity.list().some((e) => e.action === 'session_revoke' && e.detail.startsWith('khach · ')));
});
