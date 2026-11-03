import {
  existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, cpSync,
  readdirSync, realpathSync, renameSync, rmSync, statSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMap, isSeq, parse, parseDocument } from 'yaml';
import { installDashboardService, uninstallDashboardService, caddySnippet } from './dashboard-service.js';
import { resolveDashboardPaths } from '../dashboard/lib/paths.js';
import { loadDashboardConfig } from '../dashboard/lib/config.js';
import { createUserStore } from '../dashboard/lib/users.js';
import { issueSetupLink } from '../dashboard/lib/setup-link.js';
import { readJson } from '../dashboard/lib/json-store.js';
import { SECOND_BRAIN_KEY, secondBrainStatus } from '../dashboard/lib/second-brain.js';
import { LM_PROVIDER, learnedMemoryStatus } from '../dashboard/lib/learned-memory.js';

const PLATFORM_KEY = 'platforms/zalo';
const TOOLS_KEY = 'zalo-tools';
const VIENEU_PROVIDER = 'vieneu-local';
const VIENEU_VERSION = '3.6.4';

export function vieneuProbeScript() {
  return `import sys; from importlib.metadata import version; import edge_tts, vieneu; sys.exit(0 if version("vieneu") == "${VIENEU_VERSION}" else 1)`;
}

export function parseCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--hermes-home') options.hermesHome = argv[++index];
    else if (value === '--sidecar-root') options.sidecarRoot = argv[++index];
    else if (value === '--skip-python') options.skipPython = true;
    else if (value === '--vieneu-tts') options.vieneuTts = true;
    else if (value === '--no-dashboard') options.noDashboard = true;
    else throw new Error(`Tham số không hỗ trợ: ${value}`);
  }
  if (!options.sidecarRoot) options.sidecarRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  return options;
}

function isHermesRepo(path) {
  return existsSync(join(path, 'plugins'))
    && existsSync(join(path, 'gateway'))
    && existsSync(join(path, 'pyproject.toml'));
}

function layoutFromCandidate(candidate) {
  const absolute = resolve(candidate);
  if (isHermesRepo(absolute)) {
    const parentConfig = join(dirname(absolute), 'config.yaml');
    return {
      home: existsSync(parentConfig) ? dirname(absolute) : absolute,
      repoRoot: absolute,
      configPath: existsSync(parentConfig) ? parentConfig : join(absolute, 'config.yaml'),
    };
  }
  const nested = join(absolute, 'hermes-agent');
  if (isHermesRepo(nested)) {
    return { home: absolute, repoRoot: nested, configPath: join(absolute, 'config.yaml') };
  }
  return null;
}

/**
 * Mã Hermes nằm riêng với HERMES_HOME (bố trí chuẩn trên Linux: HERMES_HOME=/root/.hermes, mã ở /opt/hermes/hermes-agent):
 * HERMES_REPO → venv chứa lệnh `hermes` trên PATH (…/hermes-agent/.venv/bin/hermes) → /opt/hermes/hermes-agent.
 */
export function findSeparateHermesRepo({ env = process.env, exists = existsSync, real = realpathSync, hostPlatform = platform() } = {}) {
  const ok = (p) => p && isHermesRepo(p);
  if (ok(env.HERMES_REPO)) return resolve(env.HERMES_REPO);
  const exe = hostPlatform === 'win32' ? 'hermes.exe' : 'hermes';
  for (const dir of String(env.PATH || '').split(hostPlatform === 'win32' ? ';' : ':').filter(Boolean)) {
    const bin = join(dir, exe);
    if (!exists(bin)) continue;
    try { const root = dirname(dirname(dirname(real(bin)))); if (ok(root)) return root; } catch { /* thử thư mục kế */ }
  }
  return hostPlatform === 'win32' || !ok('/opt/hermes/hermes-agent') ? null : '/opt/hermes/hermes-agent';
}

export function resolveHermesLayout({ hermesHome = null, env = process.env, cwd = process.cwd(), findRepo = findSeparateHermesRepo } = {}) {
  const explicit = hermesHome || env.HERMES_HOME;
  if (explicit && explicit.length > 0) {
    const layout = layoutFromCandidate(explicit);
    if (layout) return layout;
    const home = resolve(explicit);
    const repo = existsSync(join(home, 'config.yaml')) ? findRepo({ env }) : null;
    if (repo) return { home, repoRoot: repo, configPath: join(home, 'config.yaml') };
    throw new Error(`Không tìm thấy Hermes Agent hợp lệ tại: ${home}`);
  }

  const candidates = [cwd, dirname(cwd), join(homedir(), '.hermes')];
  if (platform() === 'win32' && env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'hermes'));
  for (const candidate of candidates) {
    const layout = layoutFromCandidate(candidate);
    if (layout) return layout;
  }
  throw new Error('Không tự tìm thấy Hermes Agent; hãy truyền --hermes-home <đường-dẫn>');
}

export function mergeHermesConfig(text, { bridgeToken, vieneu = null, guideHeadings = null } = {}) {
  // Sửa ngay trên Document chứ không parse ra object rồi stringify lại: cách cũ
  // làm mất sạch comment của khách và làm tròn số nguyên lớn (ID kênh 19 chữ số
  // thành một số khác, trỏ sai kênh). intAsBigInt giữ nguyên từng chữ số.
  const doc = parseDocument(text || '', { intAsBigInt: true });
  if (doc.errors.length) throw doc.errors[0];
  if (doc.contents == null) doc.contents = doc.createNode({});
  if (!isMap(doc.contents)) {
    throw new Error('config.yaml phải chứa một YAML mapping ở cấp cao nhất');
  }

  const ensureMap = (path) => {
    for (let depth = 1; depth <= path.length; depth += 1) {
      const sub = path.slice(0, depth);
      if (!isMap(doc.getIn(sub, true))) doc.setIn(sub, doc.createNode({}));
    }
  };
  const setDefault = (path, value) => {
    ensureMap(path.slice(0, -1));
    if (doc.getIn(path) === undefined) doc.setIn(path, value);
  };
  const setValue = (path, value) => {
    ensureMap(path.slice(0, -1));
    doc.setIn(path, value);
  };
  const ensureListItems = (path, names) => {
    ensureMap(path.slice(0, -1));
    if (!isSeq(doc.getIn(path, true))) doc.setIn(path, doc.createNode([]));
    const seq = doc.getIn(path, true);
    const present = seq.items.map((item) => String(item?.value ?? item));
    for (const name of names) if (!present.includes(name)) seq.add(name);
  };

  ensureListItems(['known_plugin_toolsets', 'zalo'], ['zalo_owner', 'zalo_public', 'zalo_cron']);
  setDefault(['group_sessions_per_user'], false);

  ensureListItems(['plugins', 'enabled'], [PLATFORM_KEY, TOOLS_KEY]);
  // Hook pre_tool_call chặn công cụ của người ngoài chạy đồng bộ. Để timeout
  // mặc định thì Hermes khoá callback dùng chung giữa mọi luồng: các lời gọi
  // công cụ song song bị chặn nhầm "still running" (đo được 286/320 lần).
  doc.setIn(['plugins', 'hook_callback_timeout'], 0);
  const disabled = doc.getIn(['plugins', 'disabled'], true);
  if (isSeq(disabled)) {
    disabled.items = disabled.items.filter((item) => ![PLATFORM_KEY, TOOLS_KEY].includes(String(item?.value ?? item)));
  }

  setDefault(['platforms', 'zalo', 'enabled'], true);
  setDefault(['platforms', 'zalo', 'extra', 'bridge_url'], 'ws://127.0.0.1:3873');
  setDefault(['platforms', 'zalo', 'extra', 'reply_only_tagged'], true);
  if (bridgeToken) setValue(['platforms', 'zalo', 'extra', 'bridge_token'], bridgeToken);

  if (guideHeadings) {
    // Hướng dẫn trình bày giờ nằm trong plugin (zalo/style-guide.md, cập nhật theo bản phát hành). Bản cũ trình
    // cài từng chép vào đây thì gỡ đi, chỉ giữ phần khách tự viết (giọng điệu, "Bạn là ai"…).
    const existingAppend = doc.getIn(['platform_hints', 'zalo', 'append']);
    if (typeof existingAppend === 'string') {
      const kept = stripStyleGuide(existingAppend, guideHeadings);
      if (kept !== existingAppend.trim()) {
        if (kept) setValue(['platform_hints', 'zalo', 'append'], kept);
        else doc.deleteIn(['platform_hints', 'zalo', 'append']);
      }
    }
  }

  const display = ['display', 'platforms', 'zalo'];
  setDefault([...display, 'tool_progress'], 'off');
  setDefault([...display, 'long_running_notifications'], false);
  setDefault([...display, 'busy_ack_detail'], false);
  setDefault([...display, 'show_reasoning'], false);
  setDefault([...display, 'streaming'], false);
  setDefault([...display, 'interim_assistant_messages'], false);

  if (vieneu) {
    setValue(['tts', 'provider'], VIENEU_PROVIDER);
    setDefault(['tts', 'speed'], 1.0);
    const provider = ['tts', 'providers', VIENEU_PROVIDER];
    setValue([...provider, 'type'], 'command');
    setValue([...provider, 'command'], `${quoteCommandPath(vieneu.pythonPath)} ${quoteCommandPath(vieneu.scriptPath)} --input {input_path} --output {output_path} --voice {voice} --speed {speed}`);
    setValue([...provider, 'output_format'], 'wav');
    setValue([...provider, 'voice'], 'Minh Quân');
    setValue([...provider, 'speed'], 1.0);
    setValue([...provider, 'timeout'], 180);
    setValue([...provider, 'voice_compatible'], true);
  }

  return doc.toString({ lineWidth: 0 });
}

