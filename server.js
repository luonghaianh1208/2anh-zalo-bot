import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { loadRepoEnv, loadHermesEnv } from './scripts/setup-env.js';
import { Zalo } from 'zca-js';
import { tryReconnect, saveSession, clearSession, fetchProfile, zaloOptions } from './auth.js';
import { setupBotListener } from './bot-handler.js';
import { startAutomaticBackfill, startHermesBridge, stopHermesBridge, isHermesAttached, sendSystemNotice, auditDashboardAction, acquireSendQuota } from './hermes-bridge.js';
import { openZaloStore } from './zalo-store.js';
import { createRuntimeHealth } from './runtime-health.js';
import { importLegacyHermesHistory } from './legacy-history-import.js';
import { installFileLog } from './file-log.js';
import { createQrLogin } from './qr-login.js';
import { createControlRouter } from './control-api.js';
import { createZaloDirectory } from './zalo-directory.js';
import { createGroupDirectory } from './group-directory.js';
import { createDmRules, permissionsFileFromEnv } from './dm-rules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
installFileLog({ path: join(__dirname, 'logs', 'sidecar.log') });
try {
  loadRepoEnv(join(__dirname, '.env'));
  loadHermesEnv();
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const zaloStore = openZaloStore({
  path: join(__dirname, 'data', 'zalo.sqlite'),
  retentionDays: Number(process.env.ZALO_HISTORY_RETENTION_DAYS) || 365,
});
const runtimeHealth = createRuntimeHealth({ store: zaloStore });
// Quyền nhắn riêng do dashboard ghi (permissions.json), đọc lại khi tệp đổi — lớp chặn thứ hai sau plugin.
const dmPermissionsFile = permissionsFileFromEnv();
if (!dmPermissionsFile) {
  console.warn('[dm] Không có HERMES_HOME hay ZALO_PERMISSIONS_FILE — lớp chặn thứ hai cho tin nhắn riêng đang tắt; chỉ còn cài đặt của Hermes. Đặt HERMES_HOME rồi khởi động lại kết nối Zalo để bật.');
}
const dmRules = createDmRules({ file: dmPermissionsFile });
zaloStore.pruneMessages();
const retentionTimer = setInterval(() => {
  try { zaloStore.pruneMessages(); } catch (error) {
    runtimeHealth.recordError('history_retention_failed', error?.message || error);
  }
}, 24 * 60 * 60 * 1000);
retentionTimer.unref?.();
const app = express();
const server = createServer(app);
// Chặn DNS rebinding: trang web lạ trỏ tên miền của nó về 127.0.0.1 thì trình
// duyệt coi là cùng origin, tự đặt được mọi header — chỉ Host còn lộ ra tên
// miền thật. Không chặn thì trang đó đăng xuất được bot và lấy được ảnh QR.
function isLocalHost(host) {
  return [`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(String(host || '').toLowerCase());
}

const wss = new WebSocketServer({
  server,
  verifyClient(info, done) {
    if (!isLocalHost(info.req.headers.host)) return done(false, 403, 'Host not allowed');
    if (!info.origin) return done(true);
    const expected = `http://${info.req.headers.host}`;
    return done(info.origin === expected, info.origin === expected ? 101 : 403, 'Origin not allowed');
  },
});

app.use((req, res, next) => (
  isLocalHost(req.headers.host) ? next() : res.status(403).json({ ok: false, error: 'Host không hợp lệ' })
));
app.use(express.json());

// --- Dashboard control (Bearer ZALO_BRIDGE_TOKEN, không qua CSRF /api) ---
const groupDirectory = createGroupDirectory({ getApi: () => api });
app.use('/control', createControlRouter({
  token: process.env.ZALO_BRIDGE_TOKEN,
  health: () => runtimeHealth.snapshot(),
  qr: { start: () => qrLogin.start(), state: () => qrLogin.state() },
  logout: () => logoutZalo(),
  send: ({ threadId, threadType, text, actor }) => {
    if (!api) throw new Error('Zalo chưa đăng nhập');
    return sendSystemNotice({ api, threadId, threadType, text, actorUid: actor, actorRole: 'dashboard', action: 'dashboard_send' });
  },
  loginCode: ({ zaloUid, code, actor }) => {
    if (!api) throw new Error('Zalo chưa đăng nhập');
    return sendSystemNotice({
      api, threadId: zaloUid, threadType: 0, actorUid: actor, actorRole: 'dashboard', action: 'dashboard_login_code', remember: false,
      text: `Mã đăng nhập dashboard: ${code}
Mã có hiệu lực 5 phút. Đừng đưa mã này cho ai.`,
    });
  },
  groups: () => groupDirectory.list(),
  // `api` đổi khi đăng nhập lại — đọc qua hàm, không chụp giá trị lúc khởi động.
  directory: createZaloDirectory({ getApi: () => api, acquire: acquireSendQuota, audit: auditDashboardAction }),
}));
app.use(express.static(join(__dirname, 'public')));
app.use('/api', (req, res, next) => {
  if (req.method !== 'POST' || req.get('X-Zalo-Dashboard') === '1') return next();
  return res.status(403).json({ ok: false, error: 'Yêu cầu dashboard không hợp lệ' });
});

