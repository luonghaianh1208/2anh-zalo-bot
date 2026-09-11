import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket as RawWebSocket } from 'ws';
import { ThreadType } from 'zca-js';
import { setupBotListener } from './bot-handler.js';
import { startHermesBridge, stopHermesBridge } from './hermes-bridge.js';
import { openZaloStore } from './zalo-store.js';

process.env.ZALO_BRIDGE_TOKEN ||= 'test-bridge-token';

class WebSocket extends RawWebSocket {
  constructor(url, options) {
    const authenticated = new URL(url);
    authenticated.searchParams.set('token', process.env.ZALO_BRIDGE_TOKEN);
    super(authenticated.toString(), options);
  }
}

class FakeListener extends EventEmitter {
  starts = [];
  stops = 0;
  start(options) { this.starts.push(options); }
  stop() { this.stops += 1; }
}

function fakeHealth() {
  const states = [];
  const errors = [];
  return {
    states,
    errors,
    setListenerState: (state) => states.push(state),
    recordError: (code) => errors.push(code),
  };
}

const LISTENER_EVENTS = ['message', 'error', 'connected', 'disconnected', 'closed'];

test('listener cleanup detaches handlers and stops exactly once', () => {
  const listener = new FakeListener();
  const cleanup = setupBotListener({ listener }, { user_id: 'bot' });
  assert.equal(listener.starts.length, 1);
  for (const event of LISTENER_EVENTS) assert.equal(listener.listenerCount(event), 1, event);
  cleanup();
  cleanup();
  assert.equal(listener.stops, 1);
  for (const event of LISTENER_EVENTS) assert.equal(listener.listenerCount(event), 0, event);
});

test('listener bật retryOnClose và báo trạng thái kết nối cho health', () => {
  const listener = new FakeListener();
  const health = fakeHealth();
  const cleanup = setupBotListener({ listener }, { user_id: 'bot' }, { health });

  assert.deepEqual(listener.starts, [{ retryOnClose: true }]);
  listener.emit('connected');
  listener.emit('disconnected', 1006, '');
  assert.deepEqual(health.states, ['starting', 'connected', 'reconnecting']);

  cleanup();
  assert.equal(health.states.at(-1), null);
});

test('listener đóng hẳn thì tự mở lại, kết nối lại được thì nhịp chờ quay về mức đầu', async () => {
  const listener = new FakeListener();
  const health = fakeHealth();
  const cleanup = setupBotListener({ listener }, { user_id: 'bot' }, { health, restartDelaysMs: [5, 60_000] });

  listener.emit('closed', 1006, '');
  assert.equal(health.states.at(-1), 'closed');
  assert.deepEqual(health.errors, ['zalo_listener_closed']);
  await waitFor(() => listener.starts.length === 2, 'lần mở lại thứ nhất');

  listener.emit('connected');
  listener.emit('closed', 1006, '');
  await waitFor(() => listener.starts.length === 3, 'lần mở lại sau khi đã kết nối lại');
  cleanup();
});

test('đã dọn listener thì lịch mở lại bị huỷ', async () => {
  const listener = new FakeListener();
  const cleanup = setupBotListener({ listener }, { user_id: 'bot' }, { restartDelaysMs: [5] });

  listener.emit('closed', 1006, '');
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(listener.starts.length, 1);
});

test('start ném lỗi thì hẹn thử lại thay vì bỏ cuộc', async () => {
  const listener = new FakeListener();
  let failFirst = true;
  listener.start = function start(options) {
    this.starts.push(options);
    if (failFirst) {
      failFirst = false;
      throw new Error('boom');
    }
  };
  const cleanup = setupBotListener({ listener }, { user_id: 'bot' }, { restartDelaysMs: [5] });

  await waitFor(() => listener.starts.length === 2, 'thử lại sau lỗi start');
  cleanup();
});

function waitFor(predicate, message = 'condition') {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 1_000;
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`timeout waiting for ${message}`));
      setTimeout(check, 5);
    };
    check();
  });
}