function quoteCommandPath(path) {
  const value = String(path);
  if (platform() === 'win32') return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function renderPlatformManifest(template, sidecarRoot) {
  const serverPath = join(resolve(sidecarRoot), 'server.js').replaceAll('\\', '/');
  return String(template).replaceAll('{{SIDECAR_SERVER}}', serverPath);
}

function within(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Đổi tên thư mục, thử lại khi Windows tạm giữ tệp (EPERM/EBUSY/EACCES: trình diệt virus đang quét tệp vừa chép,
 * hoặc trợ lý đang mở tệp) — hay gặp khi cập nhật bot lúc trợ lý đang chạy. Tối đa ~5 giây.
 */
export function renameWithRetry(from, to, { rename = renameSync, tries = 10, waitMs = (i) => 100 * (i + 1), platform: plat = platform() } = {}) {
  for (let i = 0; ; i += 1) {
    try { rename(from, to); return; } catch (error) {
      if (plat !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || i >= tries - 1) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs(i));
    }
  }
}

function atomicReplaceDirectory(source, destination) {
  const parent = dirname(destination);
  if (!within(parent, destination)) throw new Error(`Đích plugin không an toàn: ${destination}`);
  mkdirSync(parent, { recursive: true });
  const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const staging = join(parent, `.${destination.split(/[\\/]/).pop()}.install-${suffix}`);
  const backup = join(parent, `.${destination.split(/[\\/]/).pop()}.backup-${suffix}`);
  if (!within(parent, staging) || !within(parent, backup)) throw new Error('Đường dẫn staging không an toàn');
  cpSync(source, staging, { recursive: true, force: true });
  let movedOld = false;
  try {
    if (existsSync(destination)) {
      renameWithRetry(destination, backup);
      movedOld = true;
    }
    renameWithRetry(staging, destination);
    if (movedOld) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    if (movedOld && !existsSync(destination) && existsSync(backup)) renameWithRetry(backup, destination);
    throw error;
  }
}

/**
 * Nơi cài ba plugin: thư mục plugin người dùng `<HERMES_HOME>/plugins` — mọi bản Hermes (cũ lẫn mới) đều dò ở đây,
 * và `hermes update` (git stash --include-untracked trong mã Hermes) không bao giờ đụng tới.
 * Khoá bật giữ nguyên: `platforms/zalo` (thư mục nhóm platforms/ không có plugin.yaml), `zalo-tools` (tên trong
 * manifest). Provider trí nhớ phải nằm ở `<HERMES_HOME>/plugins/zalo_memory` (tên thư mục = tên provider).
 */
export function pluginTargets(home) {
  const root = join(resolve(home), 'plugins');
  return { root, platform: join(root, 'platforms', 'zalo'), tools: join(root, 'zalo_tools'), memory: join(root, 'zalo_memory') };
}

/** Chỗ các bản ≤ 2.36 chép plugin: thẳng vào mã Hermes — `hermes update` có thể cất mất (git stash -u). */
export function legacyPluginTargets(repoRoot) {
  const root = join(resolve(repoRoot), 'plugins');
  return [join(root, 'platforms', 'zalo'), join(root, 'zalo_tools'), join(root, 'memory', 'zalo_memory')];
}

// Thư mục tạm của atomicReplaceDirectory (.zalo.install-…, .zalo_tools.backup-…) còn sót khi lần cài trước bị ngắt.
const STAGING_LEFTOVER = /^\.(zalo|zalo_tools|zalo_memory)\.(install|backup)-/;

/**
 * Git của mã Hermes có theo dõi `path` không: true / false / null (không hỏi được — thiếu git, lỗi lạ).
 * Không phải bản git (không có .git) → false: thư mục đó chắc chắn do bộ cài chép vào.
 */
export function gitTracks(repoRoot, path, { run = spawnSync } = {}) {
  if (!existsSync(join(repoRoot, '.git'))) return false;
  const rel = relative(resolve(repoRoot), resolve(path)).replaceAll('\\', '/');
  let result;
  try {
    // safe.directory=*: trên VPS mã Hermes thường thuộc user khác → git từ chối ("dubious ownership").
    result = run('git', ['-c', 'safe.directory=*', '-C', repoRoot, 'ls-files', '--error-unmatch', '--', rel],
      { encoding: 'utf8', windowsHide: true });
  } catch { return null; }
  if (result?.status === 0) return true;
  if (result?.status === 1) return false;
  return null;
}

const samePath = (a, b) => {
  const norm = (p) => (platform() === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  return norm(a) === norm(b);
};

/**
 * Dọn bản plugin cũ trong mã Hermes sau khi đã cài vào `<HERMES_HOME>/plugins`. BẮT BUỘC: provider trí nhớ có sẵn
 * trong mã Hermes thắng bản ở HERMES_HOME (bot chạy mã cũ), còn hai bản platform thì đăng ký trùng.
 * Chỉ xoá khi git báo thư mục KHÔNG được theo dõi (hoặc mã Hermes không phải bản git); tệp git theo dõi thì
 * không bao giờ xoá. Thiếu (đã mất theo `hermes update`) thì bỏ qua. Dọn luôn thư mục tạm còn sót của bộ cài.
 * Trả { removed: [đường dẫn], kept: [{ path, reason }] }.
 */
export function migrateLegacyPlugins({ repoRoot, home, run = spawnSync }) {
  const fresh = pluginTargets(home);
  const keep = [fresh.platform, fresh.tools, fresh.memory];
  const pluginRoot = join(resolve(repoRoot), 'plugins');
  const removed = [];
  const kept = [];
  const legacy = legacyPluginTargets(repoRoot);
  for (const target of legacy) {
    // HERMES_HOME trùng mã Hermes: platforms/zalo, zalo_tools cũ chính là bản vừa cài — không đụng.
    if (keep.some((p) => samePath(p, target)) || !existsSync(target)) continue;
    if (!within(pluginRoot, target)) throw new Error(`Đích dọn plugin cũ không an toàn: ${target}`);
    const tracked = gitTracks(repoRoot, target, { run });
    if (tracked === false) {
      rmSync(target, { recursive: true, force: true });
      removed.push(target);
    } else {
      kept.push({ path: target, reason: tracked ? 'git của Hermes đang theo dõi thư mục này' : 'không hỏi được git của Hermes' });
    }
  }
  const parents = new Set([...legacy, ...keep].map((p) => dirname(p)));
  for (const dir of parents) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!STAGING_LEFTOVER.test(name)) continue;
      const leftover = join(dir, name);
      if (!within(dir, leftover)) continue;
      rmSync(leftover, { recursive: true, force: true });
      removed.push(leftover);
    }
  }
  return { removed, kept };
}

