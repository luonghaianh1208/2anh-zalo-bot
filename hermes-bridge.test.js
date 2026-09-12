import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket as RawWebSocket } from 'ws';
import { openZaloStore } from './zalo-store.js';
import { createRuntimeHealth } from './runtime-health.js';

process.env.ZALO_RATE_BURST = '1';
process.env.ZALO_RATE_INTERVAL_MS = '60000';
process.env.ZALO_RATE_MAX_WAIT_MS = '1';
process.env.ZALO_BRIDGE_TOKEN = 'test-bridge-token';

class WebSocket extends RawWebSocket {
  constructor(url, options) {
    const authenticated = new URL(url);
    authenticated.searchParams.set('token', process.env.ZALO_BRIDGE_TOKEN);
    super(authenticated.toString(), options);
  }
}

const { extractMediaUrls, sendSystemNotice, startAutomaticBackfill, startHermesBridge, stopHermesBridge } = await import('./hermes-bridge.js');

function testStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'zalo-bridge-'));
  const store = openZaloStore({ path: join(dir, 'history.sqlite') });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

function auth(threadId, threadType, { actorUid = 'owner', confirmed = false } = {}) {
  return { actorUid, actorRole: actorUid === 'owner' ? 'owner' : 'public', sourceThreadId: threadId, sourceThreadType: threadType, confirmed };
}

function onceMessage(ws, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ws message')), 3000);
    ws.on('message', function onMessage(raw) {
      const msg = JSON.parse(raw.toString());
      if (!predicate(msg)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(msg);
    });
  });
}

test('bridge rejects a client without the shared token', async (t) => {
  const server = startHermesBridge({ api: {}, profile: { user_id: 'bot' }, port: 0, store: testStore(t) });
  await new Promise((resolve) => server.once('listening', resolve));
  const ws = new RawWebSocket(`ws://127.0.0.1:${server.address().port}`);
  t.after(() => { stopHermesBridge(); ws.close(); });
  const status = await new Promise((resolve, reject) => {
    ws.once('unexpected-response', (_request, response) => resolve(response.statusCode));
    ws.once('open', () => reject(new Error('bridge accepted an unauthenticated client')));
    ws.once('error', () => {});
  });
  assert.equal(status, 401);
});

test('bridge rejects browser-origin websocket clients even with the token', async (t) => {
  const server = startHermesBridge({ api: {}, profile: { user_id: 'bot' }, port: 0, store: testStore(t) });
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `ws://127.0.0.1:${server.address().port}?token=${process.env.ZALO_BRIDGE_TOKEN}`;
  const ws = new RawWebSocket(url, { headers: { Origin: 'https://evil.example' } });
  t.after(() => { stopHermesBridge(); ws.close(); });
  const status = await new Promise((resolve, reject) => {
    ws.once('unexpected-response', (_request, response) => resolve(response.statusCode));
    ws.once('open', () => reject(new Error('bridge accepted a browser-origin client')));
    ws.once('error', () => {});
  });
  assert.equal(status, 403);
});

test('extractMediaUrls rút ảnh từ content, raw và quote', () => {
  const urls = extractMediaUrls({
    data: {
      content: {
        href: 'https://example.com/content.jpg',
        thumb: 'https://example.com/thumb.jpg',
        title: 'không phải url ảnh',
      },
      quote: {
        normalUrl: 'https://example.com/quoted.jpg',
      },
      extra: {
        nested: [{ rawUrl: 'https://example.com/raw.jpg' }],
      },
    },
  });

  assert.deepEqual(urls, [
    'https://example.com/content.jpg',
    'https://example.com/thumb.jpg',
    'https://example.com/quoted.jpg',
    'https://example.com/raw.jpg',
  ]);
});

