#!/usr/bin/env node
// Trình tự cập nhật 2anh-zalo-bot — dashboard (Bảo trì › Cập nhật) chạy tách rời:
//   node scripts/self-update.js --to vX.Y.Z [--from X.Y.Z]
// Đọc .env của sidecar (HERMES_HOME, cổng, lệnh khởi động lại). Xem self-update-lib.js.
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRepoEnv } from './setup-env.js';
import { runSelfUpdate } from './self-update-lib.js';
import { createHermesAdmin } from '../dashboard/lib/hermes-admin.js';
import { freeListenerPort, makeRestartSidecar, systemctlRestart } from '../dashboard/lib/restart.js';
import { makeRestartAssistant } from '../dashboard/lib/restart-assistant.js';
import { childEnv, waitSpawned } from '../dashboard/lib/spawn-detached.js';
import { loadDashboardConfig } from '../dashboard/lib/config.js';
import { resolveDashboardPaths } from '../dashboard/lib/paths.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };
if (existsSync(join(root, '.env'))) loadRepoEnv(join(root, '.env'));
const env = process.env;
const paths = resolveDashboardPaths({ env, sidecarRoot: root });
const config = loadDashboardConfig(env);
const sidecarPort = Number(env.ZCA_PORT) || 3872;
mkdirSync(paths.dataDir, { recursive: true });
const tmpDir = join(paths.dataDir, 'update-tmp');
mkdirSync(tmpDir, { recursive: true });
const logFile = join(paths.dataDir, 'bot-update.log');
const stateFile = join(paths.dataDir, 'bot-update.json');
writeFileSync(logFile, '');

const stamp = () => new Date().toLocaleTimeString('vi-VN', { hour12: false });
const log = (text) => appendFileSync(logFile, `[${stamp()}] ${text}\n`);

const run = (cmd, argv, opts = {}) => new Promise((ok, fail) => {
  execFile(cmd, argv, { windowsHide: true, maxBuffer: 20 * 1024 * 1024, timeout: 15 * 60_000, ...opts }, (e, stdout, stderr) => {
    const out = `${stdout || ''}${stderr || ''}`.trim();
    if (out) log(out.split(/\r?\n/).slice(-15).join('\n'));
    if (e) fail(new Error(`${cmd} ${argv.slice(0, 2).join(' ')} lỗi (mã ${e.code ?? '?'})`)); else ok(String(stdout || ''));
  });
});

async function download(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { 'User-Agent': '2anh-zalo-dashboard' } });
  if (!res.ok) throw new Error(`Tải ${url} lỗi ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function restartDashboard() {
  const cmd = String(env.ZALO_DASHBOARD_RESTART_CMD || '').trim();
  if (!cmd && process.platform !== 'win32') return systemctlRestart({ service: 'zalo-dashboard', envVar: 'ZALO_DASHBOARD_RESTART_CMD' });
  const opts = { detached: true, windowsHide: true, stdio: 'ignore', env: childEnv() };
  let child;
  if (cmd) child = spawn(cmd, { ...opts, shell: true });
  else {
    await freeListenerPort({ port: config.port });
    child = spawn(process.execPath, [join(root, 'dashboard', 'server.js')], { ...opts, cwd: root });
  }
  return waitSpawned(child);
}

async function healthy() {
  let h;
  try { h = await (await fetch(`http://127.0.0.1:${sidecarPort}/api/health`, { signal: AbortSignal.timeout(4000) })).json(); } catch { return { ok: false, detail: 'kết nối Zalo chưa trả lời' }; }
  if (!((h?.bridge?.attachedClients || 0) > 0)) return { ok: false, detail: 'trợ lý chưa nối vào kết nối Zalo' };
  try { if (!(await fetch(`http://127.0.0.1:${config.port}/healthz`, { signal: AbortSignal.timeout(4000) })).ok) throw new Error(); } catch { return { ok: false, detail: 'dashboard chưa chạy' }; }
  return { ok: true, detail: '' };
}

const admin = createHermesAdmin({ hermesHome: paths.hermesHome, env, configFile: paths.hermesConfigFile, backupDir: join(paths.dataDir, 'config-backups') });
const state = await runSelfUpdate({
  root, hermesHome: paths.hermesHome, to: opt('--to'), from: opt('--from'), stateFile, tmpDir,
  deps: {
    log, run, download, healthy, restartDashboard,
    backup: async () => (await admin.write('backup.create', { dir: join(paths.dataDir, 'backups') }, { timeoutMs: 600_000 })).file,
    restartSidecar: makeRestartSidecar({ cmd: config.restartCmd, sidecarRoot: root, port: sidecarPort }),
    restartAssistant: makeRestartAssistant({ cmd: config.assistantRestartCmd, hermesHome: paths.hermesHome }),
  },
}).catch((e) => { log(`LỖI: ${e.message}`); writeFileSync(stateFile, JSON.stringify({ status: 'failed', error: e.message, finishedAt: Date.now() })); return null; });
process.exitCode = state?.status === 'done' ? 0 : 1;