/** Bản plugin cũ còn trong mã Hermes (khác chỗ cài mới) — doctor cảnh báo. */
function legacyLeftovers(layout) {
  const fresh = pluginTargets(layout.home);
  return legacyPluginTargets(layout.repoRoot)
    .filter((p) => existsSync(p) && ![fresh.platform, fresh.tools, fresh.memory].some((q) => samePath(p, q)));
}

/** `plugins.isolation` thực tế (Hermes mới, hermes_cli/plugin_isolation.py): giá trị hợp lệ hoặc 'in_process'. */
export function pluginIsolationMode(config) {
  const raw = String(config?.plugins?.isolation ?? 'in_process').trim().toLowerCase().replaceAll('-', '_');
  return raw === 'host' ? 'host' : 'in_process';
}

function atomicWriteText(destination, content) {
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const staging = join(parent, `.${destination.split(/[\\/]/).pop()}.install-${suffix}`);
  const backup = join(parent, `.${destination.split(/[\\/]/).pop()}.backup-${suffix}`);
  if (!within(parent, staging) || !within(parent, backup)) throw new Error('Đường dẫn ghi cấu hình không an toàn');
  writeFileSync(staging, content, 'utf8');
  let movedOld = false;
  try {
    if (existsSync(destination)) {
      renameSync(destination, backup);
      movedOld = true;
    }
    renameSync(staging, destination);
    if (movedOld) rmSync(backup, { force: true });
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { force: true });
    if (movedOld && !existsSync(destination) && existsSync(backup)) renameSync(backup, destination);
    throw error;
  }
}

function readBridgeToken(envPath) {
  if (!existsSync(envPath)) return null;
  const match = readFileSync(envPath, 'utf8').match(/^ZALO_BRIDGE_TOKEN=(.+)$/m);
  return match?.[1]?.trim() || null;
}

function appendEnvValue(envPath, key, value) {
  const current = readFileSync(envPath, 'utf8');
  const hasKey = new RegExp(`^${key}=.+$`, 'm').test(current);
  if (hasKey) return;
  writeFileSync(envPath, `${current}${current.endsWith('\n') || !current ? '' : '\n'}${key}=${value}\n`, 'utf8');
}

/** Như appendEnvValue nhưng thay giá trị cũ nếu khác — dùng cho khoá do trình cài quản lý. */
function setEnvValue(envPath, key, value) {
  const current = readFileSync(envPath, 'utf8');
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (!pattern.test(current)) return appendEnvValue(envPath, key, value);
  const next = current.replace(pattern, `${key}=${value}`);
  if (next !== current) writeFileSync(envPath, next, 'utf8');
}

function ensureSidecarEnv(sidecarRoot, hermesHome) {
  const envPath = join(sidecarRoot, '.env');
  if (!existsSync(envPath)) {
    const examplePath = join(sidecarRoot, '.env.example');
    copyFileSync(examplePath, envPath);
  }
  let token = readBridgeToken(envPath);
  if (!token) {
    token = randomBytes(32).toString('hex');
    appendEnvValue(envPath, 'ZALO_BRIDGE_TOKEN', token);
  }
  // Thay chứ không chỉ thêm: lần cài trước dò nhầm nhà Hermes thì chạy lại với
  // --hermes-home đúng phải sửa được, không thì sidecar nạp nhầm .env mãi.
  setEnvValue(envPath, 'HERMES_HOME', resolve(hermesHome).replaceAll('\\', '/'));
  return token;
}

function pythonPath(repoRoot) {
  const candidates = platform() === 'win32'
    ? [join(repoRoot, 'venv', 'Scripts', 'python.exe'), join(repoRoot, '.venv', 'Scripts', 'python.exe')]
    : [join(repoRoot, 'venv', 'bin', 'python'), join(repoRoot, '.venv', 'bin', 'python')];
  return candidates.find(existsSync) || null;
}

const venvPython = (env, hostPlatform) => (hostPlatform === 'win32'
  ? join(env, 'Scripts', 'python.exe')
  : join(env, 'bin', 'python'));

/**
 * Hermes mới (2026-10): chạy bằng Python do Hermes quản lý, thư viện nằm trong môi trường ghi ở
 * `<HERMES_HOME>/installs/<id>/facts.json` → packages.venv.environment (do `hermes pm` dựng lại, cài tay sẽ mất).
 * Trả Python của môi trường đó (facts.json mới sửa nhất trong số có môi trường còn tồn tại), không có → null.
 */
function managedEnvPython(hermesHome, { hostPlatform = platform(), exists = existsSync } = {}) {
  const installs = join(resolve(hermesHome), 'installs');
  let ids = [];
  try { ids = readdirSync(installs); } catch { return null; }
  let best = null;
  for (const id of ids) {
    const facts = join(installs, id, 'facts.json');
    let env;
    try { env = JSON.parse(readFileSync(facts, 'utf8'))?.packages?.venv?.environment; } catch { continue; }
    if (typeof env !== 'string' || !env.trim()) continue;
    const python = venvPython(isAbsolute(env) ? env : join(resolve(hermesHome), env), hostPlatform);
    if (!exists(python)) continue;
    let mtime = 0;
    try { mtime = statSync(facts).mtimeMs; } catch { /* vẫn dùng được */ }
    if (!best || mtime > best.mtime) best = { python, mtime };
  }
  return best?.python || null;
}

/** "Python của Hermes": môi trường do Hermes quản lý (Hermes mới), không có thì `<repo>/.venv` | `<repo>/venv` (Hermes cũ). */
export function hermesRuntimePython(layout, hermesHome, options = {}) {
  return managedEnvPython(hermesHome, options) || (layout?.repoRoot ? pythonPath(layout.repoRoot) : null);
}

/** Hermes mới, thư viện do `hermes pm` quản lý: có facts.json trỏ tới môi trường còn tồn tại, hoặc mã Hermes có pm/workspace.py. */
export function managedHermes(layout, hermesHome, options = {}) {
  if (managedEnvPython(hermesHome, options)) return true;
  return Boolean(layout?.repoRoot) && (options.exists || existsSync)(join(layout.repoRoot, 'pm', 'workspace.py'));
}