function onceMessage(ws, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ws message')), 1_000);
    ws.on('message', function onMessage(raw) {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(message);
    });
  });
}

async function harness(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-handler-'));
  const store = openZaloStore({ path: join(dir, 'history.sqlite') });
  const listener = new EventEmitter();
  listener.start = () => {};
  const sent = [];
  const api = {
    listener,
    sendMessage: (...args) => {
      sent.push(args);
      return Promise.resolve({ message: { msgId: `sent-${sent.length}`, cliMsgId: `sent-c-${sent.length}` } });
    },
  };
  const server = startHermesBridge({ api, profile: { user_id: 'bot-uid' }, port: 0, store });
  await new Promise((resolve) => server.once('listening', resolve));
  const cleanup = setupBotListener(api, { user_id: 'bot-uid' });
  t.after(() => {
    cleanup();
    stopHermesBridge();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { api, listener, sent, server };
}

function incoming({ text = '/sethome', senderUid = 'owner-123', threadId = 'dm-1', type = ThreadType.User } = {}) {
  return {
    threadId,
    type,
    isSelf: false,
    data: {
      msgId: `msg-${threadId}`,
      cliMsgId: `cli-${threadId}`,
      uidFrom: senderUid,
      dName: 'Người cài đặt',
      content: text,
      mentions: [],
      ts: Date.now(),
    },
  };
}

test('disconnected exact DM /sethome reveals the sender UID without granting owner access', async (t) => {
  const { listener, sent } = await harness(t);

  listener.emit('message', incoming({ senderUid: 'uid-123', threadId: 'uid-123' }));
  await waitFor(() => sent.length === 1, 'bootstrap reply');

  const [content, threadId, threadType] = sent[0];
  assert.equal(threadId, 'uid-123');
  assert.equal(threadType, ThreadType.User);
  assert.match(content.msg, /UID Zalo của bạn:\s*uid-123/);
  assert.match(content.msg, /ZALO_ALLOWED_USERS=uid-123/);
  assert.match(content.msg, /ZALO_HOME_CHANNEL=uid-123/);
  assert.match(content.msg, /chưa (?:được )?cấp quyền chủ/i);
  assert.match(content.msg, /khởi động lại sidecar/i);
  assert.match(content.msg, /gateway/i);
});

test('disconnected /sethome matching trims whitespace and ignores case', async (t) => {
  const { listener, sent } = await harness(t);

  listener.emit('message', incoming({ text: '  /SeThOmE \n', senderUid: 'uid-case', threadId: 'uid-case' }));
  await waitFor(() => sent.length === 1, 'case-insensitive bootstrap reply');

  assert.match(sent[0][0].msg, /ZALO_ALLOWED_USERS=uid-case/);
});

test('disconnected group /sethome never bootstraps', async (t) => {
  const { listener, sent } = await harness(t);

  listener.emit('message', incoming({ type: ThreadType.Group, threadId: 'group-1' }));
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(sent.length, 0);
});

test('disconnected non-command DM from a non-owner remains ignored', async (t) => {
  const { listener, sent } = await harness(t);

  listener.emit('message', incoming({ text: 'xin chào', senderUid: 'public-1', threadId: 'public-1' }));
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(sent.length, 0);
});

test('attached /sethome is forwarded to Hermes instead of bootstrapping', async (t) => {
  const { listener, sent, server } = await harness(t);
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  t.after(() => ws.close());
  const hello = onceMessage(ws, (message) => message.type === 'hello');
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await hello;

  const forwarded = onceMessage(ws, (message) => message.type === 'message');
  listener.emit('message', incoming({ senderUid: 'uid-attached', threadId: 'uid-attached' }));
  const message = await forwarded;

  assert.equal(message.senderUid, 'uid-attached');
  assert.equal(message.text, '/sethome');
  assert.equal(sent.length, 0);
});

test('disconnected /sethome without sender UID is ignored safely', async (t) => {
  const { listener, sent } = await harness(t);

  listener.emit('message', incoming({ senderUid: '', threadId: 'dm-no-sender' }));
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(sent.length, 0);
});
