import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createActivityLog } from '../lib/activity-log.js';
import { chatMsg, loginAs, makeDeps, seedHistory, startApp } from '../test-helpers.js';

async function ready(t, { seed = true } = {}) {
  const deps = makeDeps(t);
  let clock = 5000;
  deps.activity = createActivityLog(join(deps.dir, 'activity-test.jsonl'), { now: () => clock });
  if (seed) seedHistory(deps, {
    messages: [
      chatMsg({ threadId: '100', threadType: 0, senderUid: '100', senderName: 'Lan' }),
      chatMsg({ threadId: '200', threadType: 1, senderUid: '555', senderName: 'Anh Chủ' }),
    ],
    audits: [
      { requestId: 'r1', action: 'send', actorUid: '555', actorRole: 'owner', threadId: '200', threadType: 1, status: 'succeeded', at: 3000 },
      { requestId: 'r2', action: 'typing', actorUid: '555', actorRole: 'owner', threadId: '200', threadType: 1, status: 'succeeded', at: 3500 },
      { requestId: 'r3', action: 'dashboard_send', actorUid: 'khach', actorRole: 'dashboard', threadId: '100', threadType: 0, status: 'failed', error: 'operation_failed', at: 2000 },
      { requestId: 'r4', action: 'send', actorUid: '', actorRole: 'system', threadId: '100', threadType: 0, at: 2500 }, // chỉ attempted
    ],
  });
  const { call } = await startApp(t, deps);
  const admin = await loginAs(t, deps, call);                                      // 'login' lúc 5000
  clock = 5001;
  const owner = await loginAs(t, deps, call, { username: 'khach', role: 'owner' }); // 'login' lúc 5001
  clock = 2800;
  deps.activity.append({ actor: 'anh', action: 'user_create', detail: 'khach (owner)' });
  return { call, admin, owner };
}

test('Nhật ký gộp hoạt động bot + dashboard, mới nhất trước, bỏ "đang gõ" và dòng chưa có kết quả', async (t) => {
  const { call, admin } = await ready(t);
  const res = await call('/api/audit', { cookie: admin });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.items.map((i) => [i.at, i.what]), [
    [5001, 'Đăng nhập dashboard'], [5000, 'Đăng nhập dashboard'], [3000, 'Bot trả lời tin nhắn'],
    [2800, 'Tạo tài khoản dashboard'], [2000, 'Nhắn tay từ dashboard'],
  ]);
  const sent = res.json.items[2];
  assert.deepEqual([sent.who, sent.where, sent.result], ['Chủ nhân Anh Chủ', 'Tổ Hoá', 'Thành công']);
  assert.equal(sent.code.action, 'send');
  assert.equal(res.json.nextBefore, null);
});

test('Chủ bot thấy chữ dễ hiểu, không có mã kỹ thuật; lọc chỉ lỗi', async (t) => {
  const { call, owner } = await ready(t);
  const all = await call('/api/audit', { cookie: owner });
  assert.ok(all.json.items.every((i) => !('code' in i)));
  const failed = await call('/api/audit?status=failed', { cookie: owner });
  assert.deepEqual(failed.json.items.map((i) => [i.what, i.who, i.where, i.result]), [
    ['Nhắn tay từ dashboard', 'khach (dashboard)', 'Lan', 'Không thành công — Zalo từ chối hoặc mạng lỗi'],
  ]);
});

test('phân trang theo before', async (t) => {
  const { call, admin } = await ready(t);
  const res = await call('/api/audit?before=3000', { cookie: admin });
  assert.deepEqual(res.json.items.map((i) => i.at), [2800, 2000]);
});

test('tham số sai → 400; chưa đăng nhập → 401', async (t) => {
  const { call, admin } = await ready(t);
  for (const q of ['?status=all', '?before=abc', '?before=-1', `?before=${'9'.repeat(17)}`]) {
    const res = await call(`/api/audit${q}`, { cookie: admin });
    assert.equal(res.status, 400, q);
    assert.match(res.json.error, /—/);
  }
  assert.equal((await call('/api/audit')).status, 401);
});

test('chưa có lịch sử: Nhật ký vẫn có hoạt động dashboard', async (t) => {
  const { call, admin } = await ready(t, { seed: false });
  const res = await call('/api/audit', { cookie: admin });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.items.map((i) => i.source), ['dashboard', 'dashboard', 'dashboard']);
});

test('Dọn nhật ký: chỉ Quản trị, mốc hợp lệ, xoá cả dòng của bot lẫn dashboard rồi ghi một dòng "Dọn nhật ký"', async (t) => {
  const { call, admin, owner } = await ready(t);
  const url = '/api/admin/audit/clear';
  assert.equal((await call(url, { method: 'POST', cookie: owner, body: { days: 0 } })).status, 403);
  for (const days of [1, '0', -7, null]) assert.equal((await call(url, { method: 'POST', cookie: admin, body: { days } })).status, 400, String(days));
  const res = await call(url, { method: 'POST', cookie: admin, body: { days: 30 } });
  assert.deepEqual([res.status, res.json.bot > 0, res.json.dashboard], [200, true, 3], 'mốc thời gian mẫu đều cũ hơn 30 ngày');
  const after = await call('/api/audit', { cookie: admin });
  assert.deepEqual(after.json.items.map((i) => [i.what, i.source]), [['Dọn nhật ký', 'dashboard']]);
});