/**
 * Lệnh `hermes` để chạy `hermes pm install`: ZALO_HERMES_BIN → <HERMES_HOME>/bin → `hermes` trên PATH (cách bộ cài
 * vẫn tìm mã Hermes) → venv trong mã Hermes → để hệ thống tự tìm "hermes".
 */
export function hermesExecutable(layout, { env = process.env, hostPlatform = platform(), exists = existsSync } = {}) {
  if (env.ZALO_HERMES_BIN) return env.ZALO_HERMES_BIN;
  const exe = hostPlatform === 'win32' ? 'hermes.exe' : 'hermes';
  const sub = hostPlatform === 'win32' ? 'Scripts' : 'bin';
  const candidates = [
    layout?.home && join(layout.home, 'bin', exe),
    ...String(env.PATH || '').split(hostPlatform === 'win32' ? ';' : ':').filter(Boolean).map((dir) => join(dir, exe)),
    ...(layout?.repoRoot ? [join(layout.repoRoot, '.venv', sub, exe), join(layout.repoRoot, 'venv', sub, exe)] : []),
  ].filter(Boolean);
  return candidates.find((p) => exists(p)) || 'hermes';
}

export const PM_INSTALL_TIMEOUT_MS = 20 * 60_000;

/**
 * Hermes mới: `hermes pm install` dựng lại môi trường thư viện kèm python_dependencies của plugin đang bật
 * (`hermes pm repair` giữ đồ thị cũ nên không đủ). Lỗi chỉ thành cảnh báo kèm lệnh chạy tay — không dừng cài đặt.
 * Trả { ok, command, detail }.
 */
export function runHermesPmInstall(layout, { run = spawnSync, log = console.log, env = process.env, hostPlatform = platform(), exists = existsSync } = {}) {
  const bin = hermesExecutable(layout, { env, hostPlatform, exists });
  const command = `${bin} pm install`;
  log(`[INFO] Hermes mới: thư viện Python do Hermes quản lý — chạy "${command}" để cài thư viện cho plugin (có thể mất vài phút)…`);
  let result;
  try {
    result = run(bin, ['pm', 'install'], {
      encoding: 'utf8', windowsHide: true, timeout: PM_INSTALL_TIMEOUT_MS,
      stdio: ['ignore', 'inherit', 'inherit'], env: { ...env, HERMES_HOME: layout.home },
    });
  } catch (error) { result = { status: null, error }; }
  if (result?.status === 0) {
    log('[PASS] hermes-pm-install - đã cài thư viện Python cho plugin vào môi trường của Hermes');
    return { ok: true, command, detail: '' };
  }
  const why = result?.error?.code === 'ETIMEDOUT' ? `quá ${PM_INSTALL_TIMEOUT_MS / 60_000} phút`
    : result?.error ? result.error.message : `mã thoát ${result?.status ?? result?.signal ?? '?'}`;
  log(`[WARN] hermes-pm-install - "${command}" lỗi (${why}). Cài đặt vẫn tiếp tục; chạy tay sau đó: `
    + `HERMES_HOME="${layout.home}" ${command} rồi khởi động lại Hermes gateway`);
  return { ok: false, command, detail: why };
}

function vieneuLayout(hermesHome) {
  const root = join(hermesHome, 'tts');
  const venv = join(root, '.venv');
  return {
    root,
    scriptPath: join(root, 'vieneu_provider.py'),
    pythonPath: platform() === 'win32'
      ? join(venv, 'Scripts', 'python.exe')
      : join(venv, 'bin', 'python'),
  };
}

function runChecked(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${label}: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  return result;
}

