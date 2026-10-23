import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createDashboardApp } from './app.js';
import { createUserStore } from './lib/users.js';
import { createSessionStore } from './lib/sessions.js';
import { createLoginGuard } from './lib/login-guard.js';
import { createSetupToken } from './lib/setup-token.js';
import { createActivityLog } from './lib/activity-log.js';
import { createTelegramApi, createTelegramLinker } from './lib/telegram.js';
import { openZaloStore } from '../zalo-store.js';
import { createStoreReader } from './lib/store-reader.js';
import { createAuditCleaner } from './lib/audit-cleaner.js';
import { createThreadNames } from './lib/thread-names.js';
import { createPermissionsStore } from './lib/permissions.js';
import { createBrandStore } from './lib/brand.js';
import { createPeopleStore } from './lib/people-store.js';
import { createHermesMemory } from './lib/hermes-memory.js';
import { createOwnersStore } from './lib/owners.js';
import { createInsightAi } from './lib/insight-ai.js';
import { createRestartFlags } from './lib/restart-flags.js';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** Ảnh PNG thật (RGBA, một màu) cỡ width × height — đủ để trình duyệt và bộ kiểm logo nhận. */
export function pngOf(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bit, RGBA
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 4, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function fakeSidecar(overrides = {}) {
  const calls = [];
  return {
    calls,
    health: async () => ({ status: 'healthy', zalo: { status: 'logged-in', listener: 'connected', needsRelogin: false, displayName: 'Uyển Nhi' },
      bridge: { attachedClients: 1 }, traffic: { lastInboundAtMs: 1, lastOutboundAtMs: 2 }, lastError: null }),
    loginCode: async (m) => { calls.push(['code', m]); },
    qrStart: async () => { calls.push('qr-start'); },
    qr: async () => ({ status: 'qr-pending', image: 'data:image/png;base64,AAA', user: null }),
    logout: async () => { calls.push('logout'); },
    send: async (m) => { calls.push(['send', m]); return { msgId: '999' }; },
    groups: async () => [{ id: '200', name: 'Tổ Hoá', members: 12 }],
    friends: async () => [{ uid: '1111111111111111111', name: 'Lan', zaloName: 'lan' }],
    friendRequests: async () => [{ uid: '2222222222222222222', name: 'Minh', message: 'Chào bot', at: 1 }],
    answerFriendRequest: async (m) => { calls.push(['answer', m]); return {}; },
    reminders: async (m) => { calls.push(['reminders', m]); return [{ id: '77', title: 'Họp tổ', startAt: 1, repeat: 0, creatorUid: 'bot', mine: true, createdAt: 1 }]; },
    removeReminder: async (m) => { calls.push(['remove-reminder', m]); return {}; },
    ...overrides,
  };
}

export function fakeBot({ failGetMe = false } = {}) {
  const sent = []; const updates = [];
  const fetchImpl = async (url, opts) => {
    const method = url.split('/').pop();
    const body = opts?.body ? JSON.parse(opts.body) : {};
    const reply = (result) => ({ ok: true, json: async () => ({ ok: true, result }) });
    if (method === 'getMe') {
      if (failGetMe) return { ok: true, json: async () => ({ ok: false, description: 'Unauthorized' }) };
      return reply({ username: 'canhbao_bot' });
    }
    if (method === 'sendMessage') { sent.push(body); return reply({ message_id: 1 }); }
    if (method === 'getUpdates') return reply(updates.filter((x) => x.update_id >= (body.offset || 0)));
    throw new Error(method);
  };
  return { sent, fetchImpl, push: (u) => { updates.push(u); } };
}

/** Sức khoẻ máy chủ giả: một lần đo, hai điểm lịch sử, ba dịch vụ, một ngày dùng AI. */
export function fakeHealth(overrides = {}) {
  return {
    latest: () => ({ at: 1, cpuPct: 12.5, ramPct: 61, ramUsedMb: 2390, ramTotalMb: 3915, diskPct: 50, diskUsedGb: 14, diskTotalGb: 28, uptimeSec: 3600, cores: 4 }),
    points: () => [[0, 10, 60, 50], [60_000, 12.5, 61, 50]],
    usage: () => ({ since: 0, error: null, days: [{ date: '2026-10-07', calls: 6, input: 85206, output: 4968, cached: 73327 }] }),
    services: async () => [
      { id: 'zalo-bridge', label: 'Kết nối Zalo', state: 'up', detail: 'zalo-bridge.service · active/running' },
      { id: 'hermes-gateway', label: 'Trợ lý (Hermes)', state: 'down', detail: 'hermes-gateway.service · failed/failed' },
      { id: '9router', label: 'Cổng AI (9router)', state: 'up', detail: '9router.service · active/running' },
    ],
    ...overrides,
  };
}

export function makeDeps(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zd-app-'));
  const bot = overrides.bot || fakeBot();
  const sidecar = overrides.sidecar || fakeSidecar();
  const deps = {
    bot,
    linker: createTelegramLinker({ file: join(dir, 'telegram.json'), apiFactory: (token) => createTelegramApi({ token, fetchImpl: bot.fetchImpl }) }),
    config: { port: 3880, publicUrl: 'http://localhost:3880', restartCmd: null },
    users: createUserStore(join(dir, 'users.json')),
    sessions: createSessionStore(join(dir, 'sessions.json')),
    guard: createLoginGuard({}),
    setupToken: createSetupToken(join(dir, 'setup.json')),
    activity: createActivityLog(join(dir, 'activity.jsonl')),
    permissions: createPermissionsStore({ file: join(dir, 'zalo', 'permissions.json') }),
    sidecar,
    store: createStoreReader({ path: join(dir, 'zalo.sqlite') }),
    auditCleaner: createAuditCleaner({ path: join(dir, 'zalo.sqlite') }),
    threadNames: createThreadNames({ loadGroups: () => sidecar.groups() }),
    restartAssistant: async () => {},
    restartSidecar: async () => {},
    restartFlags: createRestartFlags({ file: join(dir, 'restart-flags.json') }),
    owners: createOwnersStore({ envFile: join(dir, 'hermes.env'), sidecarEnvFile: join(dir, 'sidecar.env'), pendingFile: join(dir, 'pending-restart.json') }),
    brand: createBrandStore({ file: join(dir, 'brand.json'), logoFile: join(dir, 'brand', 'logo.png') }),
    health: fakeHealth(),
    studioUsageFile: join(dir, 'zalo', 'studio-usage.json'),
    people: createPeopleStore({ file: join(dir, 'zalo', 'people.json') }),
    agentMemory: createHermesMemory({ hermesHome: dir, configFile: join(dir, 'config.yaml') }),
    insightAi: createInsightAi({ dir: join(dir, 'zalo', 'insight') }),
    publicDir: join(dir, 'public'),
    dir,
    ...overrides,
  };
  t.after(() => {
    try { deps.store?.close(); } catch { /* đã đóng */ }
    rmSync(dir, { recursive: true, force: true });
  });
  return deps;
}

let seq = 0;
/** Một tin mẫu đúng dạng zalo-store.insertMessages. */
export function chatMsg(over = {}) {
  seq += 1;
  return { threadId: '100', threadType: 0, msgId: `m${seq}`, senderUid: '100', senderName: 'Lan', text: `tin ${seq}`, msgType: 'webchat', ts: 1_000_000 + seq, isSelf: false, ...over };
}

/** Ghi lịch sử/nhật ký mẫu bằng chính zalo-store của bot vào <deps.dir>/zalo.sqlite. */
export function seedHistory(deps, { account = 'bot1', messages = [], audits = [] } = {}) {
  let clock = Date.now();
  const store = openZaloStore({ path: join(deps.dir, 'zalo.sqlite'), now: () => clock });
  try {
    if (messages.length) store.insertMessages(account, messages, 'live');
    for (const a of audits) {
      clock = a.at ?? Date.now();
      store.beginAudit({ accountId: account, category: 'send', ...a });
      if (a.status) store.finishAudit(a.requestId, a.status, { error: a.error });
    }
  } finally { store.close(); }
}

export async function startApp(t, deps) {
  const app = createDashboardApp(deps);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(path, { method = 'GET', body, cookie, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'zalo-dashboard', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    let json = null;
    try { json = await res.json(); } catch { /* không phải JSON */ }
    return { status: res.status, json, cookie: setCookie ? setCookie.split(';')[0] : null, headers: res.headers };
  }
  return { base, call };
}

export async function loginAs(t, deps, call, { username = 'anh', role = 'admin', password = 'matkhau-dai', zaloUid = '1234567890123456' } = {}) {
  if (!deps.users.get(username)) deps.users.create({ username, role, password, zaloUid });
  const res = await call('/api/auth/verify', { method: 'POST', body: { username, password } });
  if (res.status !== 200) throw new Error(`login failed ${res.status} ${JSON.stringify(res.json)}`);
  return res.cookie;
}
