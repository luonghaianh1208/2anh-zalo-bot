import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { Zalo, LoginQRCallbackEventType } from 'zca-js';
import { tryReconnect, saveSession, clearSession, fetchProfile } from './auth.js';
import { setupBotListener } from './bot-handler.js';
import { startAutomaticBackfill, startHermesBridge, stopHermesBridge, isHermesAttached } from './hermes-bridge.js';
import { openZaloStore } from './zalo-store.js';
import { createRuntimeHealth } from './runtime-health.js';
import { importLegacyHermesHistory } from './legacy-history-import.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  loadEnvFile(join(__dirname, '.env'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const zaloStore = openZaloStore({
  path: join(__dirname, 'data', 'zalo.sqlite'),
  retentionDays: Number(process.env.ZALO_HISTORY_RETENTION_DAYS) || 365,
});
const runtimeHealth = createRuntimeHealth({ store: zaloStore });
zaloStore.pruneMessages();
const retentionTimer = setInterval(() => {
  try { zaloStore.pruneMessages(); } catch (error) {
    runtimeHealth.recordError('history_retention_failed', error?.message || error);
  }
}, 24 * 60 * 60 * 1000);
retentionTimer.unref?.();
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({
  server,
  verifyClient(info, done) {
    if (!info.origin) return done(true);
    const expected = `http://${info.req.headers.host}`;
    return done(info.origin === expected, info.origin === expected ? 101 : 403, 'Origin not allowed');
  },
});

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));
app.use('/api', (req, res, next) => {
  if (req.method !== 'POST' || req.get('X-Zalo-Dashboard') === '1') return next();
  return res.status(403).json({ ok: false, error: 'Yêu cầu dashboard không hợp lệ' });
});

// --- State ---
let zalo = null;
let api = null;
let loginInfo = null;
let qrBase64 = null;
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
  startHermesBridge({ api, profile: loginInfo, store: zaloStore, health: runtimeHealth });
  stopBotListener();
  stopBotListener = setupBotListener(api, loginInfo);
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
  if (status === 'logged-in' && loginInfo) {
    ws.send(JSON.stringify({ type: 'login-success', data: loginInfo }));
  } else if (qrBase64) {
    ws.send(JSON.stringify({ type: 'qr-generated', data: { image: qrBase64 } }));
  }
});

// --- Boot check: Auto Reconnect ---

const reconnectResult = await tryReconnect();
if (reconnectResult) {
  zalo = reconnectResult.zalo;
  api = reconnectResult.api;
  loginInfo = reconnectResult.loginInfo;
  sessionFromDisk = true;
  status = 'logged-in';
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
app.post('/api/qr/start', async (req, res) => {
  if (status === 'logged-in' && api) return res.json({ ok: true, user: loginInfo });

  status = 'qr-pending';
  qrBase64 = null;

  try {
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0';
    zalo = new Zalo({ logging: false, selfListen: true });
    
    // Bắt sự kiện GotLoginInfo để lưu credentials chuẩn xác
    let capturedCredentials = null;

    const session = await zalo.loginQR(
      { userAgent, language: 'vi' },
      async (evt) => {
        console.log('[ZCA QR Event]:', evt.type);
        switch (evt.type) {
          case LoginQRCallbackEventType.QRCodeGenerated:
            qrBase64 = evt.data.image;
            status = 'qr-pending';
            runtimeHealth.setZaloState('qr-pending');
            broadcast({ type: 'qr-generated', data: { image: qrBase64 } });
            break;
          case LoginQRCallbackEventType.QRCodeScanned:
            status = 'scanned';
            runtimeHealth.setZaloState('scanned');
            broadcast({ type: 'qr-scanned' });
            break;
          case LoginQRCallbackEventType.QRCodeExpired:
            status = 'idle';
            runtimeHealth.setZaloState('idle');
            qrBase64 = null;
            broadcast({ type: 'qr-expired' });
            break;
          case LoginQRCallbackEventType.QRCodeDeclined:
            status = 'idle';
            runtimeHealth.setZaloState('idle');
            qrBase64 = null;
            broadcast({ type: 'qr-declined' });
            break;
          case LoginQRCallbackEventType.GotLoginInfo:
            status = 'scanned';
            if (evt.data) {
              capturedCredentials = evt.data; // { cookie, imei, userAgent }
              console.log('[auth] GotLoginInfo captured with cookies:', capturedCredentials.cookie?.length);
            }
            break;
        }
      }
    );

    api = session;
    status = 'logged-in';
    sessionFromDisk = false;

    // zca-js không trả hồ sơ kèm session — phải hỏi server.
    loginInfo = await fetchProfile(api);
    runtimeHealth.setZaloState('logged-in', {
      userId: loginInfo?.user_id,
      displayName: loginInfo?.display_name,
    });

    if (!capturedCredentials) {
      console.warn('[auth] ⚠️ không bắt được credentials từ sự kiện GotLoginInfo');
    }
    await saveSession(capturedCredentials, loginInfo);

    console.log(`[auth] ✅ đăng nhập thành công — ${loginInfo?.display_name || '?'} (${loginInfo?.user_id || '?'})`);
    broadcast({ type: 'login-success', data: loginInfo });
    activateZaloRuntime();
    res.json({ ok: true, user: loginInfo });
  } catch (err) {
    console.error('[auth] loginQR error:', err);
    status = 'idle';
    runtimeHealth.setZaloState('idle');
    qrBase64 = null;
    broadcast({ type: 'error', data: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Status ---
app.get('/api/status', (req, res) => {
  res.json({
    status,
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
app.post('/api/logout', async (req, res) => {
  stopBotListener();
  stopBotListener = () => {};
  stopHermesBridge();
  api = null;
  loginInfo = null;
  status = 'idle';
  runtimeHealth.setZaloState('idle');
  qrBase64 = null;
  sessionFromDisk = false;
  await clearSession();
  broadcast({ type: 'logout' });
  res.json({ ok: true });
});

const PORT = process.env.ZCA_PORT || 3872;

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