function ensureVieneu(sidecarRoot, layout, { skipPython = false, commandProbe = spawnSync } = {}) {
  const target = vieneuLayout(layout.home);
  const source = join(sidecarRoot, 'tts', 'vieneu_provider.py');
  if (!existsSync(source)) throw new Error(`Thiếu VieNeu provider trong bộ cài: ${source}`);
  const ffmpeg = commandProbe('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (ffmpeg.status !== 0) throw new Error('Cần cài ffmpeg trước khi bật VieNeu TTS');
  atomicWriteText(target.scriptPath, readFileSync(source, 'utf8'));
  if (skipPython) return target;

  // Hermes mới không còn <repo>/.venv: dựng venv VieNeu từ Python của môi trường do Hermes quản lý.
  const basePython = pythonPath(layout.repoRoot) || hermesRuntimePython(layout, layout.home);
  if (!basePython) throw new Error('Không tìm thấy Python venv của Hermes để tạo môi trường VieNeu');
  const probe = () => spawnSync(
    target.pythonPath,
    ['-c', vieneuProbeScript()],
    { encoding: 'utf8' },
  );
  if (!existsSync(target.pythonPath)) {
    const uv = platform() === 'win32'
      ? join(layout.home, 'bin', 'uv.exe')
      : join(layout.home, 'bin', 'uv');
    if (existsSync(uv)) {
      runChecked(uv, ['venv', join(target.root, '.venv'), '--python', basePython], 'Không tạo được venv VieNeu');
    } else {
      runChecked(basePython, ['-m', 'venv', join(target.root, '.venv')], 'Không tạo được venv VieNeu');
    }
  }
  if (probe().status !== 0) {
    const uv = platform() === 'win32'
      ? join(layout.home, 'bin', 'uv.exe')
      : join(layout.home, 'bin', 'uv');
    if (existsSync(uv)) {
      runChecked(
        uv,
        ['pip', 'install', '--python', target.pythonPath, `vieneu==${VIENEU_VERSION}`, 'edge-tts'],
        'Không cài được VieNeu',
      );
    } else {
      runChecked(
        target.pythonPath,
        ['-m', 'pip', 'install', `vieneu==${VIENEU_VERSION}`, 'edge-tts'],
        'Không cài được VieNeu',
      );
    }
  }
  if (probe().status !== 0) throw new Error('Môi trường VieNeu chưa import được vieneu và edge_tts');
  return target;
}

function ensureWebsockets(layout, hermesHome, { skipPython = false, managed = false, run = spawnSync } = {}) {
  if (skipPython) return { skipped: true };
  const python = hermesRuntimePython(layout, hermesHome);
  if (!python) {
    // Hermes mới chưa dựng xong môi trường (hermes pm install lỗi): đã cảnh báo kèm lệnh chạy tay, không dừng cài đặt.
    if (managed) return { python: null, ok: false };
    throw new Error('Không tìm thấy Python venv của Hermes để cài websockets');
  }
  let probe = run(python, ['-c', 'import websockets'], { encoding: 'utf8' });
  // Hermes mới: cài tay vào môi trường do Hermes quản lý sẽ mất khi dựng lại — thư viện đi qua `hermes pm install`.
  if (managed) return { python, ok: probe.status === 0 };
  if (probe.status !== 0) {
    const uv = platform() === 'win32'
      ? join(hermesHome, 'bin', 'uv.exe')
      : join(hermesHome, 'bin', 'uv');
    const install = existsSync(uv)
      ? run(uv, ['pip', 'install', '--python', python, 'websockets'], { encoding: 'utf8' })
      : run(python, ['-m', 'pip', 'install', 'websockets'], { encoding: 'utf8' });
    if (install.status !== 0) throw new Error(`Không cài được websockets: ${install.stderr || install.stdout}`);
    probe = run(python, ['-c', 'import websockets'], { encoding: 'utf8' });
  }
  if (probe.status !== 0) throw new Error('Python của Hermes chưa import được websockets');
  return { python };
}

/**
 * Cài bộ giải mã JPEG XL cho ảnh Zalo. Không có thì bot vẫn chạy, chỉ báo với
 * người gửi là chưa đọc được ảnh dạng đó — nên hỏng ở đây không chặn cài đặt.
 */
function ensureJxlDecoder(layout, hermesHome, { skipPython = false, managed = false, run = spawnSync } = {}) {
  if (skipPython) return { skipped: true };
  const python = hermesRuntimePython(layout, hermesHome);
  if (!python) return { skipped: true };
  if (run(python, ['-c', 'import pillow_jxl'], { encoding: 'utf8' }).status === 0) return { python };
  if (managed) return { python, ok: false }; // Hermes mới: thư viện đi qua `hermes pm install`, không cài tay.
  const uv = join(hermesHome, 'bin', platform() === 'win32' ? 'uv.exe' : 'uv');
  const install = existsSync(uv)
    ? run(uv, ['pip', 'install', '--python', python, 'pillow-jxl-plugin'], { encoding: 'utf8' })
    : run(python, ['-m', 'pip', 'install', 'pillow-jxl-plugin'], { encoding: 'utf8' });
  return { python, ok: install.status === 0 };
}

function styleGuidePath(sidecarRoot) {
  return join(resolve(sidecarRoot), 'hermes-plugin', 'zalo', 'style-guide.md');
}

// Tiêu đề các mục của mọi bản hướng dẫn trình bày từng được trình cài chép vào platform_hints.zalo.append (≤ 2.19).
const LEGACY_GUIDE_HEADINGS = [
  'Trình bày tin nhắn Zalo — đúc từ thực chiến',
  'Bị gọi suông trong nhóm: đọc ngữ cảnh rồi nói vào việc',
  'Công thức: viết bằng ký tự Unicode, không dùng LaTeX',
  'Đăng Fanpage: chỉ đi bằng công cụ, và phải kiểm tra trước khi báo xong',
  'Đây là bộ mặc định — sửa được',
  'Độ dài và chỗ ngắt tin',
  'Đừng dùng `---` để tạo khoảng trắng',
  'Ghi chú kỹ thuật',
  'Hỏi về tài liệu, văn bản: tra kho trước',
  'In đậm tiêu đề, nhãn mục và từ khoá',
  'Màu chữ: đỏ, xanh, cam — đúng chỗ, đúng ngữ cảnh',
  'Màu chữ: dùng đỏ để nhấn mạnh, còn lại tuỳ ngữ cảnh',
  'Nhờ soạn nội dung: bản soạn đứng riêng một tin',
  'Phân tầng như văn bản hành chính',
  'Sticker: nhóm vui thì dùng, đang làm việc thì đừng',
  'Tag người trong nhóm: chỉ khi thật sự cần gọi',
  'Tin thoại: chỉ gửi khi được yêu cầu',
  'Tổng hợp thảo luận nhóm: chỉ khi chủ nhân yêu cầu, và đọc hết trước khi viết',
];

const HEADING = /^#{1,2}\s+(.+?)\s*$/;

/** Tiêu đề mục (# / ##) của hướng dẫn hiện tại cộng mọi bản cũ — để nhận ra phần trình cài từng chép. */
export function styleGuideHeadings(sidecarRoot) {
  const source = styleGuidePath(sidecarRoot);
  if (!existsSync(source)) throw new Error(`Thiếu hướng dẫn trình bày Zalo trong bộ cài: ${source}`);
  const current = readFileSync(source, 'utf8').split(/\r?\n/).map((l) => HEADING.exec(l)?.[1]).filter(Boolean);
  return new Set([...LEGACY_GUIDE_HEADINGS, ...current]);
}

/** Bỏ khỏi ``text`` các mục có tiêu đề thuộc ``headings`` (cả nội dung tới tiêu đề kế tiếp); giữ nguyên phần còn lại. */
export function stripStyleGuide(text, headings) {
  const kept = [];
  let skipping = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) skipping = headings.has(heading[1]);
    if (!skipping) kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function configObject(configPath) {
  try { return parse(readFileSync(configPath, 'utf8')) || {}; } catch { return null; }
}

/** Giá trị một khoá trong `.env` của Hermes (dòng sau cùng thắng, bỏ nháy); không có → ''. */
function hermesEnvValue(home, key) {
  const file = join(home, '.env');
  if (!existsSync(file)) return '';
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(l));
  if (!lines.length) return '';
  return lines.at(-1).replace(/^[^=]*=/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
}

/**
 * Dòng doctor cho Second brain (spec §18.5.4): bật bằng ZALO_SECOND_BRAIN_URL, chỉ Linux, chỉ loopback.
 * Chỉ đọc cấu hình — không gọi mạng. Chỉ hỏng khi đã đặt mà địa chỉ không phải loopback (trên Linux).
 */
export function secondBrainCheck({ url = '', hostPlatform = platform() } = {}) {
  const st = secondBrainStatus({ url, platform: hostPlatform });
  if (st.reason === 'windows') {
    return { ok: true, detail: url ? 'luôn tắt trên Windows (ZALO_SECOND_BRAIN_URL bị bỏ qua)' : 'luôn tắt trên Windows' };
  }
  if (st.reason === 'unset') return { ok: true, detail: `tắt — muốn bật trên VPS: thêm ${SECOND_BRAIN_KEY}=http://127.0.0.1:1933 vào .env của Hermes` };
  if (st.reason === 'not-loopback') return { ok: false, detail: `${SECOND_BRAIN_KEY} phải là địa chỉ 127.0.0.1/localhost — sửa lại trong .env của Hermes` };
  return { ok: true, detail: `bật — ${st.base}` };
}

/**
 * Dòng doctor cho trí nhớ dài hạn (spec §19.10). TẮT mặc định; chỉ đọc cấu hình, không gọi mạng.
 * Hỏng khi đã chọn provider zalo_memory mà thiếu plugin, hoặc OPENVIKING_ENDPOINT không phải loopback.
 */
export function memoryCheck({ provider = '', endpoint = '', pluginInstalled = true, hostPlatform = platform() } = {}) {
  if (provider !== LM_PROVIDER) return { ok: true, detail: 'tắt (mặc định) — bật trên VPS có OpenViking: xem README, mục "Trí nhớ dài hạn"' };
  if (!pluginInstalled) return { ok: false, detail: 'config.yaml chọn memory.provider: zalo_memory nhưng thiếu plugin — chạy lại install:hermes' };
  const st = learnedMemoryStatus({ provider, endpoint, platform: hostPlatform });
  if (st.reason === 'windows') return { ok: true, detail: 'zalo_memory không chạy trên Windows (tự tắt) — bỏ memory.provider khỏi config.yaml' };
  if (st.reason === 'not-loopback') return { ok: false, detail: 'OPENVIKING_ENDPOINT phải là 127.0.0.1/localhost — sửa lại trong .env của Hermes' };
  return { ok: true, detail: `bật — zalo_memory, OpenViking ${st.base}` };
}

/**
 * Bộ cài trên Linux: thấy dịch vụ OpenViking đang chạy mà chưa bật Second brain → in cách bật. KHÔNG tự đặt biến:
 * kho này có thể chứa ghi nhớ riêng của chủ máy. Windows, đã đặt, hoặc không thấy dịch vụ → null.
 */
export function secondBrainHint({ hostPlatform = platform(), url = '', envFile = '.env của Hermes', commandProbe = spawnSync } = {}) {
  if (hostPlatform !== 'linux' || String(url).trim()) return null;
  for (const unit of ['hermes-openviking.service', 'openviking.service']) {
    const probe = commandProbe('systemctl', ['is-active', '--quiet', unit], { encoding: 'utf8' });
    if (probe?.status === 0) {
      return `Thấy OpenViking (${unit}) trên máy này. Muốn bật trang Second brain (chỉ Quản trị) thì thêm dòng sau vào ${envFile} `
        + `rồi khởi động lại dashboard:\n  ${SECOND_BRAIN_KEY}=http://127.0.0.1:1933\nBộ cài không tự bật — kho này có thể chứa ghi nhớ riêng.`;
    }
  }
  return null;
}

/**
 * Bộ cài trên Linux: thấy dịch vụ OpenViking mà chưa bật trí nhớ dài hạn → in cách bật (spec §19.10). KHÔNG tự bật:
 * trí nhớ tự học ghi lại nội dung trò chuyện của khách — chủ bot phải tự quyết. Windows / đã bật / không thấy dịch vụ → null.
 */
export function memoryHint({ hostPlatform = platform(), provider = '', configFile = 'config.yaml của Hermes', commandProbe = spawnSync } = {}) {
  if (hostPlatform !== 'linux' || provider === LM_PROVIDER) return null;
  for (const unit of ['hermes-openviking.service', 'openviking.service']) {
    if (commandProbe('systemctl', ['is-active', '--quiet', unit], { encoding: 'utf8' })?.status === 0) {
      return `Thấy OpenViking (${unit}). Muốn bot tự học theo từng nhóm/người (tắt mặc định): đặt memory.provider: zalo_memory trong ${configFile} `
        + 'rồi khởi động lại gateway; chu kỳ rút trí nhớ chỉnh ở dashboard › Trí nhớ. Xem README, mục "Trí nhớ dài hạn".';
    }
  }
  return null;
}

export function doctorHermes({
  sidecarRoot,
  hermesHome,
  skipPython = false,
  noDashboard = false,
  commandProbe = spawnSync,
  hostPlatform = platform(),
} = {}) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });
  let layout;
  try {
    layout = resolveHermesLayout({ hermesHome });
    add('hermes-layout', true, layout.repoRoot);
  } catch (error) {
    add('hermes-layout', false, error.message);
    return { ok: false, checks };
  }
  const root = resolve(sidecarRoot || fileURLToPath(new URL('..', import.meta.url)));
  const targets = pluginTargets(layout.home);
  const platformDir = targets.platform;
  const toolsDir = targets.tools;
  add('zalo-platform', existsSync(join(platformDir, 'adapter.py')));
  add('zalo-tools', existsSync(join(toolsDir, 'tools.py')));
  const manifestPath = join(platformDir, 'plugin.yaml');
  const manifest = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
  add('portable-manifest', Boolean(manifest) && !manifest.includes('{{SIDECAR_SERVER}}') && manifest.includes('server.js'));
  const config = configObject(layout.configPath);
  const enabled = config?.plugins?.enabled || [];
  const known = config?.known_plugin_toolsets?.zalo || [];
  add('config', Boolean(config) && enabled.includes(PLATFORM_KEY) && enabled.includes(TOOLS_KEY)
    && known.includes('zalo_owner') && known.includes('zalo_public') && known.includes('zalo_cron'));
  // Bản cũ chép plugin vào mã Hermes; còn sót thì provider trí nhớ cũ thắng bản mới và platform đăng ký trùng.
  const leftovers = legacyLeftovers(layout);
  if (leftovers.length) {
    add('legacy-plugin-copies', true, `CẢNH BÁO: còn bản plugin cũ trong mã Hermes (${leftovers.join(', ')}) — `
      + 'chạy lại install:hermes để dọn; nếu git của Hermes đang theo dõi các thư mục này thì gỡ tay');
  }
  // Hermes mới: plugins.isolation: host chạy plugin bên thứ ba trong tiến trình riêng — plugin nền tảng không chạy được ở đó.
  if (existsSync(join(layout.repoRoot, 'hermes_cli', 'plugin_isolation.py')) && pluginIsolationMode(config) === 'host') {
    add('plugin-isolation', true, 'CẢNH BÁO: config.yaml đặt plugins.isolation: host — plugin nền tảng Zalo không chạy được '
      + 'trong tiến trình plugin riêng; bỏ khoá này (mặc định in_process) rồi khởi động lại gateway');
  }
  const installedGuide = existsSync(join(platformDir, 'style-guide.md'));
  const configuredAppend = config?.platform_hints?.zalo?.append;
  let leftover = false;
  if (installedGuide && typeof configuredAppend === 'string') {
    try { leftover = stripStyleGuide(configuredAppend, styleGuideHeadings(root)) !== configuredAppend.trim(); } catch { /* thiếu bộ cài */ }
  }
  add('style-guide', installedGuide && !leftover, !installedGuide
    ? 'plugin thiếu style-guide.md — chạy lại install:hermes'
    : leftover
      ? 'platform_hints.zalo.append còn bản hướng dẫn cũ chép tay — chạy lại install:hermes để gỡ'
      : 'hướng dẫn trình bày đi theo plugin');
  const sidecarToken = readBridgeToken(join(root, '.env'));
  const hermesToken = config?.platforms?.zalo?.extra?.bridge_token;
  add('bridge-token', Boolean(sidecarToken && hermesToken && sidecarToken === String(hermesToken)));
  add('sidecar-server', existsSync(join(root, 'server.js')));
  // Từ 1.11.1 người trong nhóm không gọi được MCP nào trừ khi khai ZALO_PUBLIC_MCP —
  // báo ra để ai đang cho nhóm dùng một server (vd. kho RAG) biết mà mở lại.
  const mcpServers = Object.keys(config?.mcp_servers || {});
  if (mcpServers.length) {
    const hermesEnv = join(layout.home, '.env');
    const raw = existsSync(hermesEnv)
      ? (readFileSync(hermesEnv, 'utf8').match(/^ZALO_PUBLIC_MCP=(.*)$/m)?.[1] || '')
      : '';
    const open = raw.split(',').map((part) => part.trim()).filter(Boolean);
    add('mcp-for-members', true, open.length
      ? `người trong nhóm gọi được MCP khớp: ${open.join(', ')} (đang cấu hình: ${mcpServers.join(', ')})`
      : `MCP ${mcpServers.join(', ')} chỉ chủ nhân dùng được — muốn mở cho nhóm thì thêm ZALO_PUBLIC_MCP=<tên server> vào .env của Hermes`);
  }
  const secondBrain = secondBrainCheck({ url: hermesEnvValue(layout.home, SECOND_BRAIN_KEY), hostPlatform });
  add('second-brain', secondBrain.ok, secondBrain.detail);
  const memory = memoryCheck({
    provider: String(config?.memory?.provider ?? '').trim(), endpoint: hermesEnvValue(layout.home, 'OPENVIKING_ENDPOINT'),
    pluginInstalled: existsSync(join(targets.memory, '__init__.py')), hostPlatform,
  });
  add('long-term-memory', memory.ok, memory.detail);
  const configuredVieneu = config?.tts?.providers?.[VIENEU_PROVIDER];
  const target = vieneuLayout(layout.home);
  const managedVieneu = config?.tts?.provider === VIENEU_PROVIDER
    && configuredVieneu?.type === 'command'
    && String(configuredVieneu.command || '').includes(target.scriptPath);
  if (managedVieneu) {
    add('vieneu-provider', existsSync(target.scriptPath));
    if (!skipPython) {
      const probe = existsSync(target.pythonPath)
        ? commandProbe(target.pythonPath, ['-c', vieneuProbeScript()], { encoding: 'utf8' })
        : null;
      add('vieneu-python', Boolean(probe?.status === 0));
      const ffmpeg = commandProbe('ffmpeg', ['-version'], { encoding: 'utf8' });
      add('vieneu-ffmpeg', ffmpeg.status === 0);
    }
  }
  if (!skipPython) {
    const python = hermesRuntimePython(layout, layout.home, { hostPlatform });
    // Hermes mới: thư viện khai trong plugin.yaml (python_dependencies), cài bằng `hermes pm install`; cài tay sẽ mất.
    const managed = managedHermes(layout, layout.home, { hostPlatform });
    const fix = (packages) => (managed
      ? `chạy: ${hermesExecutable(layout, { hostPlatform })} pm install (rồi khởi động lại Hermes gateway)`
      : `uv pip install --python <venv Hermes> ${packages}`);
    const probe = python ? commandProbe(python, ['-c', 'import websockets'], { encoding: 'utf8' }) : null;
    add('python-websockets', Boolean(python && probe?.status === 0), python && probe?.status === 0 ? '' : `thiếu — ${fix('websockets')}`);
    // Bộ giải mã JPEG XL chỉ là tuỳ chọn: thiếu thì bot vẫn chạy, chỉ báo với
    // người gửi là chưa đọc được ảnh dạng đó. Không đánh hỏng cả bản chẩn đoán.
    const jxl = python ? commandProbe(python, ['-c', 'import pillow_jxl'], { encoding: 'utf8' }) : null;
    add('python-pillow-jxl', true, jxl?.status === 0
      ? 'có — ảnh JPEG XL được chuyển sang JPG'
      : `thiếu — ảnh chỉ có bản JPEG XL sẽ báo lỗi; cài bằng: ${fix('pillow-jxl-plugin')}`);
    // Thư viện dựng tệp cho zalo_make_file cũng là tuỳ chọn: thiếu thì chỉ công cụ đó báo lỗi.
    const docs = python ? commandProbe(python, ['-c', 'import docx, pptx, openpyxl, fpdf'], { encoding: 'utf8' }) : null;
    add('python-document-libs', true, docs?.status === 0
      ? 'có — bot tạo được tệp Word/PowerPoint/Excel/PDF'
      : `thiếu — bot chưa tạo được tệp; cài bằng: ${fix('python-docx python-pptx openpyxl fpdf2')}`);
    // Xử lý PDF (zalo_pdf) cũng tuỳ chọn.
    const pdf = python ? commandProbe(python, ['-c', 'import pymupdf, pdf2docx'], { encoding: 'utf8' }) : null;
    add('python-pdf-libs', true, pdf?.status === 0
      ? 'có — bot chuyển PDF sang Word, gộp và tách PDF được'
      : `thiếu — bot chưa xử lý PDF được; cài bằng: ${fix('pymupdf pdf2docx')}`);
    // Đọc/tải video (zalo_video_info, zalo_video_download) cũng tuỳ chọn. ffmpeg để ghép hình với tiếng.
    const video = python ? commandProbe(python, ['-c', 'import yt_dlp, curl_cffi, youtube_transcript_api'], { encoding: 'utf8' }) : null;
    const ffmpeg = commandProbe('ffmpeg', ['-version'], { encoding: 'utf8' });
    add('video-tools', true, video?.status === 0 && ffmpeg?.status === 0
      ? 'có — bot đọc và tải được video YouTube/TikTok/Facebook'
      : `thiếu — bot chưa đọc/tải được video; cài: ${fix('"yt-dlp[default,curl-cffi]" youtube-transcript-api')}, và cài ffmpeg`);
  }
  if (!noDashboard) addDashboardChecks(add, { layout, root, commandProbe, hostPlatform });
  return { ok: checks.every((check) => check.ok), checks };
}

