import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

import {
  parseCliArgs,
  vieneuProbeScript,
  resolveHermesLayout,
  findSeparateHermesRepo,
  mergeHermesConfig,
  renderPlatformManifest,
  installHermes as installHermesReal,
  doctorHermes,
  permissionsReadableDetail,
  uninstallHermes as uninstallHermesReal,
} from './hermes-install-lib.js';

// Mặc định không đụng systemd / thư mục Startup thật khi kiểm thử.
const installHermes = (options) => installHermesReal({ noDashboard: true, ...options });
const uninstallHermes = (options) => uninstallHermesReal({ noDashboard: true, ...options });

const HERE = fileURLToPath(new URL('.', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'zalo-installer-'));
  t.after(() => import('node:fs').then(({ rmSync }) => rmSync(root, { recursive: true, force: true })));
  const sidecar = join(root, '2anh-zalo-bot');
  const hermesHome = join(root, 'hermes-home');
  const hermesRepo = join(hermesHome, 'hermes-agent');
  mkdirSync(join(sidecar, 'hermes-plugin', 'zalo'), { recursive: true });
  mkdirSync(join(sidecar, 'hermes-plugin', 'zalo_tools'), { recursive: true });
  mkdirSync(join(sidecar, 'hermes-plugin', 'zalo_memory'), { recursive: true });
  writeFileSync(join(sidecar, 'hermes-plugin', 'zalo_memory', '__init__.py'), '# zalo_memory\n');
  mkdirSync(join(sidecar, 'tts'), { recursive: true });
  writeFileSync(join(sidecar, 'server.js'), '// fixture\n');
  writeFileSync(join(sidecar, '.env.example'), 'ZALO_BRIDGE_PORT=3873\n');
  writeFileSync(join(sidecar, 'hermes-plugin', 'zalo', 'plugin.yaml'), 'name: zalo-platform\nstart_command: node "{{SIDECAR_SERVER}}"\n');
  writeFileSync(join(sidecar, 'hermes-plugin', 'zalo', 'adapter.py'), '# adapter\n');
  writeFileSync(join(sidecar, 'hermes-plugin', 'zalo_tools', 'plugin.yaml'), 'name: zalo-tools\n');
  writeFileSync(join(sidecar, 'hermes-plugin', 'zalo_tools', 'tools.py'), '# tools\n');
  writeFileSync(join(sidecar, 'tts', 'vieneu_provider.py'), '# vieneu provider\n');
  writeFileSync(join(sidecar, 'hermes-plugin', 'zalo-style-guide.md'), '# Hướng dẫn trình bày Zalo\n\nNội dung mặc định dùng cho kiểm thử.\n');
  mkdirSync(join(hermesRepo, 'plugins', 'platforms'), { recursive: true });
  mkdirSync(join(hermesRepo, 'gateway'), { recursive: true });
  writeFileSync(join(hermesRepo, 'pyproject.toml'), '[project]\nname="hermes-agent"\n');
  writeFileSync(join(hermesHome, 'config.yaml'), 'model:\n  provider: custom\ncustom_value: keep-me\nplatforms:\n  zalo:\n    extra:\n      reply_only_tagged: false\n');
  return { root, sidecar, hermesHome, hermesRepo };
}

test('parseCliArgs keeps VieNeu opt-in explicit', () => {
  assert.equal(parseCliArgs([]).vieneuTts, undefined);
  assert.equal(parseCliArgs(['--vieneu-tts']).vieneuTts, true);
});

test('VieNeu probe enforces the pinned package version', () => {
  assert.match(vieneuProbeScript(), /sys\.exit\(0 if version\("vieneu"\) == "3\.6\.4" else 1\)/);
  assert.doesNotMatch(vieneuProbeScript(), /assert/);
});