// --- State ---
let zalo = null;
let api = null;
let loginInfo = null;
let status = 'idle'; // 'idle' | 'qr-pending' | 'scanned' | 'logged-in'
let sessionFromDisk = false;
let stopBotListener = () => {};

function activateZaloRuntime() {
  const legacyStatePath = process.env.HERMES_LEGACY_STATE_DB
    || (process.env.HERMES_HOME ? join(process.env.HERMES_HOME, 'state.db') : null);
  if (legacyStatePath && existsSync(legacyStatePath)) {
    try {
      const migration = importLegacyHermesHistory({
        sourcePath: legacyStatePath,
        store: zaloStore,
        accountId: String(loginInfo?.user_id || loginInfo?.userId || ''),
        retentionDays: Number(process.env.ZALO_HISTORY_RETENTION_DAYS) || 365,
      });
      console.log(`[history] legacy import: ${migration.inserted} mới, ${migration.skipped} đã có`);
    } catch (error) {
      runtimeHealth.recordError('legacy_history_import_failed', error?.message || error);
      console.error('[history] legacy import failed:', error?.message || error);
    }
  }
  startHermesBridge({ api, profile: loginInfo, store: zaloStore, health: runtimeHealth, dmRules });
  stopBotListener();
  stopBotListener = setupBotListener(api, loginInfo, { health: runtimeHealth });
  startAutomaticBackfill().catch((error) => {
    runtimeHealth.recordError('automatic_backfill_failed', error?.message || error);
    console.error('[history] automatic backfill failed:', error?.message || error);
  });
}

// --- WebSocket clients ---
let wsClients = [];
function broadcast(msg) {
  const text = JSON.stringify(msg);
  wsClients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(text);
  });
}

wss.on('connection', (ws) => {
  wsClients.push(ws);
  ws.on('close', () => { wsClients = wsClients.filter(c => c !== ws); });
  // push current state to new client
  if (status === 'logged-in' && loginInfo && !zaloSessionStale()) {
    ws.send(JSON.stringify({ type: 'login-success', data: loginInfo }));
  } else if (qrLogin.state().image) {
    // Trang cũ tự thêm tiền tố data URL nên chỉ gửi base64 thuần.
    const image = qrLogin.state().image.replace(/^data:image\/png;base64,/, '');
    ws.send(JSON.stringify({ type: 'qr-generated', data: { image } }));
  }
});

// Phiên "đã đăng nhập" nhưng chết hẳn: Zalo đá (needsRelogin) hoặc listener đã đóng.
function zaloSessionStale() {
  const z = runtimeHealth.zaloSession();
  return z.needsRelogin || z.listener === 'closed';
}

// Dỡ runtime của phiên hiện tại (listener, cầu nối, api). Không xoá phiên trên đĩa:
// quét QR xong thì saveSession ghi đè, còn bỏ dở thì lần khởi động sau vẫn thử lại.
function teardownZaloSession() {
  stopBotListener();
  stopBotListener = () => {};
  stopHermesBridge();
  api = null;
  loginInfo = null;
  status = 'idle';
  runtimeHealth.setZaloState('idle');
  qrLogin.markLoggedOut();
  groupDirectory.clear();
  sessionFromDisk = false;
}

const qrLogin = createQrLogin({
  createZalo: () => (zalo = new Zalo(zaloOptions())),
  health: runtimeHealth,
  broadcast,
  isStale: zaloSessionStale,
  teardown: async () => {
    console.warn('[auth] phiên Zalo cũ đã chết — dỡ phiên để quét QR mới');
    teardownZaloSession();
  },
  onLoggedIn: async (loggedApi, credentials) => {
    try {
    api = loggedApi;
    sessionFromDisk = false;
    loginInfo = await fetchProfile(api);
    status = 'logged-in';
    runtimeHealth.setZaloState('logged-in', { userId: loginInfo?.user_id, displayName: loginInfo?.display_name });
    if (!credentials) console.warn('[auth] ⚠️ không bắt được credentials từ sự kiện GotLoginInfo');
    await saveSession(credentials, loginInfo);
    console.log(`[auth] ✅ đăng nhập thành công — ${loginInfo?.display_name || '?'} (${loginInfo?.user_id || '?'})`);
    broadcast({ type: 'login-success', data: loginInfo });
    activateZaloRuntime();
    groupDirectory.clear();
    return loginInfo;
    } catch (err) {
      stopBotListener();
      stopBotListener = () => {};
      api = null; loginInfo = null; status = 'idle';
      runtimeHealth.setZaloState('idle');
      throw err;
    }
  },
});

