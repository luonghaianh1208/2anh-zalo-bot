import {
  existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, cpSync,
  renameSync, rmSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

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

export function mergeHermesConfig(text, { bridgeToken, vieneu = null } = {}) {
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

  if (vieneu) {
    const tts = ensureObject(config, 'tts');
    tts.provider = VIENEU_PROVIDER;
    setDefault(tts, 'speed', 1.0);
    const provider = ensureObject(ensureObject(tts, 'providers'), VIENEU_PROVIDER);
    provider.type = 'command';
    provider.command = `${quoteCommandPath(vieneu.pythonPath)} ${quoteCommandPath(vieneu.scriptPath)} --input {input_path} --output {output_path} --voice {voice} --speed {speed}`;
    provider.output_format = 'wav';
    provider.voice = 'Minh Quân';
    provider.speed = 1.0;
    provider.timeout = 180;
    provider.voice_compatible = true;
  }

  return stringify(config, { lineWidth: 0 });
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
  appendEnvValue(envPath, 'HERMES_HOME', resolve(hermesHome).replaceAll('\\', '/'));
  return token;
}

function pythonPath(repoRoot) {
  const candidates = platform() === 'win32'
    ? [join(repoRoot, 'venv', 'Scripts', 'python.exe'), join(repoRoot, '.venv', 'Scripts', 'python.exe')]
    : [join(repoRoot, 'venv', 'bin', 'python'), join(repoRoot, '.venv', 'bin', 'python')];
  return candidates.find(existsSync) || null;
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

  const basePython = pythonPath(layout.repoRoot);
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

function ensureWebsockets(repoRoot, hermesHome, { skipPython = false } = {}) {
  if (skipPython) return { skipped: true };
  const python = pythonPath(repoRoot);
  if (!python) throw new Error('Không tìm thấy Python venv của Hermes để cài websockets');
  let probe = spawnSync(python, ['-c', 'import websockets'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    const uv = platform() === 'win32'
      ? join(hermesHome, 'bin', 'uv.exe')
      : join(hermesHome, 'bin', 'uv');
    const install = existsSync(uv)
      ? spawnSync(uv, ['pip', 'install', '--python', python, 'websockets'], { encoding: 'utf8' })
      : spawnSync(python, ['-m', 'pip', 'install', 'websockets'], { encoding: 'utf8' });
    if (install.status !== 0) throw new Error(`Không cài được websockets: ${install.stderr || install.stdout}`);
    probe = spawnSync(python, ['-c', 'import websockets'], { encoding: 'utf8' });
  }
  if (probe.status !== 0) throw new Error('Python của Hermes chưa import được websockets');
  return { python };
}

function configObject(configPath) {
  try { return parse(readFileSync(configPath, 'utf8')) || {}; } catch { return null; }
}

export function doctorHermes({
  sidecarRoot,
  hermesHome,
  skipPython = false,
  commandProbe = spawnSync,
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
  const sidecarToken = readBridgeToken(join(root, '.env'));
  const hermesToken = config?.platforms?.zalo?.extra?.bridge_token;
  add('bridge-token', Boolean(sidecarToken && hermesToken && sidecarToken === String(hermesToken)));
  add('sidecar-server', existsSync(join(root, 'server.js')));
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
    const python = pythonPath(layout.repoRoot);
    const probe = python ? commandProbe(python, ['-c', 'import websockets'], { encoding: 'utf8' }) : null;
    add('python-websockets', Boolean(python && probe?.status === 0));
  }
  return { ok: checks.every((check) => check.ok), checks };
}

export async function installHermes({
  sidecarRoot,
  hermesHome,
  skipPython = false,
  vieneuTts = false,
  commandProbe = spawnSync,
} = {}) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Cần Node.js 22 trở lên');
  const root = resolve(sidecarRoot);
  const layout = resolveHermesLayout({ hermesHome });
  const token = ensureSidecarEnv(root, layout.home);
  mkdirSync(join(root, 'data'), { recursive: true });

  const platformDestination = join(layout.repoRoot, 'plugins', 'platforms', 'zalo');
  const toolsDestination = join(layout.repoRoot, 'plugins', 'zalo_tools');
  atomicReplaceDirectory(join(root, 'hermes-plugin', 'zalo'), platformDestination);
  atomicReplaceDirectory(join(root, 'hermes-plugin', 'zalo_tools'), toolsDestination);
  const manifestPath = join(platformDestination, 'plugin.yaml');
  writeFileSync(manifestPath, renderPlatformManifest(readFileSync(manifestPath, 'utf8'), root), 'utf8');

  const vieneu = vieneuTts ? ensureVieneu(root, layout, { skipPython, commandProbe }) : null;
  const currentConfig = existsSync(layout.configPath) ? readFileSync(layout.configPath, 'utf8') : '';
  atomicWriteText(layout.configPath, mergeHermesConfig(currentConfig, { bridgeToken: token, vieneu }));
  ensureWebsockets(layout.repoRoot, layout.home, { skipPython });
  const diagnosis = doctorHermes({
    sidecarRoot: root,
    hermesHome: layout.home,
    skipPython,
    commandProbe,
  });
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