test('resolveHermesLayout accepts a Hermes home and rejects an unrelated directory', (t) => {
  const fx = fixture(t);
  const layout = resolveHermesLayout({ hermesHome: fx.hermesHome });
  assert.equal(layout.home, fx.hermesHome);
  assert.equal(layout.repoRoot, fx.hermesRepo);
  assert.equal(layout.configPath, join(fx.hermesHome, 'config.yaml'));
  assert.throws(() => resolveHermesLayout({ hermesHome: fx.sidecar, findRepo: () => fx.hermesRepo }), /Hermes Agent/, 'không có config.yaml → không phải HERMES_HOME');
});

test('resolveHermesLayout: HERMES_HOME tách khỏi mã Hermes (bố trí Linux /root/.hermes + /opt/hermes/hermes-agent)', (t) => {
  const fx = fixture(t);
  const home = join(fx.sidecar, '..', 'dot-hermes');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.yaml'), 'model: {}\n');
  const layout = resolveHermesLayout({ hermesHome: home, findRepo: () => fx.hermesRepo });
  assert.deepEqual(layout, { home: resolve(home), repoRoot: fx.hermesRepo, configPath: join(resolve(home), 'config.yaml') });
  assert.throws(() => resolveHermesLayout({ hermesHome: home, findRepo: () => null }), /Hermes Agent/);
  const viaPath = findSeparateHermesRepo({
    env: { PATH: '/usr/bin:/usr/local/bin' }, hostPlatform: 'linux',
    exists: (p) => p === join('/usr/local/bin', 'hermes'), real: () => join(fx.hermesRepo, '.venv', 'bin', 'hermes'),
  });
  assert.equal(viaPath, fx.hermesRepo);
});

test('mergeHermesConfig adds safe defaults and preserves customer values', async () => {
  const input = 'custom_value: keep-me\ngroup_sessions_per_user: true\nknown_plugin_toolsets:\n  zalo: [customer_tool]\nplatforms:\n  zalo:\n    extra:\n      reply_only_tagged: false\n';
  const output = mergeHermesConfig(input, { bridgeToken: 'bridge-secret' });
  const { parse } = await import('yaml');
  const config = parse(output);
  assert.equal(config.custom_value, 'keep-me');
  assert.equal(config.group_sessions_per_user, true);
  assert.equal(config.platforms.zalo.extra.reply_only_tagged, false);
  assert.equal(config.platforms.zalo.extra.bridge_token, 'bridge-secret');
  assert.deepEqual(config.known_plugin_toolsets.zalo, ['customer_tool', 'zalo_owner', 'zalo_public', 'zalo_cron']);
  assert.equal(config.plugins.hook_callback_timeout, 0);
  assert.equal(config.display.platforms.zalo.tool_progress, 'off');
  assert.deepEqual(config.plugins.enabled, ['platforms/zalo', 'zalo-tools']);
});

test('mergeHermesConfig giữ comment và số nguyên lớn của khách', () => {
  const input = '# cấu hình của khách\nmodel:\n  provider: custom # đừng xoá\ndiscord:\n  channel: 1234567890123456789\n';
  const output = mergeHermesConfig(input, { bridgeToken: 'bridge-secret' });

  assert.match(output, /# cấu hình của khách/);
  assert.match(output, /# đừng xoá/);
  assert.match(output, /channel: 1234567890123456789\b/);
  assert.equal(parse(output).platforms.zalo.extra.bridge_token, 'bridge-secret');
});

test('install giữ bản sao lưu config.yaml trước khi ghi đè', async (t) => {
  const fx = fixture(t);
  const original = readFileSync(join(fx.hermesHome, 'config.yaml'), 'utf8');

  await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });

  const backups = readdirSync(fx.hermesHome).filter((name) => name.startsWith('config.yaml.bak-'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(fx.hermesHome, backups[0]), 'utf8'), original);
});

test('cài lại với --hermes-home khác thì cập nhật HERMES_HOME trong .env của sidecar', async (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.sidecar, '.env'), 'ZALO_BRIDGE_TOKEN=fixed-token\nHERMES_HOME=C:/nham/cho\n');

  await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });

  const env = readFileSync(join(fx.sidecar, '.env'), 'utf8');
  assert.match(env, new RegExp(`^HERMES_HOME=${fx.hermesHome.replaceAll('\\', '/')}$`, 'm'));
  assert.doesNotMatch(env, /nham\/cho/);
  assert.match(env, /^ZALO_BRIDGE_TOKEN=fixed-token$/m);
});

