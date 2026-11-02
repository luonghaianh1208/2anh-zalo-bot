import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chatMsg, fakeSidecar, loginAs, makeDeps, seedHistory, startApp } from '../test-helpers.js';
import { describe } from '../lib/audit-feed.js';
import { waitText } from '../public/views/broadcast.js';

const LAN = '1111111111111111111';
const job = { id: 'bc-a1', status: 'running', counts: { total: 2, sent: 1, failed: 0, unknown: 0, pending: 1 } };

async function ready(t, over = {}) {
  const made = [];
  const acts = [];
  const sidecar = fakeSidecar({
    broadcasts: async () => ({ jobs: [job], sentToday: 3 }),
    createBroadcast: async (m) => { made.push(m); return { ...job, counts: { ...job.counts, total: m.targets.length } }; },
    broadcastAction: async (id, action) => { acts.push([id, action]); return job; },
    ...over,
  });
  const deps = makeDeps(t, { sidecar, outboxDir: undefined });
  deps.outboxDir = join(deps.dir, 'outbox');
  seedHistory(deps, { messages: [chatMsg({ threadId: '2222222222222222222', threadType: 0, senderName: 'Minh' })] });
  const { base, call } = await startApp(t, deps);
  const cookie = await loginAs(t, deps, call, { username: 'khach', role: 'owner' });
  const upload = (name, body = 'noi dung') => fetch(`${base}/api/broadcasts/file`, {
    method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'zalo-dashboard', Cookie: cookie, 'X-File-Name': encodeURIComponent(name) },
  });
  const post = (body) => call('/api/broadcasts', { method: 'POST', cookie, body });
  return { deps, call, cookie, made, acts, upload, post };
}

test('danh sách nơi nhận gộp nhóm, bạn bè, người từng nhắn và thư mục; không có bot', async (t) => {
  const { deps, call, cookie } = await ready(t);
  deps.permissions.createFolder('Khách');
  const fid = deps.permissions.get().folders[0].id;
  deps.permissions.addFolderPeople(fid, [{ uid: '3333333333333333333', name: 'Hoa' }]);
  deps.permissions.setFolderMembers(fid, ['200', '999']);
  const res = await call('/api/broadcasts/recipients', { cookie });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.groups, [{ id: '200', name: 'Tổ Hoá' }]);
  assert.deepEqual(res.json.people.map((p) => p.name).sort(), ['Hoa', 'Lan', 'Minh']);
  assert.equal(res.json.people.find((p) => p.name === 'Lan').friend, true);
  assert.deepEqual(res.json.folders[0].people, ['3333333333333333333']);
  assert.deepEqual(res.json.folders[0].groups, ['200']); // nhóm bot đã rời không còn trong danh sách
});

test('cần đăng nhập', async (t) => {
  const { call } = await ready(t);
  assert.equal((await call('/api/broadcasts')).status, 401);
  assert.equal((await call('/api/broadcasts', { method: 'POST', body: { targets: [] } })).status, 401);
});

test('bắt đầu đợt: tên lấy ở máy chủ, có actor, ghi Nhật ký', async (t) => {
  const { deps, post, made } = await ready(t);
  const res = await post({ text: 'Chào {ten}', pace: { dailyCap: 50 }, targets: [{ id: LAN, type: 0, name: 'Tên giả' }, { id: '200', type: 1 }] });
  assert.equal(res.status, 200);
  assert.deepEqual(made[0].targets, [{ id: LAN, type: 0, name: 'Lan' }, { id: '200', type: 1, name: 'Tổ Hoá' }]);
  assert.equal(made[0].actor, 'khach');
  assert.deepEqual(made[0].pace, { dailyCap: 50 });
  assert.equal(deps.activity.list().at(0).action, 'broadcast_create');
});

test('không cho gửi tới UID không có trong danh sách', async (t) => {
  const { post, made } = await ready(t);
  const res = await post({ text: 'x', targets: [{ id: LAN, type: 0 }, { id: '9999999999999999999', type: 0 }] });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /1 nơi nhận không còn/);
  assert.equal(made.length, 0);
});

test('nhóm bị nhận nhầm là người (đúng id, sai loại) cũng bị từ chối', async (t) => {
  const { post } = await ready(t);
  assert.equal((await post({ text: 'x', targets: [{ id: '200', type: 0 }] })).status, 400);
});

test('chưa chọn ai hoặc fileId lạ thì từ chối', async (t) => {
  const { post } = await ready(t);
  assert.equal((await post({ text: 'x', targets: [] })).status, 400);
  assert.equal((await post({ text: 'x', targets: [{ id: LAN, type: 0 }], fileId: '../../etc' })).status, 400);
  assert.equal((await post({ text: 'x', targets: [{ id: LAN, type: 0 }], fileId: 'a'.repeat(16) })).status, 400);
});

