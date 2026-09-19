import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket as RawWebSocket } from 'ws';
import { ThreadType } from 'zca-js';
import { loadGuestGroups, loadRoster } from './zalo-roster.js';
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

async function harness(t, { roster, guestGroups } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-handler-'));
  const rosterPath = join(dir, 'roster.json');
  const groupsPath = join(dir, 'guest-groups.json');
  const oldRoster = process.env.ZALO_ROSTER_FILE;
  const oldGroups = process.env.ZALO_GUEST_GROUPS_FILE;
  writeFileSync(rosterPath, JSON.stringify(roster || { version: 1, owners: ['owner'], guests: ['guest'] }));
  writeFileSync(groupsPath, JSON.stringify(guestGroups || { version: 1, guestGroups: ['group-allowed'] }));
  process.env.ZALO_ROSTER_FILE = rosterPath;
  process.env.ZALO_GUEST_GROUPS_FILE = groupsPath;
  const store = openZaloStore({ path: join(dir, 'history.sqlite') });
  const listener = new EventEmitter();
  listener.start = () => {};
  const api = { listener, sendMessage: () => Promise.resolve({ message: { msgId: 'sent', cliMsgId: 'sent-c' } }) };
  const server = startHermesBridge({ api, profile: { user_id: 'bot' }, port: 0, store });
  await new Promise((resolve) => server.once('listening', resolve));
  const cleanup = setupBotListener(api, { user_id: 'bot' }, { roster: loadRoster(rosterPath), guestGroups: loadGuestGroups(groupsPath) });
  t.after(() => {
    cleanup(); stopHermesBridge(); store.close(); rmSync(dir, { recursive: true, force: true });
    if (oldRoster === undefined) delete process.env.ZALO_ROSTER_FILE; else process.env.ZALO_ROSTER_FILE = oldRoster;
    if (oldGroups === undefined) delete process.env.ZALO_GUEST_GROUPS_FILE; else process.env.ZALO_GUEST_GROUPS_FILE = oldGroups;
  });
  return { listener, server, store, groupsPath };
}

function incoming({ senderUid, threadId, type = ThreadType.Group, text = 'hello', messageId = 'message' }) {
  return { threadId, type, isSelf: false, data: { msgId: messageId, cliMsgId: `cli-${messageId}`, uidFrom: senderUid, dName: 'name', content: text, mentions: [], ts: Date.now() } };
}

test('denied messages and owner group frames never enter rolling guest context', async (t) => {
  const { listener, server, store } = await harness(t);
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  t.after(() => ws.close());
  const hello = onceMessage(ws, (message) => message.type === 'hello');
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await hello;
  const forwarded = [];
  ws.on('message', (raw) => { const message = JSON.parse(raw.toString()); if (message.type === 'message') forwarded.push(message); });
  listener.emit('message', incoming({ senderUid: 'guest', threadId: 'group-allowed', messageId: 'allowed' }));
  listener.emit('message', incoming({ senderUid: 'guest', threadId: 'group-denied', messageId: 'denied' }));
  listener.emit('message', incoming({ senderUid: 'owner', threadId: 'group-allowed', messageId: 'owner' }));
  await waitFor(() => forwarded.length === 2, 'admitted frames');
  assert.deepEqual(forwarded.map((item) => item.senderUid), ['guest', 'owner']);
  assert.equal(store.getHealth().messageCount, 1);
});

test('guest group scope reload removes access without recreating sidecar', async (t) => {
  const { listener, server, groupsPath } = await harness(t);
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  t.after(() => ws.close());
  const hello = onceMessage(ws, (message) => message.type === 'hello');
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await hello;
  const forwarded = [];
  ws.on('message', (raw) => { const message = JSON.parse(raw.toString()); if (message.type === 'message') forwarded.push(message); });
  listener.emit('message', incoming({ senderUid: 'guest', threadId: 'group-allowed', messageId: 'before' }));
  await waitFor(() => forwarded.length === 1, 'first guest frame');
  writeFileSync(groupsPath, JSON.stringify({ version: 1, guestGroups: [] }));
  listener.emit('message', incoming({ senderUid: 'guest', threadId: 'group-allowed', messageId: 'after' }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(forwarded.length, 1);
});