// --- Boot check: Auto Reconnect ---

const reconnectResult = await tryReconnect();
if (reconnectResult) {
  zalo = reconnectResult.zalo;
  api = reconnectResult.api;
  loginInfo = reconnectResult.loginInfo;
  sessionFromDisk = true;
  status = 'logged-in';
  qrLogin.markLoggedIn(loginInfo);
  runtimeHealth.setZaloState('logged-in', {
    userId: loginInfo?.user_id,
    displayName: loginInfo?.display_name,
  });
  console.log(`[boot] ✅ đã kết nối lại — ${loginInfo?.display_name || '?'} (${loginInfo?.user_id || '?'})`);
  activateZaloRuntime();
} else {
  runtimeHealth.setZaloState('idle');
  console.log('[boot] chưa có phiên — cần quét QR');
}

// --- QR Login ---
// Chặn gọi dồn dập: tạo QR tốn tài nguyên (mở phiên Zalo mới), nên giới hạn
// tối thiểu 2s giữa hai lần bắt đầu để tránh bị lợi dụng làm cạn tài nguyên máy.
const QR_START_COOLDOWN_MS = 2000;
let lastQrStartAt = 0;
app.post('/api/qr/start', async (req, res) => {
  if (status === 'logged-in' && api && !zaloSessionStale()) return res.json({ ok: true, user: loginInfo });
  const now = Date.now();
  if (now - lastQrStartAt < QR_START_COOLDOWN_MS) {
    return res.status(429).json({ ok: false, error: 'Gọi quá nhanh, vui lòng thử lại sau giây lát' });
  }
  lastQrStartAt = now;
  try {
    await qrLogin.start(); // phiên đã chết thì dỡ trước, rồi mở QR mới
    const user = await qrLogin.waitForLogin();
    res.json({ ok: true, user });
  } catch (err) {
    console.error('[auth] loginQR error:', err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// --- Status ---
app.get('/api/status', (req, res) => {
  res.json({
    status: status === 'logged-in' ? status : qrLogin.state().status,
    user: loginInfo || null,
    hermesAttached: isHermesAttached(),
    mode: isHermesAttached() ? 'hermes-agent' : 'waiting-for-hermes',
  });
});

app.get('/api/health', (req, res) => {
  const snapshot = runtimeHealth.snapshot();
  snapshot.authorization = {
    model: 'public-owner',
    ownerConfigured: String(process.env.ZALO_ALLOWED_USERS || '')
      .split(',').some((value) => value.trim()),
  };
  res.json(snapshot);
});

// --- Logout ---
async function logoutZalo() {
  teardownZaloSession();
  await clearSession();
  broadcast({ type: 'logout' });
}

app.post('/api/logout', async (req, res) => {
  await logoutZalo();
  res.json({ ok: true });
});

const PORT = Number(process.env.ZCA_PORT) || 3872;

// Ghi PID ra file để Hermes-Offline.vbs tắt đúng tiến trình này. Không thể
// nhận diện qua dòng lệnh vì nó chỉ là "node server.js" — trùng với vô số
// dự án Node khác trên máy.
const PID_FILE = join(__dirname, 'data', 'sidecar.pid');
function writePidFile() {
  try {
    mkdirSync(dirname(PID_FILE), { recursive: true });
    writeFileSync(PID_FILE, String(process.pid), 'utf8');
  } catch (err) {
    console.warn('[boot] không ghi được sidecar.pid:', err.message);
  }
}
function removePidFile() {
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch { /* đang tắt, không cần xử lý thêm */ }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    stopBotListener();
    removePidFile();
    clearInterval(retentionTimer);
    try { zaloStore.close(); } catch { /* đang thoát */ }
    process.exit(0);
  });
}
process.on('exit', removePidFile);

server.on('error', (error) => {
  runtimeHealth.recordError('dashboard_server_error', error?.code || 'listen_failed');
  console.error(`[boot] không mở được dashboard 127.0.0.1:${PORT}: ${error?.code || 'listen_failed'}`);
  stopBotListener();
  stopHermesBridge();
  removePidFile();
  clearInterval(retentionTimer);
  try { zaloStore.close(); } catch { /* đang dừng sau lỗi khởi động */ }
  process.exitCode = 1;
});

server.listen(PORT, '127.0.0.1', () => {
  writePidFile();
  console.log(`ZCA UI running at http://127.0.0.1:${PORT}`);
});