test('forwardToHermes chuẩn hóa đúng cấu trúc quote thực tế của zca-js', async (t) => {
  const server = startHermesBridge({ api: {}, profile: { user_id: 'bot-uid' }, port: 0, store: testStore(t) });
  await new Promise((resolve) => server.once('listening', resolve));

  const { port } = server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);

  try {
    const hello = onceMessage(ws, (msg) => msg.type === 'hello');
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    await hello;

    const incoming = onceMessage(ws, (msg) => msg.type === 'message');
    const { forwardToHermes } = await import('./hermes-bridge.js');
    const ok = forwardToHermes({
      threadId: 'g1',
      type: 1,
      data: {
        msgId: 'm1',
        cliMsgId: 'c1',
        uidFrom: 'u1',
        dName: 'Yến',
        content: { href: 'https://example.com/photo.jpg' },
        msgType: 'chat.photo',
        mentions: [{ uid: 'bot-uid' }],
        quote: {
          ownerId: 'bot-uid',
          cliMsgId: 1788864027075,
          globalMsgId: 8240551224624,
          cliMsgType: 1,
          msg: 'Quá hay và quá chuẩn luôn anh Hải Anh ơi!',
          attach: '',
          fromD: 'Lăng Tiêu',
        },
        ts: 123,
      },
    });
    const payload = await incoming;

    assert.equal(ok, true);
    assert.equal(payload.id, 'm1');
    assert.equal(payload.threadId, 'g1');
    assert.deepEqual(payload.mediaUrls, ['https://example.com/photo.jpg']);
    assert.deepEqual(payload.mediaTypes, ['image/jpeg']);
    assert.equal(payload.quote.id, '8240551224624');
    assert.equal(payload.quote.cliMsgId, '1788864027075');
    assert.equal(payload.quote.authorId, 'bot-uid');
    assert.equal(payload.quote.authorName, 'Lăng Tiêu');
    assert.equal(payload.quote.text, 'Quá hay và quá chuẩn luôn anh Hải Anh ơi!');
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('bridge dừng gửi các chunk còn lại khi rate limiter từ chối', async (t) => {
  const sent = [];
  const api = {
    sendMessage(content) {
      sent.push(content);
      return Promise.resolve({ message: { msgId: `m${sent.length}` } });
    },
  };

  const server = startHermesBridge({ api, profile: null, port: 0, store: testStore(t) });
  await new Promise((resolve) => server.once('listening', resolve));

  const { port } = server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);

  try {
    const hello = onceMessage(ws, (msg) => msg.type === 'hello');
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    await hello;

    ws.send(JSON.stringify({
      type: 'send',
      reqId: 'r1',
      threadId: 't1',
      threadType: 0,
      text: '**x**'.repeat(85),
      auth: auth('t1', 0),
    }));

    const ack = await onceMessage(ws, (msg) => msg.type === 'ack' && msg.reqId === 'r1');

    assert.equal(ack.ok, false);
    assert.match(ack.error, /giãn nhịp|chống spam|chờ/);
    assert.equal(sent.length, 1);
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('send vào nhóm gắn tag thật cho "@Tên" khớp đúng một thành viên', async (t) => {
  const sent = [];
  const lookups = [];
  const api = {
    sendMessage(content) {
      sent.push(content);
      return Promise.resolve({ message: { msgId: `m${sent.length}` } });
    },
    async getGroupInfo(ids) {
      lookups.push(ids);
      return { gridInfoMap: { g1: { memVerList: ['111_0', '222_0'] } } };
    },
    async getGroupMembersInfo() {
      return { profiles: { 111: { displayName: 'Liên Lưu Thu' }, 222: { displayName: 'Trang' } } };
    },
  };
  const ws = await openBridge(t, api);

  try {
    const text = 'Chị @Liên Lưu Thu xem giúp em, còn Trang thì không cần tag.';
    ws.send(JSON.stringify({ type: 'send', reqId: 'tag', threadId: 'g1', threadType: 1, text, auth: auth('g1', 1) }));
    const ack = await onceMessage(ws, (msg) => msg.type === 'ack' && msg.reqId === 'tag');

    assert.equal(ack.ok, true);
    assert.equal(sent[0].msg, text);
    assert.deepEqual(sent[0].mentions, [{ pos: 4, len: '@Liên Lưu Thu'.length, uid: '111' }]);
    assert.deepEqual(lookups, [['g1']]);
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('khung tin gửi sang Hermes mang đúng loại tệp, không gắn cứng ảnh', async (t) => {
  const ws = await openBridge(t, {});
  const { forwardToHermes } = await import('./hermes-bridge.js');

  try {
    const frame = onceMessage(ws, (msg) => msg.type === 'message');
    forwardToHermes({
      threadId: 'g1',
      type: 1,
      data: {
        msgId: '111', cliMsgId: '222', uidFrom: 'u1', dName: 'Liên', ts: Date.now(),
        msgType: 'share.file',
        content: {
          title: '22-KH.Tiếng nói xanh.pdf',
          href: 'https://file-stal-19.dlfl.vn/gr/abc',
          thumb: 'https://photo-stal-1.zdn.vn/thumb/abc',
        },
      },
    });

    const got = await frame;
    assert.deepEqual(got.mediaUrls, ['https://file-stal-19.dlfl.vn/gr/abc']);
    assert.deepEqual(got.mediaTypes, ['application/pdf']);
    assert.deepEqual(got.mediaNames, ['22-KH.Tiếng nói xanh.pdf']);
    assert.equal(got.attachments[0].kind, 'document');
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('nhóm đông hơn số hồ sơ tra được thì không tag theo danh sách thành viên', async (t) => {
  const sent = [];
  const api = {
    sendMessage(content) {
      sent.push(content);
      return Promise.resolve({ message: { msgId: `m${sent.length}` } });
    },
    async getGroupInfo() {
      return { gridInfoMap: { g2: { memVerList: Array.from({ length: 250 }, (_, i) => `${1000 + i}_0`) } } };
    },
    async getGroupMembersInfo() {
      return { profiles: { 1000: { displayName: 'Liên Lưu Thu' } } };
    },
  };
  const ws = await openBridge(t, api);

  try {
    ws.send(JSON.stringify({
      type: 'send', reqId: 'big', threadId: 'g2', threadType: 1,
      text: 'Chị @Liên Lưu Thu xem giúp em.', auth: auth('g2', 1),
    }));
    const ack = await onceMessage(ws, (msg) => msg.type === 'ack' && msg.reqId === 'big');

    assert.equal(ack.ok, true);
    assert.equal(sent[0].mentions, undefined);
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

async function openBridge(t, api) {
  const server = startHermesBridge({ api, profile: null, port: 0, store: testStore(t) });
  await new Promise((resolve) => server.once('listening', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  const hello = onceMessage(ws, (msg) => msg.type === 'hello');
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await hello;
  return ws;
}

async function sendText(ws, reqId, text) {
  ws.send(JSON.stringify({ type: 'send', reqId, threadId: 't1', threadType: 0, text, auth: auth('t1', 0) }));
  return onceMessage(ws, (msg) => msg.type === 'ack' && msg.reqId === reqId);
}

// Zalo từ chối từ phía máy chủ thì zca-js ném ZaloApiError kèm mã số.
function zaloRejection(message = 'Lỗi không xác định') {
  return Object.assign(new Error(message), { code: 114 });
}

test('Zalo từ chối tin có định dạng thì gửi lại đúng chunk đó dạng chữ thường', async (t) => {
  const sent = [];
  const api = {
    sendMessage(content) {
      sent.push(content);
      if (content.styles) return Promise.reject(zaloRejection());
      return Promise.resolve({ message: { msgId: `m${sent.length}` } });
    },
  };
  const ws = await openBridge(t, api);

  try {
    const ack = await sendText(ws, 's1', '**Chào** cả nhà');

    assert.equal(ack.ok, true);
    assert.equal(ack.msgId, 'm2');
    assert.equal(sent.length, 2);
    assert.ok(sent[0].styles.length > 0);
    assert.equal(sent[1].styles, undefined);
    assert.equal(sent[1].msg, sent[0].msg);
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('lỗi mạng khi gửi thì không tự gửi lại để tránh trùng tin', async (t) => {
  const sent = [];
  const api = {
    sendMessage(content) {
      sent.push(content);
      return Promise.reject(new Error('fetch failed'));
    },
  };
  const ws = await openBridge(t, api);

  try {
    const ack = await sendText(ws, 's2', '**Chào** cả nhà');

    assert.equal(ack.ok, false);
    assert.equal(sent.length, 1);
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('group_members hỏi getGroupInfo lấy ID thành viên rồi mới tra hồ sơ', async (t) => {
  const calls = [];
  const api = {
    async getGroupInfo(ids) {
      calls.push(['getGroupInfo', ids]);
      return { gridInfoMap: { g1: { memVerList: ['u1_0', 'u2_0'] } } };
    },
    async getGroupMembersInfo(ids) {
      calls.push(['getGroupMembersInfo', ids]);
      return { profiles: { u1: { id: 'u1', displayName: 'An' }, u2: { id: 'u2', zaloName: 'Bình' } } };
    },
  };
  const ws = await openBridge(t, api);

  try {
    ws.send(JSON.stringify({
      type: 'group_members', reqId: 'gm1', threadId: 'g1', threadType: 1,
      auth: { actorUid: 'member-1', actorRole: 'public', sourceThreadId: 'g1', sourceThreadType: 1, confirmed: false },
    }));
    const ack = await onceMessage(ws, (msg) => msg.type === 'ack' && msg.reqId === 'gm1');

    assert.equal(ack.ok, true, ack.error);
    assert.deepEqual(calls, [['getGroupInfo', ['g1']], ['getGroupMembersInfo', ['u1', 'u2']]]);
    assert.equal(ack.result.total, 2);
    assert.deepEqual(ack.result.members.map((m) => m.displayName), ['An', 'Bình']);
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('cổng bridge đọc ZALO_BRIDGE_PORT lúc khởi động chứ không phải lúc nạp module', async (t) => {
  const previous = process.env.ZALO_BRIDGE_PORT;
  process.env.ZALO_BRIDGE_PORT = String(40_000 + Math.floor(Math.random() * 20_000));
  try {
    const server = startHermesBridge({ api: {}, profile: null, store: testStore(t) });
    await new Promise((resolve) => server.once('listening', resolve));
    assert.equal(server.address().port, Number(process.env.ZALO_BRIDGE_PORT));
  } finally {
    stopHermesBridge();
    if (previous === undefined) delete process.env.ZALO_BRIDGE_PORT;
    else process.env.ZALO_BRIDGE_PORT = previous;
  }
});

test('gửi lại dạng chữ thường vẫn bị từ chối thì báo thất bại', async (t) => {
  const sent = [];
  const api = {
    sendMessage(content) {
      sent.push(content);
      return Promise.reject(zaloRejection('Nhóm này không tồn tại'));
    },
  };
  const ws = await openBridge(t, api);

  try {
    const ack = await sendText(ws, 's3', '**Chào** cả nhà');

    assert.equal(ack.ok, false);
    assert.equal(sent.length, 2);
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('history chỉ trả đúng hội thoại và giới hạn count', async (t) => {
  const listener = new EventEmitter();
  listener.requestOldMessages = () => {};
  const server = startHermesBridge({ api: { listener }, profile: { user_id: 'bot' }, port: 0, store: testStore(t), ownerUids: ['owner'] });
  await new Promise((resolve) => server.once('listening', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);

  try {
    const hello = onceMessage(ws, (msg) => msg.type === 'hello');
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await hello;

    const { rememberZaloMessage } = await import('./hermes-bridge.js');
    rememberZaloMessage({ threadId: 'g1', type: 1, isSelf: false, data: { msgId: 'm1', cliMsgId: 'c1', uidFrom: 'u1', content: 'một', ts: 1 } });
    rememberZaloMessage({ threadId: 'g2', type: 1, isSelf: false, data: { msgId: 'x1', cliMsgId: 'x1c', uidFrom: 'u2', content: 'khác', ts: 2 } });
    rememberZaloMessage({ threadId: 'g1', type: 1, isSelf: true, data: { msgId: 'm2', cliMsgId: 'c2', uidFrom: 'bot', content: 'hai', ts: 3 } });

    ws.send(JSON.stringify({ type: 'history', reqId: 'h1', threadId: 'g1', threadType: 1, count: 1, auth: auth('g1', 1) }));
    const ack = await onceMessage(ws, (msg) => msg.type === 'ack' && msg.reqId === 'h1');
    assert.equal(ack.ok, true);
    assert.equal(ack.result.count, 1);
    assert.deepEqual(ack.result.messages.map((m) => m.msgId), ['m2']);
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('history yêu cầu old_messages rồi nạp kết quả vào cache', async (t) => {
  const listener = new EventEmitter();
  listener.requestOldMessages = (threadType) => {
    queueMicrotask(() => listener.emit('old_messages', [{
      threadId: 'u1', type: threadType, isSelf: false,
      data: { msgId: 'old1', cliMsgId: 'oldc1', uidFrom: 'u1', content: 'tin cũ', ts: Date.now() - 10_000 },
    }], threadType));
  };
  const server = startHermesBridge({ api: { listener }, profile: { user_id: 'bot' }, port: 0, store: testStore(t), ownerUids: ['owner'] });
  await new Promise((resolve) => server.once('listening', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);

  try {
    const hello = onceMessage(ws, (msg) => msg.type === 'hello');
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await hello;
    ws.send(JSON.stringify({ type: 'history', reqId: 'h2', threadId: 'u1', threadType: 0, count: 30, auth: auth('u1', 0) }));
    const ack = await onceMessage(ws, (msg) => msg.type === 'ack' && msg.reqId === 'h2');
    assert.equal(ack.ok, true);
    assert.deepEqual(ack.result.messages.map((m) => m.msgId), ['old1']);
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('history survives bridge restart through SQLite', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'zalo-bridge-reopen-'));
  const path = join(dir, 'history.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const firstStore = openZaloStore({ path });
  let server = startHermesBridge({ api: {}, profile: { user_id: 'bot' }, port: 0, store: firstStore });
  await new Promise((resolve) => server.once('listening', resolve));
  const { rememberZaloMessage } = await import('./hermes-bridge.js');
  rememberZaloMessage({
    threadId: 'persisted-dm', type: 0, isSelf: false,
    data: { msgId: 'persisted-1', cliMsgId: 'persisted-c1', uidFrom: 'u1', content: 'còn đây', ts: Date.now() },
  });
  stopHermesBridge();
  firstStore.close();

  const secondStore = openZaloStore({ path });
  server = startHermesBridge({ api: {}, profile: { user_id: 'bot' }, port: 0, store: secondStore, ownerUids: ['owner'] });
  await new Promise((resolve) => server.once('listening', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);

  try {
    const hello = onceMessage(ws, (msg) => msg.type === 'hello');
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await hello;
    ws.send(JSON.stringify({ type: 'history', reqId: 'persisted-history', threadId: 'persisted-dm', threadType: 0, count: 1, auth: auth('persisted-dm', 0) }));
    const ack = await onceMessage(ws, (msg) => msg.type === 'ack' && msg.reqId === 'persisted-history');
    assert.equal(ack.ok, true);
    assert.deepEqual(ack.result.messages.map((message) => message.msgId), ['persisted-1']);
  } finally {
    ws.close();
    stopHermesBridge();
    secondStore.close();
  }
});

test('history backfill follows oldest message cursor across pages', async (t) => {
  const calls = [];
  const listener = new EventEmitter();
  listener.requestOldMessages = (threadType, cursor) => {
    calls.push([threadType, cursor]);
    const page = cursor == null
      ? [{ threadId: 'g-pages', type: 1, isSelf: false, data: { msgId: 'm-200', cliMsgId: 'c-200', uidFrom: 'u1', content: 'mới hơn', ts: Date.now() - 1_000 } }]
      : [{ threadId: 'g-pages', type: 1, isSelf: false, data: { msgId: 'm-100', cliMsgId: 'c-100', uidFrom: 'u1', content: 'cũ hơn', ts: Date.now() - 2_000 } }];
    queueMicrotask(() => listener.emit('old_messages', page, threadType));
  };
  const server = startHermesBridge({
    api: { listener }, profile: { user_id: 'bot' }, port: 0, store: testStore(t), maxBackfillPages: 2, ownerUids: ['owner'],
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);

  try {
    const hello = onceMessage(ws, (msg) => msg.type === 'hello');
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await hello;
    ws.send(JSON.stringify({ type: 'history', reqId: 'paged-history', threadId: 'g-pages', threadType: 1, count: 2, auth: auth('g-pages', 1) }));
    const ack = await onceMessage(ws, (msg) => msg.type === 'ack' && msg.reqId === 'paged-history');
    assert.equal(ack.ok, true);
    assert.deepEqual(calls, [[1, null], [1, 'm-200']]);
    assert.deepEqual(ack.result.messages.map((message) => message.msgId), ['m-100', 'm-200']);
    assert.equal(ack.result.backfill.pagesFetched, 2);
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('backfill stops when a page inserts no new messages', async (t) => {
  const calls = [];
  const listener = new EventEmitter();
  const repeated = {
    threadId: 'g-repeat', type: 1, isSelf: false,
    data: { msgId: 'repeat', cliMsgId: 'repeat-c', uidFrom: 'u1', content: 'trùng', ts: Date.now() },
  };
  listener.requestOldMessages = (threadType, cursor) => {
    calls.push(cursor);
    queueMicrotask(() => listener.emit('old_messages', [repeated], threadType));
  };
  const server = startHermesBridge({
    api: { listener }, profile: { user_id: 'bot' }, port: 0, store: testStore(t), maxBackfillPages: 10, ownerUids: ['owner'],
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);

  try {
    const hello = onceMessage(ws, (msg) => msg.type === 'hello');
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await hello;
    ws.send(JSON.stringify({ type: 'history', reqId: 'repeat-history', threadId: 'g-repeat', threadType: 1, count: 3, auth: auth('g-repeat', 1) }));
    const ack = await onceMessage(ws, (msg) => msg.type === 'ack' && msg.reqId === 'repeat-history');
    assert.equal(ack.ok, true);
    assert.deepEqual(calls, [null, 'repeat']);
    assert.equal(ack.result.backfill.status, 'completed');
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('concurrent history requests share one backfill job per thread type', async (t) => {
  let calls = 0;
  const listener = new EventEmitter();
  listener.requestOldMessages = (threadType) => {
    calls += 1;
    setTimeout(() => listener.emit('old_messages', [
      { threadId: 'g-shared', type: 1, data: { msgId: 'shared-2', cliMsgId: 'sc-2', uidFrom: 'u1', content: 'hai', ts: Date.now() } },
      { threadId: 'g-shared', type: 1, data: { msgId: 'shared-1', cliMsgId: 'sc-1', uidFrom: 'u1', content: 'một', ts: Date.now() - 1 } },
    ], threadType), 20);
  };
  const server = startHermesBridge({
    api: { listener }, profile: { user_id: 'bot' }, port: 0, store: testStore(t), ownerUids: ['owner'],
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  try {
    const hello = onceMessage(ws, (msg) => msg.type === 'hello');
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await hello;
    const first = onceMessage(ws, (msg) => msg.type === 'ack' && msg.reqId === 'shared-a');
    const second = onceMessage(ws, (msg) => msg.type === 'ack' && msg.reqId === 'shared-b');
    ws.send(JSON.stringify({ type: 'history', reqId: 'shared-a', threadId: 'g-shared', threadType: 1, count: 2, auth: auth('g-shared', 1) }));
    ws.send(JSON.stringify({ type: 'history', reqId: 'shared-b', threadId: 'g-shared', threadType: 1, count: 2, auth: auth('g-shared', 1) }));
    assert.equal((await first).result.count, 2);
    assert.equal((await second).result.count, 2);
    assert.equal(calls, 1);
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('backfill stops at retention boundary and removes expired messages', async (t) => {
  let calls = 0;
  const listener = new EventEmitter();
  listener.requestOldMessages = (threadType) => {
    calls += 1;
    queueMicrotask(() => listener.emit('old_messages', [{
      threadId: 'g-old', type: 1,
      data: { msgId: 'too-old', cliMsgId: 'too-old-c', uidFrom: 'u1', content: 'hết hạn', ts: Date.now() - 366 * 24 * 60 * 60 * 1000 },
    }], threadType));
  };
  const store = testStore(t);
  const server = startHermesBridge({
    api: { listener }, profile: { user_id: 'bot' }, port: 0, store, ownerUids: ['owner'], maxBackfillPages: 10,
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  try {
    const hello = onceMessage(ws, (msg) => msg.type === 'hello');
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await hello;
    ws.send(JSON.stringify({ type: 'history', reqId: 'old-history', threadId: 'g-old', threadType: 1, count: 10, auth: auth('g-old', 1) }));
    const ack = await onceMessage(ws, (msg) => msg.type === 'ack' && msg.reqId === 'old-history');
    assert.equal(calls, 1);
    assert.equal(ack.result.count, 0);
    assert.equal(store.getHealth().messageCount, 0);
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('automatic backfill reads both DM and group history without sending messages', async (t) => {
  const requested = [];
  let sends = 0;
  const listener = new EventEmitter();
  listener.requestOldMessages = (threadType) => {
    requested.push(threadType);
    queueMicrotask(() => listener.emit('old_messages', [], threadType));
  };
  const store = testStore(t);
  const health = createRuntimeHealth({ store });
  const server = startHermesBridge({
    api: { listener, sendMessage: () => { sends += 1; } },
    profile: { user_id: 'bot' }, port: 0, store, health,
  });
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    const result = await startAutomaticBackfill();
    assert.deepEqual(requested.sort(), [0, 1]);
    assert.equal(sends, 0);
    assert.deepEqual(result.map((state) => state.status), ['completed', 'completed']);
    assert.deepEqual(health.snapshot().backfill.map((state) => state.threadType), [0, 1]);
  } finally {
    stopHermesBridge();
  }
});

test('automatic backfill waits for the Zalo listener connection before requesting history', async (t) => {
  const requested = [];
  const listener = new EventEmitter();
  listener.ws = null;
  listener.requestOldMessages = (threadType) => {
    if (listener.ws?.readyState !== 1) throw new Error('WebSocket is not open');
    requested.push(threadType);
    queueMicrotask(() => listener.emit('old_messages', [], threadType));
  };
  const store = testStore(t);
  const server = startHermesBridge({
    api: { listener }, profile: { user_id: 'bot' }, port: 0,
    store, health: createRuntimeHealth({ store }),
  });
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    const backfill = startAutomaticBackfill();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(requested, []);

    listener.ws = { readyState: 1 };
    listener.emit('connected');
    const result = await backfill;
    assert.deepEqual(requested.sort(), [0, 1]);
    assert.deepEqual(result.map((state) => state.status), ['completed', 'completed']);
  } finally {
    stopHermesBridge();
  }
});

test('undo không có ID chỉ thu hồi tin mới nhất do bot gửi', async (t) => {
  const calls = [];
  const listener = new EventEmitter();
  listener.requestOldMessages = () => {};
  const api = { listener, undo: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } };
  const server = startHermesBridge({ api, profile: { user_id: 'bot' }, port: 0, store: testStore(t), ownerUids: ['owner'] });
  await new Promise((resolve) => server.once('listening', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);

  try {
    const hello = onceMessage(ws, (msg) => msg.type === 'hello');
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await hello;
    const { rememberZaloMessage } = await import('./hermes-bridge.js');
    rememberZaloMessage({ threadId: 'g1', type: 1, isSelf: false, data: { msgId: 'their', cliMsgId: 'theirc', uidFrom: 'u1', content: 'người khác', ts: 20 } });
    rememberZaloMessage({ threadId: 'g1', type: 1, isSelf: true, data: { msgId: 'mine', cliMsgId: 'minec', uidFrom: 'bot', content: 'của bot', ts: 21 } });

    ws.send(JSON.stringify({ type: 'undo', reqId: 'u1', threadId: 'g1', threadType: 1, auth: auth('g1', 1, { confirmed: true }) }));
    const ack = await onceMessage(ws, (msg) => msg.type === 'ack' && msg.reqId === 'u1');
    assert.equal(ack.ok, true);
    assert.deepEqual(calls, [[{ msgId: 'mine', cliMsgId: 'minec' }, 'g1', 1]]);
    assert.equal(ack.result.msgId, 'mine');
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('undo từ chối ID của tin do người khác gửi', async (t) => {
  const calls = [];
  const listener = new EventEmitter();
  listener.requestOldMessages = () => {};
  const api = { listener, undo: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } };
  const server = startHermesBridge({ api, profile: { user_id: 'bot' }, port: 0, store: testStore(t), ownerUids: ['owner'] });
  await new Promise((resolve) => server.once('listening', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);

  try {
    const hello = onceMessage(ws, (msg) => msg.type === 'hello');
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await hello;
    const { rememberZaloMessage } = await import('./hermes-bridge.js');
    rememberZaloMessage({ threadId: 'g1', type: 1, isSelf: false, data: { msgId: 'their', cliMsgId: 'theirc', uidFrom: 'u1', content: 'người khác', ts: 20 } });

    ws.send(JSON.stringify({
      type: 'undo', reqId: 'u2', threadId: 'g1', threadType: 1,
      msgId: 'their', cliMsgId: 'theirc',
      auth: auth('g1', 1, { confirmed: true }),
    }));
    const ack = await onceMessage(ws, (msg) => msg.type === 'ack' && msg.reqId === 'u2');
    assert.equal(ack.ok, false);
    assert.match(ack.error, /chính bot/);
    assert.deepEqual(calls, []);
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('invoke không thể đi vòng qua kiểm tra an toàn của undo', async (t) => {
  const calls = [];
  const api = { undo: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } };
  const server = startHermesBridge({ api, profile: { user_id: 'bot' }, port: 0, store: testStore(t) });
  await new Promise((resolve) => server.once('listening', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);

  try {
    const hello = onceMessage(ws, (msg) => msg.type === 'hello');
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await hello;
    ws.send(JSON.stringify({
      type: 'invoke', reqId: 'u3', method: 'undo',
      args: [{ msgId: 'their', cliMsgId: 'theirc' }, 'g1', 1],
      auth: auth('g1', 1, { confirmed: true }),
    }));
    const ack = await onceMessage(ws, (msg) => msg.type === 'ack' && msg.reqId === 'u3');
    assert.equal(ack.ok, false);
    assert.match(ack.error, /không được phép/);
    assert.deepEqual(calls, []);
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('bridge rejects an unauthorized admin command before calling Zalo and audits it', async (t) => {
  const calls = [];
  const store = testStore(t);
  const api = { removeUserFromGroup: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } };
  const server = startHermesBridge({ api, profile: { user_id: 'bot' }, port: 0, store, ownerUids: ['owner'] });
  await new Promise((resolve) => server.once('listening', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);

  try {
    const hello = onceMessage(ws, (msg) => msg.type === 'hello');
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await hello;
    ws.send(JSON.stringify({
      type: 'invoke', reqId: 'denied-admin', method: 'removeUserFromGroup',
      args: [['victim'], 'group-1'], auth: auth('group-1', 1, { actorUid: 'member' }),
    }));
    const ack = await onceMessage(ws, (msg) => msg.type === 'ack' && msg.reqId === 'denied-admin');
    assert.equal(ack.ok, false);
    assert.equal(ack.errorCode, 'owner_required');
    assert.deepEqual(calls, []);
    assert.deepEqual(store.getAuditTrail('denied-admin').map((row) => row.status), ['attempted', 'failed']);
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('rich-media invoke persists its outbound IDs for later undo', async (t) => {
  const store = testStore(t);
  const api = {
    sendVoice: () => Promise.resolve({ message: { msgId: 'voice-m', cliMsgId: 'voice-c' } }),
  };
  const server = startHermesBridge({ api, profile: { user_id: 'bot' }, port: 0, store, ownerUids: ['owner'] });
  await new Promise((resolve) => server.once('listening', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  try {
    const hello = onceMessage(ws, (msg) => msg.type === 'hello');
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await hello;
    ws.send(JSON.stringify({
      type: 'invoke', reqId: 'voice-send', method: 'sendVoice',
      args: [{ voiceUrl: 'https://example.test/a.aac' }, 'group-1', 1],
      auth: auth('group-1', 1),
    }));
    assert.equal((await onceMessage(ws, (msg) => msg.reqId === 'voice-send')).ok, true);
    const saved = store.findOwnMessage('bot', 'group-1', 1, { msgId: 'voice-m', cliMsgId: 'voice-c' });
    assert.equal(saved.msgId, 'voice-m');
    assert.equal(saved.cliMsgId, 'voice-c');
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('bridge audits successful and failed owner administration without payload secrets', async (t) => {
  const errorLog = [];
  t.mock.method(console, 'error', (...args) => errorLog.push(args.join(' ')));
  const store = testStore(t);
  const api = {
    changeGroupName: () => Promise.resolve({ ok: true }),
    removeUserFromGroup: () => Promise.reject(new Error('C:\\private\\session.json access_token=secret-value')),
  };
  const server = startHermesBridge({ api, profile: { user_id: 'bot' }, port: 0, store, ownerUids: ['owner'] });
  await new Promise((resolve) => server.once('listening', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);

  try {
    const hello = onceMessage(ws, (msg) => msg.type === 'hello');
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await hello;
    ws.send(JSON.stringify({
      type: 'invoke', reqId: 'admin-ok', method: 'changeGroupName',
      args: ['Tên bí mật', 'group-1'], auth: auth('owner', 0, { confirmed: true }),
    }));
    assert.equal((await onceMessage(ws, (msg) => msg.type === 'ack' && msg.reqId === 'admin-ok')).ok, true);

    ws.send(JSON.stringify({
      type: 'invoke', reqId: 'admin-fail', method: 'removeUserFromGroup',
      args: [['victim'], 'group-1'], auth: auth('owner', 0, { confirmed: true }),
    }));
    assert.equal((await onceMessage(ws, (msg) => msg.type === 'ack' && msg.reqId === 'admin-fail')).ok, false);

    assert.deepEqual(store.getAuditTrail('admin-ok').map((row) => row.status), ['attempted', 'succeeded']);
    assert.deepEqual(store.getAuditTrail('admin-fail').map((row) => row.status), ['attempted', 'failed']);
    const serialized = JSON.stringify([...store.getAuditTrail('admin-ok'), ...store.getAuditTrail('admin-fail')]);
    assert.equal(serialized.includes('Tên bí mật'), false);
    assert.equal(serialized.includes('victim'), false);
    assert.equal(serialized.includes('secret-value'), false);
    assert.equal(serialized.includes('session.json'), false);
    assert.equal(store.getAuditTrail('admin-fail')[1].error, 'operation_failed');
    assert.equal(store.getAuditTrail('admin-ok')[0].targetSummary.threadId, 'group-1');
    assert.equal(errorLog.join('\n').includes('secret-value'), false);
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('tin system (kết quả cron) gửi được vào nhóm không phải kênh nhà', async (t) => {
  const store = testStore(t);
  const sent = [];
  const api = {
    sendMessage: (content, threadId, type) => {
      sent.push([content.msg, threadId, type]);
      return Promise.resolve({ message: { msgId: 'cron-m', cliMsgId: 'cron-c' } });
    },
  };
  const server = startHermesBridge({ api, profile: { user_id: 'bot' }, port: 0, store, ownerUids: ['owner'] });
  await new Promise((resolve) => server.once('listening', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);

  try {
    const hello = onceMessage(ws, (msg) => msg.type === 'hello');
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await hello;
    ws.send(JSON.stringify({
      type: 'send', reqId: 'cron-send', threadId: 'group-9', threadType: 1, text: 'Nhắc họp',
      auth: { actorUid: '', actorRole: 'system', sourceThreadId: '', sourceThreadType: 0, confirmed: false },
    }));
    const ack = await onceMessage(ws, (msg) => msg.type === 'ack' && msg.reqId === 'cron-send');
    assert.equal(ack.ok, true);
    assert.deepEqual(sent, [['Nhắc họp', 'group-9', 1]]);
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('audit ghi mã cron khi lệnh do một việc hẹn giờ phát ra', async (t) => {
  const store = testStore(t);
  const api = { changeGroupName: () => Promise.resolve({ ok: true }) };
  const server = startHermesBridge({ api, profile: { user_id: 'bot' }, port: 0, store, ownerUids: ['owner'] });
  await new Promise((resolve) => server.once('listening', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);

  try {
    const hello = onceMessage(ws, (msg) => msg.type === 'hello');
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await hello;
    ws.send(JSON.stringify({
      type: 'invoke', reqId: 'cron-admin', method: 'changeGroupName', args: ['Tên mới', 'group-1'],
      auth: { ...auth('owner', 0, { confirmed: true }), cronJobId: 'job-9' },
    }));
    assert.equal((await onceMessage(ws, (msg) => msg.type === 'ack' && msg.reqId === 'cron-admin')).ok, true);
    assert.equal(store.getAuditTrail('cron-admin')[0].targetSummary.cronJobId, 'job-9');
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('bridge ping returns pong and refreshes runtime heartbeat', async (t) => {
  const store = testStore(t);
  const health = createRuntimeHealth({ store });
  const server = startHermesBridge({ api: {}, profile: { user_id: 'bot' }, port: 0, store, health });
  await new Promise((resolve) => server.once('listening', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);

  try {
    const hello = onceMessage(ws, (msg) => msg.type === 'hello');
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await hello;
    ws.send(JSON.stringify({ type: 'ping' }));
    const pong = await onceMessage(ws, (msg) => msg.type === 'pong');
    assert.equal(Number.isFinite(pong.ts), true);
    assert.equal(health.snapshot().bridge.attachedClients, 1);
    assert.equal(health.snapshot().bridge.staleClients, 0);
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('bridge closes a client whose application heartbeat is stale', async (t) => {
  const store = testStore(t);
  const health = createRuntimeHealth({ store, staleAfterMs: 25 });
  const server = startHermesBridge({
    api: {}, profile: { user_id: 'bot' }, port: 0, store, health, staleCheckIntervalMs: 10,
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);

  const hello = onceMessage(ws, (msg) => msg.type === 'hello');
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await hello;
  await new Promise((resolve) => ws.once('close', resolve));

  assert.equal(health.snapshot().bridge.attachedClients, 0);
  stopHermesBridge();
});

test('Hermes-unavailable system notice is audited outside the WebSocket command path', async (t) => {
  const store = testStore(t);
  const calls = [];
  const api = {
    sendMessage: (...args) => {
      calls.push(args);
      return Promise.resolve({ message: { msgId: 'notice-1', cliMsgId: 'notice-c1' } });
    },
  };
  const server = startHermesBridge({ api, profile: { user_id: 'bot' }, port: 0, store });
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const result = await sendSystemNotice({
      api, threadId: 'dm-1', threadType: 0, text: 'tạm thời chưa sẵn sàng',
    });
    assert.equal(result.message.msgId, 'notice-1');
    assert.equal(calls.length, 1);
    const health = store.getHealth();
    assert.equal(health.auditCount, 2);
    assert.equal(health.messageCount, 1);
  } finally {
    stopHermesBridge();
  }
});

test('tin sticker đã tra nhãn đi sang Hermes thành chữ kèm ảnh nhãn dán', async (t) => {
  const server = startHermesBridge({ api: {}, profile: { user_id: 'bot-uid' }, port: 0, store: testStore(t) });
  await new Promise((resolve) => server.once('listening', resolve));

  const { port } = server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);

  try {
    const hello = onceMessage(ws, (msg) => msg.type === 'hello');
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    await hello;

    const incoming = onceMessage(ws, (msg) => msg.type === 'message');
    const { forwardToHermes } = await import('./hermes-bridge.js');
    const { createStickerDirectory, enrichSticker } = await import('./zalo-stickers.js');
    const frame = {
      threadId: 'g1',
      type: 1,
      data: {
        msgId: 'st1', cliMsgId: 'c-st1', uidFrom: 'u1', dName: 'Trang',
        msgType: 'chat.sticker',
        content: { id: 4001, catId: 10, type: 7 },
        ts: 123,
      },
    };
    await enrichSticker(frame, createStickerDirectory({
      fetchDetail: () => [{ id: 4001, text: 'cười lăn', stickerUrl: 'https://zalo.vn/sticker/4001.png' }],
    }));
    forwardToHermes(frame);
    const payload = await incoming;

    // Trước đây tin sticker sang Hermes rỗng tuếch nên bot không biết có gì.
    assert.equal(payload.text, '[Nhãn dán: cười lăn]');
    assert.deepEqual(payload.mediaUrls, ['https://zalo.vn/sticker/4001.png']);
    assert.deepEqual(payload.mediaTypes, ['image/png']);
    assert.deepEqual(payload.attachments, [{
      url: 'https://zalo.vn/sticker/4001.png', name: 'sticker-4001.png', mime: 'image/png', kind: 'image',
    }]);
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('người trong nhóm tra được chi tiết nhãn dán qua cầu nối', async (t) => {
  // Hai danh sách phải khớp nhau: zalo-policy cho phép vai công khai, còn
  // ALLOWED_METHODS của cầu nối phải có tên hàm, thiếu một bên là bị từ chối.
  const api = {
    getStickersDetail: (id) => Promise.resolve([{ id, text: 'cười lăn', stickerUrl: 'https://zalo.vn/s.png' }]),
  };
  const server = startHermesBridge({ api, profile: { user_id: 'bot' }, port: 0, store: testStore(t), ownerUids: ['owner'] });
  await new Promise((resolve) => server.once('listening', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  try {
    const hello = onceMessage(ws, (msg) => msg.type === 'hello');
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await hello;
    ws.send(JSON.stringify({
      type: 'invoke', reqId: 'sticker-detail', method: 'getStickersDetail', args: [27703],
      auth: auth('group-1', 1, { actorUid: 'nguoi-trong-nhom' }),
    }));
    const ack = await onceMessage(ws, (msg) => msg.reqId === 'sticker-detail');
    assert.equal(ack.ok, true);
    assert.equal(ack.result[0].text, 'cười lăn');
  } finally {
    ws.close();
    stopHermesBridge();
  }
});
