import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loginAs, makeDeps, startApp } from '../test-helpers.js';

/** hermesAdmin giả: ghi lại lệnh, trả kết quả theo bảng. */
function fakeAdmin(answers = {}) {
  const calls = [];
  const run = (kind) => async (cmd, args) => {
    calls.push({ kind, cmd, args });
    const a = answers[cmd];
    if (a instanceof Error) throw a;
    return { ok: true, ...(typeof a === 'function' ? a(args) : a) };
  };
  return { calls, read: run('read'), write: run('write') };
}

test('Skill: chỉ Quản trị; bật/tắt ghi Nhật ký, không cần khởi động lại; cài/gỡ đánh dấu khởi động lại', async (t) => {
  const deps = makeDeps(t);
  deps.hermesAdmin = fakeAdmin({
    'skills.list': { skills: [{ name: 'bao-cao', enabled: true }] },
    'skills.toggle': (a) => ({ name: a.name, enabled: a.enabled }),
    'hub.install': (a) => ({ name: 'pdf', identifier: a.identifier }),
    'skills.uninstall': (a) => ({ name: a.name }),
  });
  const { call } = await startApp(t, deps);
  const owner = await loginAs(t, deps, call, { username: 'khach', role: 'owner' });
  assert.equal((await call('/api/admin/skills', { cookie: owner })).status, 403);
  assert.equal((await call('/api/admin/skills/hub/install', { method: 'POST', cookie: owner, body: { identifier: 'x' } })).status, 403);
  const admin = await loginAs(t, deps, call);
  assert.deepEqual((await call('/api/admin/skills', { cookie: admin })).json.skills, [{ name: 'bao-cao', enabled: true }]);

  const off = await call('/api/admin/skills/toggle', { method: 'PUT', cookie: admin, body: { name: 'bao-cao', enabled: false } });
  assert.equal(off.json.enabled, false);
  assert.equal(deps.activity.list().find((e) => e.action === 'skill_disable').detail, 'bao-cao');
  assert.ok(!deps.restartFlags.get().assistant, 'bật/tắt áp dụng từ cuộc trò chuyện mới, không cần khởi động lại');

  await call('/api/admin/skills/hub/install', { method: 'POST', cookie: admin, body: { identifier: 'official/doc/pdf' } });
  await call('/api/admin/skills/uninstall', { method: 'POST', cookie: admin, body: { name: 'pdf' } });
  assert.deepEqual(deps.restartFlags.get().assistant.reasons, ['Skill: pdf']);
  assert.deepEqual(deps.hermesAdmin.calls.filter((c) => c.kind === 'write').map((c) => c.cmd), ['skills.toggle', 'hub.install', 'skills.uninstall'], 'lệnh ghi đi hàng đợi ghi');
});

test('Skill: lỗi người dùng từ Hermes trả nguyên câu; lỗi lạ trả câu chung', async (t) => {
  const deps = makeDeps(t);
  deps.hermesAdmin = fakeAdmin({
    'hub.install': Object.assign(new Error('Chưa cài được skill: Blocked'), { statusCode: 400 }),
    'skills.list': new Error('Traceback ... /root/.hermes/secret'),
  });
  const { call } = await startApp(t, deps);
  const admin = await loginAs(t, deps, call);
  const bad = await call('/api/admin/skills/hub/install', { method: 'POST', cookie: admin, body: { identifier: 'x' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'Chưa cài được skill: Blocked');
  const boom = await call('/api/admin/skills', { cookie: admin });
  assert.equal(boom.status, 500);
  assert.doesNotMatch(boom.json.error, /secret/);
});

test('Skill tải lên: chỉ .zip/.md, ghi tệp tạm cho Hermes đọc rồi xoá', async (t) => {
  const deps = makeDeps(t);
  let seen = null;
  deps.hermesAdmin = fakeAdmin({ 'skills.upload': (a) => { seen = { ...a, existed: existsSync(a.path) }; return { installed: true, name: 'my-skill', scan: { policy: 'allow' } }; } });
  const { base, call } = await startApp(t, deps);
  const admin = await loginAs(t, deps, call);
  const send = (name, body) => fetch(`${base}/api/admin/skills/upload`, {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'zalo-dashboard', 'X-File-Name': encodeURIComponent(name), Cookie: admin },
  }).then(async (r) => ({ status: r.status, json: await r.json() }));
  assert.equal((await send('virus.exe', Buffer.from('x'))).status, 400);
  const ok = await send('my skill.zip', Buffer.from('PK...'));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.installed, true);
  assert.equal(seen.filename, 'my skill.zip');
  assert.equal(seen.existed, true);
  assert.equal(existsSync(seen.path), false, 'tệp tạm đã xoá');
  assert.deepEqual(deps.restartFlags.get().assistant.reasons, ['Skill: my-skill']);
});