test('tệp đính kèm: tải lên rồi chuyển vào outbox/broadcast/<mã>, bot nhận đúng đường dẫn', async (t) => {
  const { deps, upload, post, made } = await ready(t);
  const up = await (await upload('Bảng giá.PDF')).json();
  assert.equal(up.name, 'Bảng giá.pdf');
  const res = await post({ text: 'Gửi bảng giá', fileId: up.fileId, targets: [{ id: LAN, type: 0 }] });
  assert.equal(res.status, 200);
  assert.equal(made[0].file.path, join(deps.outboxDir, 'broadcast', up.fileId, 'Bảng giá.pdf'));
  assert.ok(existsSync(made[0].file.path));
  assert.deepEqual(readdirSync(join(deps.outboxDir, 'broadcast-pending')), []);
});

test('bot từ chối đợt thì xoá tệp; quá hạn chờ thì giữ vì bot có thể đang dùng', async (t) => {
  let fail = Object.assign(new Error('Đã có một đợt'), { statusCode: 400 });
  const { deps, upload, post } = await ready(t, { createBroadcast: async () => { throw fail; } });
  const one = await (await upload('a.pdf')).json();
  assert.equal((await post({ fileId: one.fileId, targets: [{ id: LAN, type: 0 }] })).status, 400);
  assert.equal(existsSync(join(deps.outboxDir, 'broadcast', one.fileId)), false);
  fail = Object.assign(new Error('x'), { name: 'SidecarTimeout' });
  const two = await (await upload('b.pdf')).json();
  assert.equal((await post({ fileId: two.fileId, targets: [{ id: LAN, type: 0 }] })).status, 504);
  assert.equal(existsSync(join(deps.outboxDir, 'broadcast', two.fileId, 'b.pdf')), true);
});

test('tệp sai loại bị từ chối; tệp bỏ dở quá một ngày được dọn khi có lần tải kế tiếp', async (t) => {
  const { deps, upload } = await ready(t);
  assert.equal((await upload('virus.exe')).status, 400);
  const old = join(deps.outboxDir, 'broadcast-pending', 'cu');
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, 'a.pdf'), 'x');
  const past = new Date(Date.now() - 2 * 24 * 3600_000);
  utimesSync(old, past, past);
  assert.equal((await upload('moi.pdf')).status, 200);
  assert.equal(existsSync(old), false);
});

test('xem, tạm dừng, tiếp tục, huỷ; thao tác lạ bị chặn', async (t) => {
  const { call, cookie, acts } = await ready(t);
  assert.equal((await call('/api/broadcasts', { cookie })).json.sentToday, 3);
  for (const a of ['pause', 'resume', 'cancel']) assert.equal((await call(`/api/broadcasts/bc-a1/${a}`, { method: 'POST', cookie })).status, 200);
  assert.deepEqual(acts.map((x) => x[1]), ['pause', 'resume', 'cancel']);
  assert.equal((await call('/api/broadcasts/bc-a1/delete', { method: 'POST', cookie })).status, 400);
  assert.equal((await call('/api/broadcasts/x/pause', { method: 'POST', cookie })).status, 400);
});

test('bot tắt thì trang báo rõ thay vì lỗi trống', async (t) => {
  const down = () => { throw Object.assign(new Error('x'), { name: 'SidecarDown' }); };
  const { call, cookie } = await ready(t, { broadcasts: async () => down() });
  assert.equal((await call('/api/broadcasts', { cookie })).status, 503);
});

test('Nhật ký hiện nhãn tiếng Việt cho thao tác gửi hàng loạt', () => {
  const row = describe({ src: 'dashboard', action: 'broadcast_create', actor: 'anh', detail: '3 nơi nhận', at: 1 }, { role: 'owner', groups: new Map(), peers: new Map() });
  assert.match(JSON.stringify(row), /Bắt đầu đợt gửi hàng loạt/);
});

test('câu trạng thái chờ', () => {
  assert.match(waitText({ queued: true }), /xếp hàng/);
  assert.match(waitText({ wait: { reason: 'zalo' } }), /Zalo/);
  assert.match(waitText({ wait: { reason: 'daily', until: 1 } }), /trong ngày/);
  assert.match(waitText({ wait: { reason: 'hours', until: 1 } }), /khung giờ/);
  assert.match(waitText({ wait: { reason: 'batch', until: 1 } }), /tốp/);
  assert.equal(waitText({ wait: null }), '');
});