// Dashboard là phần tuỳ chọn: thiếu/chưa chạy chỉ là cảnh báo (ok:true + chi tiết).
function addDashboardChecks(add, { layout, root, commandProbe, hostPlatform }) {
  let paths; let config;
  try {
    const env = { ...process.env, HERMES_HOME: layout.home };
    paths = resolveDashboardPaths({ env, sidecarRoot: root });
    config = loadDashboardConfig(env);
  } catch (error) {
    add('dashboard-running', true, `chưa kiểm tra được — ${error.message}`);
    return;
  }
  const script = `fetch('http://127.0.0.1:${config.port}/healthz',{signal:AbortSignal.timeout(2000)}).then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))`;
  let up = false;
  try {
    up = commandProbe(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000, windowsHide: true })?.status === 0;
  } catch { /* coi như chưa chạy */ }
  add('dashboard-running', true, up
    ? `đang chạy ở cổng ${config.port}`
    : `chưa chạy — chạy lại install:hermes (hoặc npm run dashboard) để bật; mở ở ${config.publicUrl}`);
  let hasAdmin = false;
  try { hasAdmin = createUserStore(paths.usersFile).hasAdmin(); } catch { /* chưa có */ }
  add('dashboard-admin', true, hasAdmin ? 'đã có tài khoản Quản trị' : 'chưa có — chạy npm run dashboard:setup-link');
  const hasTelegram = Boolean(readJson(paths.telegramFile, {})?.token);
  add('dashboard-telegram', true, hasTelegram ? 'đã cài bot cảnh báo' : 'chưa cài bot cảnh báo');
  // Nút "khởi động lại" trên Linux mặc định gọi systemctl restart zalo-bridge / hermes-gateway.
  if (hostPlatform !== 'win32') {
    const missing = [['zalo-bridge', 'ZALO_SIDECAR_RESTART_CMD', config.restartCmd], ['hermes-gateway', 'ZALO_ASSISTANT_RESTART_CMD', config.assistantRestartCmd]]
      .filter(([service, , custom]) => {
        if (custom) return false;
        try {
          return commandProbe('systemctl', ['cat', service], { encoding: 'utf8', timeout: 5000, windowsHide: true })?.status !== 0;
        } catch { return true; }
      });
    add('dashboard-restart', true, missing.length
      ? `chưa có dịch vụ ${missing.map(([s]) => s).join(', ')} — đặt ${missing.map(([, v]) => v).join('/')} trong .env của bot để nút khởi động lại chạy được`
      : 'khởi động lại được kết nối Zalo và trợ lý từ dashboard');
    const readable = permissionsReadableDetail(paths.permissionsFile, { commandProbe });
    if (readable) add('permissions-readable', true, readable);
  }
}

