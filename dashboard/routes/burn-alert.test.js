import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeps, startApp } from '../test-helpers.js';
import { parseBurnAlertTokens } from './burn-alert.js';

const TOKEN = 'tok-chauhoa-0123456789abcdef';
const auth = { Authorization: `Bearer ${TOKEN}` };
const loop = { kind: 'tool_loop', tool: 'zalo_send_file', count: 10, model: 'gpt-5.6-sol' };

async function setup(t, { owners = ['111'], tokens = `chauhoa:${TOKEN}`, sendFails = false } = {}) {
  const sent = [];
  const sidecar = {
    send: async (m) => { if (sendFails) throw new Error('down'); sent.push(m); return {}; },
    groups: async () => [],
  };
  const deps = makeDeps(t, { sidecar, burnAlertTokens: parseBurnAlertTokens(tokens) });
  deps.owners = { ...deps.owners, list: () => owners };
  const { call } = await startApp(t, deps);
  return { call, sent };
}

test('parseBurnAlertTokens: tách nhãn:token, bỏ mục hỏng và token ngắn', () => {
  assert.equal(parseBurnAlertTokens('').size, 0);
  assert.equal(parseBurnAlertTokens(undefined).size, 0);
  assert.equal(parseBurnAlertTokens('hong, a:ngan').size, 0);
  assert.deepEqual([...parseBurnAlertTokens(`chauhoa:${TOKEN}, duongtuan:${TOKEN}x`).values()], ['chauhoa', 'duongtuan']);
});

test('không cấu hình token: đường dẫn không tồn tại', async (t) => {
  const { call, sent } = await setup(t, { tokens: '' });
  assert.equal((await call('/api/hooks/burn-alert', { method: 'POST', body: loop, headers: auth })).status, 404);
  assert.equal(sent.length, 0);
});

test('sai hoặc thiếu token: 401, không nhắn gì', async (t) => {
  const { call, sent } = await setup(t);
  assert.equal((await call('/api/hooks/burn-alert', { method: 'POST', body: loop })).status, 401);
  assert.equal((await call('/api/hooks/burn-alert', { method: 'POST', body: loop, headers: { Authorization: 'Bearer sai' } })).status, 401);
  assert.equal(sent.length, 0);
});

test('hợp lệ: nhắn riêng chủ nhân, nhãn lấy theo token, không cần Origin', async (t) => {
  const { call, sent } = await setup(t, { owners: ['111', '222'] });
  const r = await call('/api/hooks/burn-alert', { method: 'POST', body: { ...loop, label: 'gia-mao' }, headers: { ...auth, 'X-Requested-With': '' } });
  assert.equal(r.status, 200);
  assert.deepEqual(sent.map((m) => [m.threadId, m.threadType]), [['111', 0], ['222', 0]]);
  assert.match(sent[0].text, /chauhoa/);
  assert.match(sent[0].text, /zalo_send_file/);
  assert.match(sent[0].text, /10 lần/);
  assert.doesNotMatch(sent[0].text, /gia-mao/);
});

test('token_burn: báo số token dễ đọc', async (t) => {
  const { call, sent } = await setup(t);
  const r = await call('/api/hooks/burn-alert', { method: 'POST', body: { kind: 'token_burn', count: 31_500_000, model: 'gpt-5.6-sol' }, headers: auth });
  assert.equal(r.status, 200);
  assert.match(sent[0].text, /31,5 triệu token/);
});

test('dữ liệu lạ bị từ chối, không chuyển nguyên văn sang Zalo', async (t) => {
  const { call, sent } = await setup(t);
  const post = (body) => call('/api/hooks/burn-alert', { method: 'POST', body, headers: auth });
  assert.equal((await post({ ...loop, kind: 'khac' })).status, 400);
  assert.equal((await post({ ...loop, tool: 'bấm vào http://x.vn' })).status, 400);
  assert.equal((await post({ ...loop, model: 'a\nb' })).status, 400);
  assert.equal((await post({ ...loop, count: -1 })).status, 400);
  assert.equal((await post({ ...loop, count: '10' })).status, 400);
  assert.equal(sent.length, 0);
});

test('mỗi máy tối đa 6 tin một giờ', async (t) => {
  const { call, sent } = await setup(t);
  for (let i = 0; i < 6; i += 1) assert.equal((await call('/api/hooks/burn-alert', { method: 'POST', body: { ...loop, tool: `t${i}` }, headers: auth })).status, 200);
  assert.equal((await call('/api/hooks/burn-alert', { method: 'POST', body: loop, headers: auth })).status, 429);
  assert.equal(sent.length, 6);
});

test('chưa có chủ nhân: 503; Zalo lỗi: 502', async (t) => {
  const none = await setup(t, { owners: [] });
  assert.equal((await none.call('/api/hooks/burn-alert', { method: 'POST', body: loop, headers: auth })).status, 503);
  const down = await setup(t, { sendFails: true });
  assert.equal((await down.call('/api/hooks/burn-alert', { method: 'POST', body: loop, headers: auth })).status, 502);
});
