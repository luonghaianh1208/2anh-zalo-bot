import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { Zalo, LoginQRCallbackEventType } from 'zca-js';
import { tryReconnect, saveSession, clearSession, fetchProfile } from './auth.js';
import { loadBotConfig, saveBotConfig, loadPersonas, savePersonas } from './config-manager.js';
import { setupBotListener } from './bot-handler.js';
import { assertBrainReady } from './brain-config.js';
import { startHermesBridge, isHermesAttached } from './hermes-bridge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// API Cấu hình Personas
app.get('/api/personas', async (req, res) => {
  const data = await loadPersonas();
  res.json(data);
});

app.post('/api/personas', async (req, res) => {
  const success = await savePersonas(req.body);
  res.json({ ok: success });
});

// --- State ---
let zalo = null;
let api = null;
let loginInfo = null;
let qrBase64 = null;
let status = 'idle'; // 'idle' | 'qr-pending' | 'scanned' | 'logged-in'
let sessionFromDisk = false;

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
assertBrainReady();

const reconnectResult = await tryReconnect();
if (reconnectResult) {
  zalo = reconnectResult.zalo;
  api = reconnectResult.api;
  loginInfo = reconnectResult.loginInfo;
  sessionFromDisk = true;
  status = 'logged-in';
  console.log(`[boot] ✅ đã kết nối lại — ${loginInfo?.display_name || '?'} (${loginInfo?.user_id || '?'})`);
  setupBotListener(api);
  startHermesBridge({ api, profile: loginInfo });
} else {
  console.log('[boot] chưa có phiên — cần quét QR');
}

// --- QR Login ---
app.post('/api/qr/start', async (req, res) => {
  if (status === 'logged-in' && api) return res.json({ ok: true, user: loginInfo });

  status = 'qr-pending';
  qrBase64 = null;

  try {
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0';
    zalo = new Zalo({ logging: false });
    
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
            broadcast({ type: 'qr-generated', data: { image: qrBase64 } });
            break;
          case LoginQRCallbackEventType.QRCodeScanned:
            status = 'scanned';
            broadcast({ type: 'qr-scanned' });
            break;
          case LoginQRCallbackEventType.QRCodeExpired:
            status = 'idle';
            qrBase64 = null;
            broadcast({ type: 'qr-expired' });
            break;
          case LoginQRCallbackEventType.QRCodeDeclined:
            status = 'idle';
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

    if (!capturedCredentials) {
      console.warn('[auth] ⚠️ không bắt được credentials từ sự kiện GotLoginInfo');
    }
    await saveSession(capturedCredentials, loginInfo);

    console.log(`[auth] ✅ đăng nhập thành công — ${loginInfo?.display_name || '?'} (${loginInfo?.user_id || '?'})`);
    broadcast({ type: 'login-success', data: loginInfo });
    setupBotListener(api);
    startHermesBridge({ api, profile: loginInfo });
    res.json({ ok: true, user: loginInfo });
  } catch (err) {
    console.error('[auth] loginQR error:', err);
    status = 'idle';
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
    mode: isHermesAttached() ? 'hermes-agent' : 'chatbot-noi-bo',
  });
});

// --- API Lấy Danh Sách Tất Cả Nhóm Zalo Đang Tham Gia ---
app.get('/api/groups', async (req, res) => {
  if (status !== 'logged-in' || !api) {
    return res.json({ ok: false, groups: [], msg: 'Chưa đăng nhập Zalo' });
  }
  try {
    let groupList = [];
    if (typeof api.getAllGroups === 'function') {
      const g = await api.getAllGroups();
      const gridMap = g?.gridVerMap || {};
      const gridIds = Object.keys(gridMap);

      if (gridIds.length > 0 && typeof api.getGroupInfo === 'function') {
        try {
          const infoRes = await api.getGroupInfo(gridIds);
          if (infoRes && infoRes.gridInfoMap) {
            groupList = Object.keys(infoRes.gridInfoMap).map(gid => {
              const item = infoRes.gridInfoMap[gid];
              return {
                id: gid,
                grid: gid,
                name: item.name || `Nhóm Zalo (${gid.slice(-4)})`,
                avatar: item.avt || item.avatar || '',
                memberCount: item.totalMember || 0
              };
            });
          }
        } catch (e) {
          console.warn('[groups] getGroupInfo error:', e.message);
        }
      }

      if (groupList.length === 0) {
        groupList = gridIds.map(gid => ({
          id: gid,
          grid: gid,
          name: `Nhóm Zalo (${gid.slice(-4)})`,
          avatar: ''
        }));
      }
    }
    res.json({ ok: true, groups: groupList });
  } catch (err) {
    console.error('[groups] fetch failed:', err.message);
    res.json({ ok: false, groups: [], error: err.message });
  }
});

// --- Bot Settings Config API ---
app.get('/api/config', async (req, res) => {
  const cfg = await loadBotConfig();
  res.json(cfg);
});

app.post('/api/config', async (req, res) => {
  const ok = await saveBotConfig(req.body);
  res.json({ ok });
});

// --- Send to home (Zalo main account) ---
app.post('/api/send-home', async (req, res) => {
  if (status !== 'logged-in' || !api) {
    return res.status(400).json({ ok: false, error: 'Chua dang nhap' });
  }
  const { uid, message } = req.body;
  if (!uid || !message) return res.status(400).json({ ok: false, error: 'Thieu uid hoac message' });
  try {
    await api.sendMessage({ msg: message }, uid);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Logout ---
app.post('/api/logout', async (req, res) => {
  api = null;
  loginInfo = null;
  status = 'idle';
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
  process.on(sig, () => { removePidFile(); process.exit(0); });
}
process.on('exit', removePidFile);

server.listen(PORT, '127.0.0.1', () => {
  writePidFile();
  console.log(`ZCA UI running at http://127.0.0.1:${PORT}`);
});