test('renderPlatformManifest replaces the portable placeholder with a quoted absolute server path', (t) => {
  const fx = fixture(t);
  const template = 'start_command: node "{{SIDECAR_SERVER}}"\n';
  const rendered = renderPlatformManifest(template, fx.sidecar);
  assert.doesNotMatch(rendered, /SIDECAR_SERVER/);
  assert.match(rendered, /node ".*server\.js"/);
  assert.doesNotMatch(rendered, /\\"/);
});

test('install is repeatable, installs both plugins, and preserves env and config', async (t) => {
  const fx = fixture(t);
  const first = await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  assert.equal(first.ok, true);
  assert.equal(existsSync(join(fx.hermesRepo, 'plugins', 'platforms', 'zalo', 'adapter.py')), true);
  assert.equal(existsSync(join(fx.hermesRepo, 'plugins', 'zalo_tools', 'tools.py')), true);
  assert.match(readFileSync(join(fx.sidecar, '.env'), 'utf8'), /^ZALO_BRIDGE_TOKEN=[a-f0-9]{64}$/m);
  assert.match(readFileSync(join(fx.sidecar, '.env'), 'utf8'), new RegExp(`^HERMES_HOME=${fx.hermesHome.replaceAll('\\', '/')}$`, 'm'));
  writeFileSync(join(fx.sidecar, '.env'), 'CUSTOM_SENTINEL=preserve\nZALO_BRIDGE_TOKEN=fixed-token\n');
  await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  assert.match(readFileSync(join(fx.sidecar, '.env'), 'utf8'), /^CUSTOM_SENTINEL=preserve\nZALO_BRIDGE_TOKEN=fixed-token\nHERMES_HOME=/);
  assert.match(readFileSync(join(fx.hermesHome, 'config.yaml'), 'utf8'), /custom_value: keep-me/);
  const diagnosis = doctorHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  assert.equal(diagnosis.ok, true, JSON.stringify(diagnosis.checks));
});

test('VieNeu is untouched by default and installed only after explicit opt-in', async (t) => {
  const fx = fixture(t);
  writeFileSync(
    join(fx.hermesHome, 'config.yaml'),
    'tts:\n  provider: elevenlabs\n  elevenlabs:\n    voice_id: customer-voice\n',
  );

  await installHermes({
    sidecarRoot: fx.sidecar,
    hermesHome: fx.hermesHome,
    skipPython: true,
  });
  let config = parse(readFileSync(join(fx.hermesHome, 'config.yaml'), 'utf8'));
  assert.equal(config.tts.provider, 'elevenlabs');
  assert.equal(config.tts.elevenlabs.voice_id, 'customer-voice');
  assert.equal(config.tts.providers?.['vieneu-local'], undefined);
  assert.equal(existsSync(join(fx.hermesHome, 'tts', 'vieneu_provider.py')), false);

  await installHermes({
    sidecarRoot: fx.sidecar,
    hermesHome: fx.hermesHome,
    skipPython: true,
    vieneuTts: true,
    commandProbe: () => ({ status: 0 }),
  });
  config = parse(readFileSync(join(fx.hermesHome, 'config.yaml'), 'utf8'));
  const provider = config.tts.providers['vieneu-local'];
  assert.equal(config.tts.provider, 'vieneu-local');
  assert.equal(config.tts.elevenlabs.voice_id, 'customer-voice');
  assert.equal(provider.type, 'command');
  assert.equal(provider.output_format, 'wav');
  assert.equal(provider.voice, 'Minh Quân');
  assert.equal(provider.voice_compatible, true);
  assert.match(provider.command, /vieneu_provider\.py/);
  assert.equal(existsSync(join(fx.hermesHome, 'tts', 'vieneu_provider.py')), true);

  const diagnosis = doctorHermes({
    sidecarRoot: fx.sidecar,
    hermesHome: fx.hermesHome,
    skipPython: true,
  });
  assert.equal(diagnosis.ok, true, JSON.stringify(diagnosis.checks));
  assert.equal(
    diagnosis.checks.find((check) => check.name === 'vieneu-provider')?.ok,
    true,
  );
});

test('doctor ignores a customer-defined provider that only shares the VieNeu name', (t) => {
  const fx = fixture(t);
  writeFileSync(
    join(fx.hermesHome, 'config.yaml'),
    'tts:\n  provider: vieneu-local\n  providers:\n    vieneu-local:\n      type: command\n      command: customer-tts --input {input_path} --output {output_path}\n',
  );
  const diagnosis = doctorHermes({
    sidecarRoot: fx.sidecar,
    hermesHome: fx.hermesHome,
    skipPython: true,
  });
  assert.equal(
    diagnosis.checks.some((check) => check.name.startsWith('vieneu-')),
    false,
  );
});

test('doctor reports a missing ffmpeg prerequisite for the managed provider', async (t) => {
  const fx = fixture(t);
  await installHermes({
    sidecarRoot: fx.sidecar,
    hermesHome: fx.hermesHome,
    skipPython: true,
    vieneuTts: true,
    commandProbe: () => ({ status: 0 }),
  });
  const diagnosis = doctorHermes({
    sidecarRoot: fx.sidecar,
    hermesHome: fx.hermesHome,
    commandProbe(command) {
      if (command === 'ffmpeg') return { status: 1 };
      return { status: 0 };
    },
  });
  assert.equal(
    diagnosis.checks.find((check) => check.name === 'vieneu-ffmpeg')?.ok,
    false,
  );
});

test('missing ffmpeg aborts opt-in before changing customer TTS config', async (t) => {
  const fx = fixture(t);
  const original = 'tts:\n  provider: elevenlabs\n  elevenlabs:\n    voice_id: customer-voice\n';
  writeFileSync(join(fx.hermesHome, 'config.yaml'), original);
  await assert.rejects(
    installHermes({
      sidecarRoot: fx.sidecar,
      hermesHome: fx.hermesHome,
      skipPython: true,
      vieneuTts: true,
      commandProbe(command) {
        return { status: command === 'ffmpeg' ? 1 : 0 };
      },
    }),
    /ffmpeg/,
  );
  assert.equal(readFileSync(join(fx.hermesHome, 'config.yaml'), 'utf8'), original);
});

test('uninstall removes only managed plugin directories', async (t) => {
  const fx = fixture(t);
  const unrelated = join(fx.hermesRepo, 'plugins', 'keep-me.txt');
  writeFileSync(unrelated, 'safe');
  await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  const result = uninstallHermes({ hermesHome: fx.hermesHome });
  assert.equal(result.ok, true);
  assert.equal(existsSync(join(fx.hermesRepo, 'plugins', 'platforms', 'zalo')), false);
  assert.equal(existsSync(join(fx.hermesRepo, 'plugins', 'zalo_tools')), false);
  assert.equal(readFileSync(unrelated, 'utf8'), 'safe');
  assert.equal(existsSync(join(fx.sidecar, '.env')), true);
});

test('doctor fails when Hermes and sidecar bridge tokens drift apart', async (t) => {
  const fx = fixture(t);
  await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  const configPath = join(fx.hermesHome, 'config.yaml');
  writeFileSync(configPath, readFileSync(configPath, 'utf8').replace(/bridge_token: .+/, 'bridge_token: wrong-token'));
  const diagnosis = doctorHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  assert.equal(diagnosis.ok, false);
  assert.equal(diagnosis.checks.find((check) => check.name === 'bridge-token').ok, false);
});

test('install lần đầu ghi hướng dẫn trình bày mặc định vào platform_hints.zalo.append', async (t) => {
  const fx = fixture(t);
  await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  const config = parse(readFileSync(join(fx.hermesHome, 'config.yaml'), 'utf8'));
  const guide = readFileSync(join(fx.sidecar, 'hermes-plugin', 'zalo-style-guide.md'), 'utf8').trim();
  assert.equal(config.platform_hints.zalo.append, guide);
});

test('install không đè lên platform_hints.zalo.append mà khách đã tự viết', async (t) => {
  const fx = fixture(t);
  const customerText = 'Giọng điệu tự viết của khách — trang trọng, xưng "em", chào khi vào nhóm mới.';
  writeFileSync(
    join(fx.hermesHome, 'config.yaml'),
    `platform_hints:\n  zalo:\n    append: ${JSON.stringify(customerText)}\n`,
  );
  await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  const config = parse(readFileSync(join(fx.hermesHome, 'config.yaml'), 'utf8'));
  assert.equal(config.platform_hints.zalo.append, customerText);
});

test('doctor nhắc MCP chỉ chủ nhân dùng được cho tới khi khai ZALO_PUBLIC_MCP', async (t) => {
  const fx = fixture(t);
  await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  let diagnosis = doctorHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  assert.equal(diagnosis.checks.find((c) => c.name === 'mcp-for-members'), undefined);

  const configPath = join(fx.hermesHome, 'config.yaml');
  const config = parse(readFileSync(configPath, 'utf8'));
  config.mcp_servers = { rag: { url: 'https://rag.example/mcp' } };
  writeFileSync(configPath, stringify(config));
  diagnosis = doctorHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  let check = diagnosis.checks.find((c) => c.name === 'mcp-for-members');
  assert.equal(check.ok, true);
  assert.match(check.detail, /chỉ chủ nhân/);

  writeFileSync(join(fx.hermesHome, '.env'), 'ZALO_PUBLIC_MCP=rag\n', { flag: 'a' });
  diagnosis = doctorHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  check = diagnosis.checks.find((c) => c.name === 'mcp-for-members');
  assert.match(check.detail, /gọi được MCP khớp: rag/);
});

test('doctor báo đúng mục style-guide: đã ghi bản mặc định rồi báo khách đang dùng bản riêng', async (t) => {
  const fx = fixture(t);
  await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  let diagnosis = doctorHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  let check = diagnosis.checks.find((c) => c.name === 'style-guide');
  assert.equal(check.ok, true);
  assert.match(check.detail, /mặc định/);

  const configPath = join(fx.hermesHome, 'config.yaml');
  const config = parse(readFileSync(configPath, 'utf8'));
  config.platform_hints.zalo.append = 'Giọng điệu riêng của khách, không phải bản mặc định.';
  writeFileSync(configPath, stringify(config));

  diagnosis = doctorHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  check = diagnosis.checks.find((c) => c.name === 'style-guide');
  assert.equal(check.ok, true);
  assert.match(check.detail, /riêng/);
});

test('installHermes wires the dashboard service, setup link and Caddy block without touching the system', async (t) => {
  const fx = fixture(t);
  const calls = [];
  const prev = { url: process.env.ZALO_DASHBOARD_URL, port: process.env.ZALO_DASHBOARD_PORT };
  process.env.ZALO_DASHBOARD_URL = 'https://dashboard.example.vn/';
  delete process.env.ZALO_DASHBOARD_PORT;
  t.after(() => {
    if (prev.url === undefined) delete process.env.ZALO_DASHBOARD_URL; else process.env.ZALO_DASHBOARD_URL = prev.url;
    if (prev.port !== undefined) process.env.ZALO_DASHBOARD_PORT = prev.port;
  });
  const result = await installHermesReal({
    sidecarRoot: fx.sidecar,
    hermesHome: fx.hermesHome,
    skipPython: true,
    dashboardInstaller: (opts) => { calls.push(opts.sidecarRoot); return { installed: false, detail: 'giả lập' }; },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.dashboard.installed, false);
  assert.match(result.setupLink, /^https:\/\/dashboard\.example\.vn\/#\/setup\/[\w-]+$/);
  assert.match(result.caddy, /dashboard\.example\.vn \{/);
  assert.equal(existsSync(join(fx.hermesHome, 'zalo', 'dashboard', 'setup.json')), true);
});

test('doctorHermes reports dashboard checks as warnings, never failures', (t) => {
  const fx = fixture(t);
  const probe = (cmd, args) => ({ status: args?.[0] === '-e' ? 1 : 0 });
  return installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true }).then(() => {
    const diagnosis = doctorHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true, commandProbe: probe });
    assert.equal(diagnosis.ok, true, JSON.stringify(diagnosis.checks));
    const byName = Object.fromEntries(diagnosis.checks.map((c) => [c.name, c]));
    assert.match(byName['dashboard-running'].detail, /^chưa chạy — /);
    assert.match(byName['dashboard-admin'].detail, /npm run dashboard:setup-link/);
    assert.match(byName['dashboard-telegram'].detail, /chưa cài bot cảnh báo/);
  });
});