/**
 * Linux: user chạy dịch vụ hermes-gateway có đọc được permissions.json không (dashboard ghi tệp quyền 600,
 * nên chạy dashboard dưới user khác là bot không đọc được và lặng lẽ dùng mặc định). Chỉ cảnh báo.
 * Trả chuỗi chi tiết, hoặc null khi chưa có tệp.
 */
export function permissionsReadableDetail(file, { commandProbe = spawnSync, stat = statSync } = {}) {
  if (!existsSync(file)) return null;
  const opts = { encoding: 'utf8', timeout: 5000, windowsHide: true };
  const run = (cmd, args) => { try { return commandProbe(cmd, args, opts); } catch { return null; } };
  const svc = run('systemctl', ['show', '-p', 'User', '--value', 'hermes-gateway']);
  if (svc?.status !== 0) return 'chưa kiểm được — không đọc được dịch vụ hermes-gateway';
  const user = String(svc.stdout || '').trim() || 'root';
  if (user === 'root') return 'hermes-gateway chạy bằng root — đọc được tệp phân quyền';
  const uid = run('id', ['-u', user]);
  const gids = run('id', ['-G', user]);
  if (uid?.status !== 0 || gids?.status !== 0) return `chưa kiểm được — không tra được user ${user} của hermes-gateway`;
  const st = stat(file);
  const groups = String(gids.stdout || '').trim().split(/\s+/).map(Number);
  const bits = st.uid === Number(String(uid.stdout || '').trim()) ? 0o400 : groups.includes(st.gid) ? 0o040 : 0o004;
  return (st.mode & bits)
    ? `hermes-gateway (user ${user}) đọc được tệp phân quyền`
    : `CẢNH BÁO: hermes-gateway chạy bằng user ${user} nhưng không đọc được ${file} — bot đang bỏ qua Phân quyền Bot. `
      + `Chạy dashboard bằng cùng user với hermes-gateway, rồi chown ${user} tệp này`;
}