test('Skill: bật/tắt nhiều skill — chỉ Quản trị, kiểm tên trước, một lệnh Hermes, báo skill lỗi, một dòng Nhật ký', async (t) => {
  const deps = makeDeps(t);
  deps.hermesAdmin = fakeAdmin({
    'skills.toggle_many': (a) => ({
      enabled: a.enabled,
      done: a.names.filter((n) => n !== 'loi'),
      failed: a.names.filter((n) => n === 'loi').map((name) => ({ name, error: 'Skill này là lõi của Hermes, không tắt được.' })),
    }),
  });
  const { call } = await startApp(t, deps);
  const owner = await loginAs(t, deps, call, { username: 'khach', role: 'owner' });
  const url = '/api/admin/skills/toggle-many';
  assert.equal((await call(url, { method: 'PUT', cookie: owner, body: { names: ['a'], enabled: false } })).status, 403);
  const admin = await loginAs(t, deps, call);
  for (const body of [{ names: ['a'], enabled: 'no' }, { names: [], enabled: false }, { names: ['a', '../x'], enabled: false },
    { names: Array.from({ length: 1001 }, (_, i) => `s${i}`), enabled: false }]) {
    assert.equal((await call(url, { method: 'PUT', cookie: admin, body })).status, 400);
  }
  assert.equal(deps.hermesAdmin.calls.length, 0, 'từ chối trước khi gọi Hermes');
  const r = await call(url, { method: 'PUT', cookie: admin, body: { names: ['bao-cao', 'loi', 'bao-cao', 'pdf'], enabled: false } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.done, ['bao-cao', 'pdf']);
  assert.deepEqual(r.json.failed, [{ name: 'loi', error: 'Skill này là lõi của Hermes, không tắt được.' }]);
  assert.deepEqual(deps.hermesAdmin.calls.map((c) => [c.kind, c.cmd, c.args.names, c.args.everywhere]), [['write', 'skills.toggle_many', ['bao-cao', 'loi', 'pdf'], false]]);
  assert.deepEqual(deps.activity.list().filter((e) => e.action.startsWith('skill_')).map((e) => [e.action, e.detail]), [['skill_disable', '2 skill: bao-cao, pdf']]);
  const many = Array.from({ length: 120 }, (_, i) => `s${i}`);
  const big = await call(url, { method: 'PUT', cookie: admin, body: { names: many, enabled: true } });
  assert.deepEqual([big.status, big.json.done.length, deps.hermesAdmin.calls.length], [200, 120, 2], 'quá 50 skill vẫn được, đi một lệnh');
});

test('Skill cho thành viên: đánh dấu trong danh sách, mở/đóng ghi tệp, chặn skill riêng tư, chỉ Quản trị', async (t) => {
  const { createMemberSkills } = await import('../lib/member-skills.js');
  const { join } = await import('node:path');
  const { readFileSync } = await import('node:fs');
  const deps = makeDeps(t);
  const file = join(deps.dir, 'zalo', 'member-skills.json');
  deps.memberSkills = createMemberSkills(file);
  deps.hermesAdmin = fakeAdmin({ 'skills.list': { skills: [{ name: 'content-giao-duc' }, { name: 'tin-nhan-zalo' }] } });
  const { call } = await startApp(t, deps);
  const owner = await loginAs(t, deps, call, { username: 'khach', role: 'owner' });
  assert.equal((await call('/api/admin/skills/member', { method: 'PUT', cookie: owner, body: { name: 'content-giao-duc', allowed: true } })).status, 403);
  const admin = await loginAs(t, deps, call);
  const on = await call('/api/admin/skills/member', { method: 'PUT', cookie: admin, body: { name: 'content-giao-duc', allowed: true } });
  assert.deepEqual([on.status, on.json.member], [200, true]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).skills, ['content-giao-duc']);
  const blocked = await call('/api/admin/skills/member', { method: 'PUT', cookie: admin, body: { name: 'tin-nhan-zalo', allowed: true } });
  assert.equal(blocked.status, 400);
  assert.equal((await call('/api/admin/skills/member', { method: 'PUT', cookie: admin, body: { name: 'x', allowed: 'yes' } })).status, 400);
  const list = (await call('/api/admin/skills', { cookie: admin })).json.skills;
  assert.deepEqual(list.map((s) => [s.name, s.member, s.memberBlocked]), [['content-giao-duc', true, false], ['tin-nhan-zalo', false, true]]);
  await call('/api/admin/skills/member', { method: 'PUT', cookie: admin, body: { name: 'content-giao-duc', allowed: false } });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).skills, []);
  assert.ok(deps.activity.list().some((e) => e.action === 'skill_member_on' && e.detail === 'content-giao-duc'));
  assert.ok(!deps.restartFlags.get().assistant, 'plugin đọc lại tệp mỗi lượt — không cần khởi động lại');
});

test('Tên skill: nhận "nhóm/tên" của skill trùng tên, chặn thoát thư mục', async () => {
  const { SKILL_NAME } = await import('./skills.js');
  for (const ok of ['codex', 'content giao duc', 'software-development/systematic-debugging']) assert.ok(SKILL_NAME.test(ok), ok);
  for (const bad of ['../x', '/x', 'x/', 'a/../b', 'a/./b', '..', 'a\b', '']) assert.ok(!SKILL_NAME.test(bad), bad);
});