test('doctorHermes trên Linux: thiếu dịch vụ systemd cho nút khởi động lại chỉ là cảnh báo kèm cách sửa', async (t) => {
  const fx = fixture(t);
  await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  const prev = { s: process.env.ZALO_SIDECAR_RESTART_CMD, a: process.env.ZALO_ASSISTANT_RESTART_CMD };
  delete process.env.ZALO_SIDECAR_RESTART_CMD; delete process.env.ZALO_ASSISTANT_RESTART_CMD;
  t.after(() => {
    if (prev.s !== undefined) process.env.ZALO_SIDECAR_RESTART_CMD = prev.s; else delete process.env.ZALO_SIDECAR_RESTART_CMD;
    if (prev.a !== undefined) process.env.ZALO_ASSISTANT_RESTART_CMD = prev.a; else delete process.env.ZALO_ASSISTANT_RESTART_CMD;
  });
  const seen = [];
  const probe = (have) => (cmd, args) => {
    if (cmd === 'systemctl') { seen.push(args.join(' ')); return { status: have.includes(args[1]) ? 0 : 1 }; }
    return { status: 1 };
  };
  const check = (have) => {
    const d = doctorHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true, commandProbe: probe(have), hostPlatform: 'linux' });
    assert.equal(d.ok, true, JSON.stringify(d.checks));
    return d.checks.find((c) => c.name === 'dashboard-restart');
  };
  const missingBridge = check(['hermes-gateway']);
  assert.equal(missingBridge.ok, true);
  assert.match(missingBridge.detail, /chưa có dịch vụ zalo-bridge — đặt ZALO_SIDECAR_RESTART_CMD/);
  assert.doesNotMatch(missingBridge.detail, /hermes-gateway/);
  assert.deepEqual(seen, ['cat zalo-bridge', 'cat hermes-gateway']);
  assert.match(check([]).detail, /zalo-bridge, hermes-gateway — đặt ZALO_SIDECAR_RESTART_CMD\/ZALO_ASSISTANT_RESTART_CMD/);
  assert.doesNotMatch(check(['zalo-bridge', 'hermes-gateway']).detail, /chưa có/);
  // Đã khai lệnh riêng thì không cần dịch vụ systemd.
  process.env.ZALO_SIDECAR_RESTART_CMD = 'my-restart'; process.env.ZALO_ASSISTANT_RESTART_CMD = 'my-restart-2';
  seen.length = 0;
  assert.doesNotMatch(check([]).detail, /chưa có/);
  assert.deepEqual(seen, []);
  // Windows không có kiểm tra này.
  const win = doctorHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true, commandProbe: probe([]), hostPlatform: 'win32' });
  assert.equal(win.checks.find((c) => c.name === 'dashboard-restart'), undefined);
});

