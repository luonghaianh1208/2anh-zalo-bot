import {
  existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, cpSync,
  renameSync, rmSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse, stringify } from 'yaml';

const PLATFORM_KEY = 'platforms/zalo';
const TOOLS_KEY = 'zalo-tools';

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

export function resolveHermesLayout({ hermesHome = null, env = process.env, cwd = process.cwd() } = {}) {
  const explicit = hermesHome || env.HERMES_HOME;
  if (explicit) {
    const layout = layoutFromCandidate(explicit);
    if (layout) return layout;
    throw new Error(`Không tìm thấy Hermes Agent hợp lệ tại: ${resolve(explicit)}`);
  }

  const candidates = [cwd, dirname(cwd), join(homedir(), '.hermes')];
  if (platform() === 'win32' && env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'hermes'));
  for (const candidate of candidates) {
    const layout = layoutFromCandidate(candidate);
    if (layout) return layout;
  }
  throw new Error('Không tự tìm thấy Hermes Agent; hãy truyền --hermes-home <đường-dẫn>');
}

function ensureObject(parent, key) {
  if (!parent[key] || typeof parent[key] !== 'object' || Array.isArray(parent[key])) parent[key] = {};
  return parent[key];
}

function setDefault(parent, key, value) {
  if (parent[key] === undefined) parent[key] = value;
}

export function mergeHermesConfig(text, { bridgeToken } = {}) {
  const config = parse(text || '') || {};
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('config.yaml phải chứa một YAML mapping ở cấp cao nhất');
  }

  const knownToolsets = ensureObject(config, 'known_plugin_toolsets');
  if (!Array.isArray(knownToolsets.zalo)) knownToolsets.zalo = [];
  for (const name of ['zalo_owner', 'zalo_public']) {
    if (!knownToolsets.zalo.includes(name)) knownToolsets.zalo.push(name);
  }
  setDefault(config, 'group_sessions_per_user', false);

  const enabled = ensureObject(config, 'plugins');
  if (!Array.isArray(enabled.enabled)) enabled.enabled = [];
  for (const name of [PLATFORM_KEY, TOOLS_KEY]) if (!enabled.enabled.includes(name)) enabled.enabled.push(name);
  if (Array.isArray(enabled.disabled)) {
    enabled.disabled = enabled.disabled.filter((name) => name !== PLATFORM_KEY && name !== TOOLS_KEY);
  }

  const zaloPlatform = ensureObject(ensureObject(config, 'platforms'), 'zalo');
  setDefault(zaloPlatform, 'enabled', true);
  const extra = ensureObject(zaloPlatform, 'extra');
  setDefault(extra, 'bridge_url', 'ws://127.0.0.1:3873');
  setDefault(extra, 'reply_only_tagged', true);
  if (bridgeToken) extra.bridge_token = bridgeToken;

  const display = ensureObject(ensureObject(ensureObject(config, 'display'), 'platforms'), 'zalo');
  setDefault(display, 'tool_progress', 'off');
  setDefault(display, 'long_running_notifications', false);
  setDefault(display, 'busy_ack_detail', false);
  setDefault(display, 'show_reasoning', false);
  setDefault(display, 'streaming', false);
  setDefault(display, 'interim_assistant_messages', false);

  return stringify(config, { lineWidth: 0 });
}

export function renderPlatformManifest(template, sidecarRoot) {
  const serverPath = join(resolve(sidecarRoot), 'server.js').replaceAll('\\', '/');
  return String(template).replaceAll('{{SIDECAR_SERVER}}', `\\"${serverPath}\\"`);
}

function within(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
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
      renameSync(destination, backup);
      movedOld = true;
    }
    renameSync(staging, destination);
    if (movedOld) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    if (movedOld && !existsSync(destination) && existsSync(backup)) renameSync(backup, destination);
    throw error;
  }
}

function readBridgeToken(envPath) {
  if (!existsSync(envPath)) return null;
  const match = readFileSync(envPath, 'utf8').match(/^ZALO_BRIDGE_TOKEN=(.+)$/m);
  return match?.[1]?.trim() || null;
}

function ensureSidecarEnv(sidecarRoot) {
  const envPath = join(sidecarRoot, '.env');
  if (!existsSync(envPath)) {
    const examplePath = join(sidecarRoot, '.env.example');
    copyFileSync(examplePath, envPath);
  }
  let token = readBridgeToken(envPath);
  if (!token) {
    token = randomBytes(32).toString('hex');
    const current = readFileSync(envPath, 'utf8');
    writeFileSync(envPath, `${current}${current.endsWith('\n') || !current ? '' : '\n'}ZALO_BRIDGE_TOKEN=${token}\n`, 'utf8');
  }
  return token;
}