export async function installHermes({
  sidecarRoot,
  hermesHome,
  skipPython = false,
  vieneuTts = false,
  noDashboard = false,
  commandProbe = spawnSync,
  hostPlatform = platform(),
  dashboardInstaller = installDashboardService,
  gitRunner = spawnSync,
  pmRunner = spawnSync,
  log = console.log,
} = {}) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Cần Node.js 22 trở lên');
  const root = resolve(sidecarRoot);
  const layout = resolveHermesLayout({ hermesHome });
  const token = ensureSidecarEnv(root, layout.home);
  mkdirSync(join(root, 'data'), { recursive: true });

  // Cài vào <HERMES_HOME>/plugins (không vào mã Hermes): `hermes update` không xoá được, Hermes cũ và mới đều nạp.
  const targets = pluginTargets(layout.home);
  atomicReplaceDirectory(join(root, 'hermes-plugin', 'zalo'), targets.platform);
  atomicReplaceDirectory(join(root, 'hermes-plugin', 'zalo_tools'), targets.tools);
  // Bot đọc tệp này khi được hỏi về tính năng của chính nó (zalo_tools/self_knowledge.py).
  if (existsSync(join(root, 'CHANGELOG.md'))) copyFileSync(join(root, 'CHANGELOG.md'), join(targets.tools, 'CHANGELOG.md'));
  // Trí nhớ dài hạn (spec §19): chỉ chép plugin; KHÔNG đổi memory.provider — người cài đặt tự bật.
  atomicReplaceDirectory(join(root, 'hermes-plugin', 'zalo_memory'), targets.memory);
  const manifestPath = join(targets.platform, 'plugin.yaml');
  writeFileSync(manifestPath, renderPlatformManifest(readFileSync(manifestPath, 'utf8'), root), 'utf8');
  // Chuyển chỗ cho bản cài cũ: chỉ sau khi đã chép xong ở chỗ mới mới dọn bản trong mã Hermes.
  const migration = migrateLegacyPlugins({ repoRoot: layout.repoRoot, home: layout.home, run: gitRunner });

  const vieneu = vieneuTts ? ensureVieneu(root, layout, { skipPython, commandProbe }) : null;
  const guideHeadings = styleGuideHeadings(root);
  const currentConfig = existsSync(layout.configPath) ? readFileSync(layout.configPath, 'utf8') : '';
  const nextConfig = mergeHermesConfig(currentConfig, { bridgeToken: token, vieneu, guideHeadings });
  if (nextConfig !== currentConfig) {
    // Giữ bản cũ cạnh bản mới: config.yaml là của khách, lỡ trình cài ghi sai
    // thì vẫn còn đường khôi phục.
    if (currentConfig) {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
      writeFileSync(`${layout.configPath}.bak-${stamp}`, currentConfig, 'utf8');
    }
    atomicWriteText(layout.configPath, nextConfig);
  }
  // Hermes mới: sau khi plugin + config đã ghi, để `hermes pm install` cài python_dependencies vào môi trường của
  // Hermes (cài tay vào đó sẽ mất khi Hermes dựng lại). Hermes cũ: cài thẳng từng gói như trước.
  const managed = !skipPython && managedHermes(layout, layout.home, { hostPlatform });
  const pm = managed ? runHermesPmInstall(layout, { run: pmRunner, log, hostPlatform }) : null;
  ensureWebsockets(layout, layout.home, { skipPython, managed, run: commandProbe });
  ensureJxlDecoder(layout, layout.home, { skipPython, managed, run: commandProbe });
  // Dò lại thư viện bằng Python của Hermes (Hermes mới: môi trường vừa dựng lại) — install-hermes.js in từng dòng.
  const diagnosis = doctorHermes({
    sidecarRoot: root,
    hermesHome: layout.home,
    skipPython,
    noDashboard: true,
    commandProbe,
    hostPlatform,
  });
  // `hermes pm install` lỗi → thiếu websockets là hệ quả đã cảnh báo kèm lệnh chạy tay; không dừng cả bản cài.
  const blocking = diagnosis.checks.filter((c) => !c.ok && !(pm && !pm.ok && c.name === 'python-websockets'));
  if (blocking.length) throw new Error(`Cài đặt chưa hoàn chỉnh: ${JSON.stringify(diagnosis.checks)}`);
  if (noDashboard) return { ...diagnosis, migration, pm };

  // Dashboard không bao giờ làm hỏng bản cài chính: lỗi nào cũng chỉ thành cảnh báo.
  let config = null;
  let paths = null;
  try {
    const env = { ...process.env, HERMES_HOME: layout.home };
    config = loadDashboardConfig(env);
    paths = resolveDashboardPaths({ env, sidecarRoot: root });
  } catch { /* dùng mặc định bên dưới */ }
  const dashboard = await dashboardInstaller({ sidecarRoot: root, ...(config ? { port: config.port } : {}) });
  let setupLink = null;
  let caddy = '';
  if (config && paths) {
    try {
      setupLink = issueSetupLink({ paths, config });
      caddy = caddySnippet(config.publicUrl, config.port);
    } catch (error) {
      dashboard.detail = `${dashboard.detail} (không tạo được link thiết lập: ${error.message})`;
    }
  }
  const secondBrain = secondBrainHint({
    hostPlatform, url: hermesEnvValue(layout.home, SECOND_BRAIN_KEY), envFile: join(layout.home, '.env'), commandProbe,
  });
  const memory = memoryHint({
    hostPlatform, provider: String(configObject(layout.configPath)?.memory?.provider ?? '').trim(), configFile: layout.configPath, commandProbe,
  });
  return { ...diagnosis, migration, pm, dashboard, setupLink, caddy, secondBrain, memory };
}

export function uninstallHermes({
  hermesHome, noDashboard = false, dashboardUninstaller = uninstallDashboardService, gitRunner = spawnSync,
} = {}) {
  const layout = resolveHermesLayout({ hermesHome });
  const fresh = pluginTargets(layout.home);
  const targets = [fresh.platform, fresh.tools, fresh.memory];
  for (const target of targets) {
    if (!within(fresh.root, target)) throw new Error(`Đích gỡ cài đặt không an toàn: ${target}`);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }
  // Bản cũ trong mã Hermes (≤ 2.36): cùng luật với lúc cài — không bao giờ xoá thứ git của Hermes theo dõi.
  const legacy = migrateLegacyPlugins({ repoRoot: layout.repoRoot, home: layout.home, run: gitRunner });
  const dashboard = noDashboard ? { removed: [], detail: '' } : dashboardUninstaller();
  return { ok: true, removed: [...targets, ...legacy.removed, ...dashboard.removed], kept: legacy.kept, dashboardDetail: dashboard.detail };
}