test('doctor (Linux): cảnh báo khi user của hermes-gateway không đọc được permissions.json', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'perm-readable-'));
  const file = join(dir, 'permissions.json');
  assert.equal(permissionsReadableDetail(file, { commandProbe: () => { throw new Error('không được gọi'); } }), null);
  writeFileSync(file, '{}');
  const runner = (user, { uid = '1001', groups = '1001 27' } = {}) => (cmd, args) => {
    if (cmd === 'systemctl') return user === null ? { status: 1 } : { status: 0, stdout: `${user}\n` };
    if (cmd === 'id') return { status: 0, stdout: `${args[0] === '-u' ? uid : groups}\n` };
    return { status: 1 };
  };
  const stat = (mode, uid, gid) => () => ({ mode, uid, gid });
  const detail = (user, st, ids) => permissionsReadableDetail(file, { commandProbe: runner(user, ids), stat: st });
  // Dashboard chạy bằng user khác ghi tệp 600 → gateway không đọc được.
  assert.match(detail('hermes', stat(0o100600, 1000, 1000)), /CẢNH BÁO: .*user hermes .*không đọc được/);
  assert.match(detail('hermes', stat(0o100600, 1001, 1000)), /đọc được tệp phân quyền/);
  assert.match(detail('hermes', stat(0o100640, 1000, 27)), /đọc được tệp phân quyền/);
  // Chủ tệp chỉ xét bit của chủ, dù bit "người khác" cho đọc.
  assert.match(detail('hermes', stat(0o100004, 1001, 1001)), /CẢNH BÁO/);
  assert.match(detail('', stat(0o100600, 1000, 1000)), /root — đọc được/);
  assert.match(detail(null, stat(0o100600, 1000, 1000)), /chưa kiểm được/);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
});