function pythonPath(repoRoot) {
  const candidates = platform() === 'win32'
    ? [join(repoRoot, 'venv', 'Scripts', 'python.exe'), join(repoRoot, '.venv', 'Scripts', 'python.exe')]
    : [join(repoRoot, 'venv', 'bin', 'python'), join(repoRoot, '.venv', 'bin', 'python')];
  return candidates.find(existsSync) || null;
}

function ensureWebsockets(repoRoot, { skipPython = false } = {}) {
  if (skipPython) return { skipped: true };
  const python = pythonPath(repoRoot);
  if (!python) throw new Error('Không tìm thấy Python venv của Hermes để cài websockets');
  let probe = spawnSync(python, ['-c', 'import websockets'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    const install = spawnSync(python, ['-m', 'pip', 'install', 'websockets'], { encoding: 'utf8' });
    if (install.status !== 0) throw new Error(`Không cài được websockets: ${install.stderr || install.stdout}`);
    probe = spawnSync(python, ['-c', 'import websockets'], { encoding: 'utf8' });
  }
  if (probe.status !== 0) throw new Error('Python của Hermes chưa import được websockets');
  return { python };
}

function configObject(configPath) {
  try { return parse(readFileSync(configPath, 'utf8')) || {}; } catch { return null; }
}

export function doctorHermes({ sidecarRoot, hermesHome, skipPython = false } = {}) {
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
  const root = resolve(sidecarRoot || dirname(new URL(import.meta.url).pathname));
  const platformDir = join(layout.repoRoot, 'plugins', 'platforms', 'zalo');
  const toolsDir = join(layout.repoRoot, 'plugins', 'zalo_tools');
  add('zalo-platform', existsSync(join(platformDir, 'adapter.py')));
  add('zalo-tools', existsSync(join(toolsDir, 'tools.py')));
  const manifestPath = join(platformDir, 'plugin.yaml');
  const manifest = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
  add('portable-manifest', Boolean(manifest) && !manifest.includes('{{SIDECAR_SERVER}}') && manifest.includes('server.js'));
  const config = configObject(layout.configPath);
  const enabled = config?.plugins?.enabled || [];
  const known = config?.known_plugin_toolsets?.zalo || [];
  add('config', Boolean(config) && enabled.includes(PLATFORM_KEY) && enabled.includes(TOOLS_KEY)
    && known.includes('zalo_owner') && known.includes('zalo_public'));
  add('sidecar-server', existsSync(join(root, 'server.js')));
  if (!skipPython) {
    const python = pythonPath(layout.repoRoot);
    const probe = python ? spawnSync(python, ['-c', 'import websockets'], { encoding: 'utf8' }) : null;
    add('python-websockets', Boolean(python && probe?.status === 0));
  }
  return { ok: checks.every((check) => check.ok), checks };
}

export async function installHermes({ sidecarRoot, hermesHome, skipPython = false } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Cần Node.js 22 trở lên');
  const root = resolve(sidecarRoot);
  const layout = resolveHermesLayout({ hermesHome });
  const token = ensureSidecarEnv(root);
  mkdirSync(join(root, 'data'), { recursive: true });

  const platformDestination = join(layout.repoRoot, 'plugins', 'platforms', 'zalo');
  const toolsDestination = join(layout.repoRoot, 'plugins', 'zalo_tools');
  atomicReplaceDirectory(join(root, 'hermes-plugin', 'zalo'), platformDestination);
  atomicReplaceDirectory(join(root, 'hermes-plugin', 'zalo_tools'), toolsDestination);
  const manifestPath = join(platformDestination, 'plugin.yaml');
  writeFileSync(manifestPath, renderPlatformManifest(readFileSync(manifestPath, 'utf8'), root), 'utf8');

  const currentConfig = existsSync(layout.configPath) ? readFileSync(layout.configPath, 'utf8') : '';
  writeFileSync(layout.configPath, mergeHermesConfig(currentConfig, { bridgeToken: token }), 'utf8');
  ensureWebsockets(layout.repoRoot, { skipPython });
  const diagnosis = doctorHermes({ sidecarRoot: root, hermesHome: layout.home, skipPython });
  if (!diagnosis.ok) throw new Error(`Cài đặt chưa hoàn chỉnh: ${JSON.stringify(diagnosis.checks)}`);
  return diagnosis;
}

export function uninstallHermes({ hermesHome } = {}) {
  const layout = resolveHermesLayout({ hermesHome });
  const pluginRoot = join(layout.repoRoot, 'plugins');
  const targets = [join(pluginRoot, 'platforms', 'zalo'), join(pluginRoot, 'zalo_tools')];
  for (const target of targets) {
    if (!within(pluginRoot, target)) throw new Error(`Đích gỡ cài đặt không an toàn: ${target}`);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }
  return { ok: true, removed: targets };
}