// --- Second brain (spec §18.5.4): chỉ Linux, bật bằng ZALO_SECOND_BRAIN_URL, bộ cài chỉ gợi ý ---
test('Second brain: dòng doctor — Windows luôn tắt, chưa đặt thì hướng dẫn, không phải loopback thì hỏng', async () => {
  const { secondBrainCheck } = await import('./hermes-install-lib.js');
  assert.deepEqual(secondBrainCheck({ url: 'http://127.0.0.1:1933', hostPlatform: 'win32' }), { ok: true, detail: 'luôn tắt trên Windows (ZALO_SECOND_BRAIN_URL bị bỏ qua)' });
  assert.match(secondBrainCheck({ url: '', hostPlatform: 'linux' }).detail, /^tắt — muốn bật trên VPS: thêm ZALO_SECOND_BRAIN_URL=/);
  assert.equal(secondBrainCheck({ url: 'http://10.1.2.3:1933', hostPlatform: 'linux' }).ok, false);
  assert.deepEqual(secondBrainCheck({ url: 'http://127.0.0.1:1933', hostPlatform: 'linux' }), { ok: true, detail: 'bật — http://127.0.0.1:1933' });
});

test('Second brain: bộ cài chỉ in gợi ý khi thấy OpenViking trên Linux và chưa đặt biến — không bao giờ tự đặt', async () => {
  const { secondBrainHint } = await import('./hermes-install-lib.js');
  const calls = [];
  const probe = (active) => (cmd, args) => { calls.push([cmd, ...args]); return { status: args.at(-1) === active ? 0 : 3 }; };
  const hint = secondBrainHint({ hostPlatform: 'linux', url: '', envFile: '/root/.hermes/.env', commandProbe: probe('hermes-openviking.service') });
  assert.match(hint, /hermes-openviking\.service/);
  assert.match(hint, /ZALO_SECOND_BRAIN_URL=http:\/\/127\.0\.0\.1:1933/);
  assert.match(hint, /\/root\/\.hermes\/\.env/);
  assert.deepEqual(calls[0], ['systemctl', 'is-active', '--quiet', 'hermes-openviking.service']);
  assert.equal(secondBrainHint({ hostPlatform: 'linux', url: '', commandProbe: probe('khong-co') }), null);
  assert.equal(secondBrainHint({ hostPlatform: 'linux', url: 'http://127.0.0.1:1933', commandProbe: probe('hermes-openviking.service') }), null, 'đã đặt');
  assert.equal(secondBrainHint({ hostPlatform: 'win32', url: '', commandProbe: () => { throw new Error('không được gọi'); } }), null);
});

test('Second brain: doctor đọc ZALO_SECOND_BRAIN_URL trong .env của Hermes; cài đặt không ghi biến này', async (t) => {
  const fx = fixture(t);
  await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  const envFile = join(fx.hermesHome, '.env');
  assert.ok(!existsSync(envFile) || !/ZALO_SECOND_BRAIN_URL/.test(readFileSync(envFile, 'utf8')));
  writeFileSync(envFile, 'ZALO_SECOND_BRAIN_URL="http://192.168.1.9:1933"\n');
  const bad = doctorHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true, noDashboard: true, hostPlatform: 'linux' });
  assert.equal(bad.checks.find((c) => c.name === 'second-brain').ok, false);
  writeFileSync(envFile, 'ZALO_SECOND_BRAIN_URL=http://127.0.0.1:1933\n');
  const good = doctorHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true, noDashboard: true, hostPlatform: 'linux' });
  assert.equal(good.checks.find((c) => c.name === 'second-brain').detail, 'bật — http://127.0.0.1:1933');
});

// --- Trí nhớ dài hạn (spec §19.10): bộ cài chép plugin nhưng không bao giờ tự bật ---
test('trí nhớ dài hạn: cài chép plugin vào plugins/memory, không đổi memory.provider; doctor báo tắt/bật/hỏng; gỡ cài xoá plugin', async (t) => {
  const fx = fixture(t);
  await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  const plugin = join(fx.hermesRepo, 'plugins', 'memory', 'zalo_memory', '__init__.py');
  assert.equal(existsSync(plugin), true);
  assert.doesNotMatch(readFileSync(join(fx.hermesHome, 'config.yaml'), 'utf8'), /provider:\s*zalo_memory/);
  const doctor = (platform) => doctorHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true, noDashboard: true, hostPlatform: platform })
    .checks.find((c) => c.name === 'long-term-memory');
  assert.match(doctor('linux').detail, /^tắt \(mặc định\)/);
  writeFileSync(join(fx.hermesHome, 'config.yaml'), `${readFileSync(join(fx.hermesHome, 'config.yaml'), 'utf8')}memory:\n  provider: zalo_memory\n`);
  assert.deepEqual(doctor('linux'), { name: 'long-term-memory', ok: true, detail: 'bật — zalo_memory, OpenViking http://127.0.0.1:1933' });
  assert.match(doctor('win32').detail, /không chạy trên Windows/);
  writeFileSync(join(fx.hermesHome, '.env'), 'OPENVIKING_ENDPOINT=http://10.0.0.9:1933\n');
  assert.equal(doctor('linux').ok, false);
  uninstallHermes({ hermesHome: fx.hermesHome });
  assert.equal(existsSync(plugin), false);
});

test('trí nhớ dài hạn: gợi ý bật chỉ in trên Linux có OpenViking và chưa bật — không bao giờ tự bật', async () => {
  const { memoryHint } = await import('./hermes-install-lib.js');
  const probe = (active) => (_cmd, args) => ({ status: args.at(-1) === active ? 0 : 3 });
  assert.match(memoryHint({ hostPlatform: 'linux', provider: '', configFile: '/root/.hermes/config.yaml', commandProbe: probe('hermes-openviking.service') }),
    /memory\.provider: zalo_memory trong \/root\/\.hermes\/config\.yaml rồi khởi động lại gateway/);
  assert.equal(memoryHint({ hostPlatform: 'linux', provider: 'zalo_memory', commandProbe: probe('hermes-openviking.service') }), null);
  assert.equal(memoryHint({ hostPlatform: 'linux', provider: '', commandProbe: probe('khong-co') }), null);
  assert.equal(memoryHint({ hostPlatform: 'win32', provider: '', commandProbe: () => { throw new Error('không được gọi'); } }), null);
});
