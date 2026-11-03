import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
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
  pluginTargets,
  legacyPluginTargets,
  migrateLegacyPlugins,
  gitTracks,
  hermesRuntimePython,
  managedHermes,
  hermesExecutable,
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
  writeFileSync(join(sidecar, 'hermes-plugin', 'zalo', 'style-guide.md'), '# Hướng dẫn trình bày Zalo\n\nNội dung mặc định dùng cho kiểm thử.\n\n## Sự thật: tra trước rồi mới khẳng định\n\nTra trước.\n');
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
  assert.equal(existsSync(join(fx.hermesHome, 'plugins', 'platforms', 'zalo', 'adapter.py')), true);
  assert.equal(existsSync(join(fx.hermesHome, 'plugins', 'zalo_tools', 'tools.py')), true);
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
  const userUnrelated = join(fx.hermesHome, 'plugins', 'other_plugin', 'plugin.yaml');
  mkdirSync(dirname(userUnrelated), { recursive: true });
  writeFileSync(userUnrelated, 'name: other\n');
  await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  // Bản cũ còn sót trong mã Hermes (không git) cũng được gỡ.
  mkdirSync(join(fx.hermesRepo, 'plugins', 'zalo_tools'), { recursive: true });
  const result = uninstallHermes({ hermesHome: fx.hermesHome });
  assert.equal(result.ok, true);
  for (const dir of [['platforms', 'zalo'], ['zalo_tools'], ['zalo_memory']]) {
    assert.equal(existsSync(join(fx.hermesHome, 'plugins', ...dir)), false, dir.join('/'));
  }
  assert.equal(existsSync(join(fx.hermesRepo, 'plugins', 'zalo_tools')), false);
  assert.equal(readFileSync(unrelated, 'utf8'), 'safe');
  assert.equal(readFileSync(userUnrelated, 'utf8'), 'name: other\n');
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

test('install không chép hướng dẫn trình bày vào config.yaml — hướng dẫn đi theo plugin', async (t) => {
  const fx = fixture(t);
  await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  const config = parse(readFileSync(join(fx.hermesHome, 'config.yaml'), 'utf8'));
  assert.equal(config.platform_hints?.zalo?.append, undefined);
});

test('install gỡ bản hướng dẫn cũ đã chép tay, giữ nguyên phần khách tự viết', async (t) => {
  const fx = fixture(t);
  const legacy = [
    'Giọng điệu riêng: vui vẻ, hoà đồng.',
    '',
    '# Trình bày tin nhắn Zalo — đúc từ thực chiến',
    '',
    'Đây là những gì chủ nhân đã học được.',
    '',
    '## Màu chữ: đỏ, xanh, cam — đúng chỗ, đúng ngữ cảnh',
    '',
    'Tô 2–5 chỗ.',
    '',
    '## Sự thật: tra trước rồi mới khẳng định',
    '',
    'Bản cũ của mục mới.',
    '',
    '---',
    '',
    '## Đây là bộ mặc định — sửa được',
    '',
    'Muốn sửa thì sửa config.yaml.',
    '',
    '## Bạn là ai',
    'Tên: Uyển Nhi.',
  ].join('\n');
  writeFileSync(join(fx.hermesHome, 'config.yaml'), `platform_hints:\n  zalo:\n    append: ${JSON.stringify(legacy)}\n`);
  await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  const config = parse(readFileSync(join(fx.hermesHome, 'config.yaml'), 'utf8'));
  assert.equal(config.platform_hints.zalo.append, 'Giọng điệu riêng: vui vẻ, hoà đồng.\n\n## Bạn là ai\nTên: Uyển Nhi.');

  const customerText = 'Giọng điệu tự viết của khách — trang trọng, xưng "em", chào khi vào nhóm mới.';
  writeFileSync(join(fx.hermesHome, 'config.yaml'), `platform_hints:\n  zalo:\n    append: ${JSON.stringify(customerText)}\n`);
  await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  assert.equal(parse(readFileSync(join(fx.hermesHome, 'config.yaml'), 'utf8')).platform_hints.zalo.append, customerText);
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

test('doctor báo mục style-guide: plugin có hướng dẫn, và nhắc khi config.yaml còn bản cũ chép tay', async (t) => {
  const fx = fixture(t);
  await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  let diagnosis = doctorHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  let check = diagnosis.checks.find((c) => c.name === 'style-guide');
  assert.equal(check.ok, true);
  assert.match(check.detail, /theo plugin/);

  const configPath = join(fx.hermesHome, 'config.yaml');
  const config = parse(readFileSync(configPath, 'utf8'));
  config.platform_hints = { zalo: { append: 'Giọng riêng.\n\n## Độ dài và chỗ ngắt tin\n\nTrần 3000 byte.' } };
  writeFileSync(configPath, stringify(config));
  diagnosis = doctorHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  check = diagnosis.checks.find((c) => c.name === 'style-guide');
  assert.equal(check.ok, false);
  assert.match(check.detail, /bản hướng dẫn cũ/);
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
test('trí nhớ dài hạn: cài chép plugin vào <HERMES_HOME>/plugins/zalo_memory, không đổi memory.provider; doctor báo tắt/bật/hỏng; gỡ cài xoá plugin', async (t) => {
  const fx = fixture(t);
  await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  const plugin = join(fx.hermesHome, 'plugins', 'zalo_memory', '__init__.py');
  assert.equal(existsSync(join(fx.hermesRepo, 'plugins', 'memory', 'zalo_memory')), false, 'không chép vào mã Hermes');
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

test('đổi tên thư mục plugin: Windows tạm giữ tệp thì thử lại; lỗi khác hoặc hết lượt thì báo', async () => {
  const { renameWithRetry } = await import('./hermes-install-lib.js');
  let n = 0;
  const flaky = () => { n += 1; if (n < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' }); };
  renameWithRetry('a', 'b', { rename: flaky, platform: 'win32', waitMs: () => 1 });
  assert.equal(n, 3);
  assert.throws(() => renameWithRetry('a', 'b', { rename: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }, platform: 'win32', waitMs: () => 1 }), /x/);
  assert.throws(() => renameWithRetry('a', 'b', { rename: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }, platform: 'win32', tries: 3, waitMs: () => 1 }), /busy/);
  assert.throws(() => renameWithRetry('a', 'b', { rename: () => { throw Object.assign(new Error('busy'), { code: 'EPERM' }); }, platform: 'linux' }), /busy/, 'Linux không thử lại');
});

// --- Cài vào <HERMES_HOME>/plugins (không vào mã Hermes) + chuyển chỗ cho bản cài cũ ---
const LEGACY = (repo) => ({
  platform: join(repo, 'plugins', 'platforms', 'zalo'),
  tools: join(repo, 'plugins', 'zalo_tools'),
  memory: join(repo, 'plugins', 'memory', 'zalo_memory'),
});

function seedLegacy(repo) {
  const old = LEGACY(repo);
  for (const dir of Object.values(old)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plugin.yaml'), 'name: old\n');
    writeFileSync(join(dir, '__init__.py'), '# bản cũ\n');
  }
  // Thư mục tạm của lần cài trước bị ngắt giữa chừng.
  mkdirSync(join(repo, 'plugins', '.zalo_tools.backup-123-abcd'), { recursive: true });
  mkdirSync(join(repo, 'plugins', 'platforms', '.zalo.install-123-abcd'), { recursive: true });
  return old;
}

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const git = (repo, ...args) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', '-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test('cài mới: ba plugin nằm ở <HERMES_HOME>/plugins, mã Hermes không bị chép gì vào', async (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.sidecar, 'CHANGELOG.md'), '## [9.9.9] — 2026-11-03\n', 'utf8');
  const result = await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  const targets = pluginTargets(fx.hermesHome);
  assert.deepEqual(targets, {
    root: join(fx.hermesHome, 'plugins'),
    platform: join(fx.hermesHome, 'plugins', 'platforms', 'zalo'),
    tools: join(fx.hermesHome, 'plugins', 'zalo_tools'),
    memory: join(fx.hermesHome, 'plugins', 'zalo_memory'),
  });
  assert.equal(existsSync(join(targets.platform, 'adapter.py')), true);
  assert.equal(existsSync(join(targets.tools, 'tools.py')), true);
  assert.equal(readFileSync(join(targets.tools, 'CHANGELOG.md'), 'utf8'), '## [9.9.9] — 2026-11-03\n');
  assert.equal(existsSync(join(targets.memory, '__init__.py')), true);
  assert.doesNotMatch(readFileSync(join(targets.platform, 'plugin.yaml'), 'utf8'), /SIDECAR_SERVER/);
  for (const dir of legacyPluginTargets(fx.hermesRepo)) assert.equal(existsSync(dir), false, dir);
  assert.deepEqual(readdirSync(join(fx.hermesRepo, 'plugins')), ['platforms']);
  assert.deepEqual(readdirSync(join(fx.hermesRepo, 'plugins', 'platforms')), []);
  assert.deepEqual(result.migration, { removed: [], kept: [] });
  const config = parse(readFileSync(join(fx.hermesHome, 'config.yaml'), 'utf8'));
  assert.deepEqual(config.plugins.enabled, ['platforms/zalo', 'zalo-tools']);
});

test('chuyển chỗ: mã Hermes không phải bản git → gỡ bản cũ và thư mục tạm còn sót, sau khi đã cài ở chỗ mới', async (t) => {
  const fx = fixture(t);
  const old = seedLegacy(fx.hermesRepo);
  const result = await installHermes({
    sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true,
    gitRunner: () => { throw new Error('không có .git thì không được hỏi git'); },
  });
  for (const dir of Object.values(old)) assert.equal(existsSync(dir), false, dir);
  assert.equal(existsSync(join(fx.hermesRepo, 'plugins', '.zalo_tools.backup-123-abcd')), false);
  assert.equal(existsSync(join(fx.hermesRepo, 'plugins', 'platforms', '.zalo.install-123-abcd')), false);
  assert.equal(existsSync(join(fx.hermesHome, 'plugins', 'zalo_tools', 'tools.py')), true);
  assert.deepEqual([...result.migration.removed].sort(), [
    old.platform, old.tools, old.memory,
    join(fx.hermesRepo, 'plugins', '.zalo_tools.backup-123-abcd'),
    join(fx.hermesRepo, 'plugins', 'platforms', '.zalo.install-123-abcd'),
  ].sort());
  assert.equal(result.checks.find((c) => c.name === 'legacy-plugin-copies'), undefined);
});

test('chuyển chỗ (bản git thật): gỡ thư mục git không theo dõi, KHÔNG BAO GIỜ đụng tệp git theo dõi', { skip: !hasGit && 'máy không có git' }, async (t) => {
  const fx = fixture(t);
  git(fx.hermesRepo, 'init', '-q');
  writeFileSync(join(fx.hermesRepo, 'plugins', 'platforms', 'README.md'), 'core\n');
  // Giả sử ai đó đã commit zalo_tools vào mã Hermes: phải giữ nguyên.
  const tracked = join(fx.hermesRepo, 'plugins', 'zalo_tools');
  mkdirSync(tracked, { recursive: true });
  writeFileSync(join(tracked, 'tools.py'), '# đã commit\n');
  git(fx.hermesRepo, 'add', '-A');
  git(fx.hermesRepo, 'commit', '-q', '-m', 'core');
  const old = LEGACY(fx.hermesRepo);
  for (const dir of [old.platform, old.memory]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '__init__.py'), '# bản cũ\n');
  }
  writeFileSync(join(tracked, 'extra.py'), '# chưa commit trong thư mục được theo dõi\n');

  assert.equal(gitTracks(fx.hermesRepo, old.platform), false);
  assert.equal(gitTracks(fx.hermesRepo, tracked), true);
  const result = await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });

  assert.equal(existsSync(old.platform), false);
  assert.equal(existsSync(old.memory), false);
  assert.equal(readFileSync(join(tracked, 'tools.py'), 'utf8'), '# đã commit\n');
  assert.equal(existsSync(join(tracked, 'extra.py')), true, 'thư mục git theo dõi giữ nguyên cả tệp chưa commit');
  assert.equal(readFileSync(join(fx.hermesRepo, 'plugins', 'platforms', 'README.md'), 'utf8'), 'core\n');
  assert.deepEqual(result.migration.kept.map((k) => k.path), [tracked]);
  assert.equal(git(fx.hermesRepo, 'status', '--porcelain', '--untracked-files=no'), '', 'cây git của Hermes không đổi');
  const warn = result.checks.find((c) => c.name === 'legacy-plugin-copies');
  assert.equal(warn.ok, true);
  assert.match(warn.detail, /CẢNH BÁO: còn bản plugin cũ trong mã Hermes/);
  assert.match(warn.detail, /zalo_tools/);
});

test('chuyển chỗ: git không trả lời được → giữ bản cũ, báo lý do; git báo "không theo dõi" → gỡ', (t) => {
  const fx = fixture(t);
  const old = seedLegacy(fx.hermesRepo);
  mkdirSync(join(fx.hermesRepo, '.git'));
  const seen = [];
  const broken = (cmd, args) => { seen.push([cmd, ...args].join(' ')); return { status: 128, stderr: 'fatal' }; };
  let result = migrateLegacyPlugins({ repoRoot: fx.hermesRepo, home: fx.hermesHome, run: broken });
  assert.deepEqual(result.kept.map((k) => k.path), [old.platform, old.tools, old.memory]);
  assert.match(result.kept[0].reason, /không hỏi được git/);
  for (const dir of Object.values(old)) assert.equal(existsSync(dir), true);
  assert.match(seen[0], /^git -c safe\.directory=\* -C .+ ls-files --error-unmatch -- plugins\/platforms\/zalo$/);
  assert.equal(gitTracks(fx.hermesRepo, old.tools, { run: () => { throw new Error('ENOENT'); } }), null);
  result = migrateLegacyPlugins({ repoRoot: fx.hermesRepo, home: fx.hermesHome, run: () => ({ status: 1 }) });
  assert.deepEqual(result.removed.slice(0, 3), [old.platform, old.tools, old.memory]);
  for (const dir of Object.values(old)) assert.equal(existsSync(dir), false);
});

test('chuyển chỗ: HERMES_HOME trùng mã Hermes → không gỡ chính bản vừa cài, chỉ gỡ plugins/memory/zalo_memory', (t) => {
  const fx = fixture(t);
  const old = seedLegacy(fx.hermesRepo);
  const result = migrateLegacyPlugins({ repoRoot: fx.hermesRepo, home: fx.hermesRepo, run: () => ({ status: 1 }) });
  assert.equal(existsSync(old.platform), true);
  assert.equal(existsSync(old.tools), true);
  assert.equal(existsSync(old.memory), false);
  assert.equal(result.removed[0], old.memory);
});

test('cài lại nhiều lần: kết quả như nhau, không còn thư mục tạm, không đụng plugin khác ở <HERMES_HOME>/plugins', async (t) => {
  const fx = fixture(t);
  seedLegacy(fx.hermesRepo);
  const other = join(fx.hermesHome, 'plugins', 'other_plugin');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'plugin.yaml'), 'name: other\n');
  const first = await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  const configAfterFirst = readFileSync(join(fx.hermesHome, 'config.yaml'), 'utf8');
  const second = await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(second.migration, { removed: [], kept: [] });
  assert.equal(readFileSync(join(fx.hermesHome, 'config.yaml'), 'utf8'), configAfterFirst);
  assert.deepEqual(readdirSync(join(fx.hermesHome, 'plugins')).sort(), ['other_plugin', 'platforms', 'zalo_memory', 'zalo_tools']);
  assert.deepEqual(readdirSync(join(fx.hermesHome, 'plugins', 'platforms')), ['zalo']);
  assert.equal(readFileSync(join(other, 'plugin.yaml'), 'utf8'), 'name: other\n');
});

test('doctor: thiếu plugin ở <HERMES_HOME>/plugins thì hỏng dù mã Hermes còn bản cũ; cảnh báo plugins.isolation: host', async (t) => {
  const fx = fixture(t);
  seedLegacy(fx.hermesRepo);
  writeFileSync(join(LEGACY(fx.hermesRepo).platform, 'adapter.py'), '# cũ\n');
  let d = doctorHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true, noDashboard: true });
  assert.equal(d.checks.find((c) => c.name === 'zalo-platform').ok, false);
  assert.match(d.checks.find((c) => c.name === 'legacy-plugin-copies').detail, /CẢNH BÁO/);

  await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  const configPath = join(fx.hermesHome, 'config.yaml');
  const withIsolation = (value) => {
    const config = parse(readFileSync(configPath, 'utf8'));
    config.plugins.isolation = value;
    writeFileSync(configPath, stringify(config));
  };
  withIsolation('host');
  d = doctorHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true, noDashboard: true });
  assert.equal(d.checks.find((c) => c.name === 'plugin-isolation'), undefined, 'Hermes cũ không có plugins.isolation');
  mkdirSync(join(fx.hermesRepo, 'hermes_cli'), { recursive: true });
  writeFileSync(join(fx.hermesRepo, 'hermes_cli', 'plugin_isolation.py'), '# Hermes mới\n');
  d = doctorHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true, noDashboard: true });
  const iso = d.checks.find((c) => c.name === 'plugin-isolation');
  assert.equal(iso.ok, true);
  assert.match(iso.detail, /CẢNH BÁO: .*plugins\.isolation: host/);
  withIsolation('in-process');
  d = doctorHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true, noDashboard: true });
  assert.equal(d.checks.find((c) => c.name === 'plugin-isolation'), undefined);
});

// ---- Hermes mới: Python + thư viện do Hermes quản lý (installs/<id>/facts.json, `hermes pm install`) ----

const envPythonRel = (hostPlatform = process.platform) => (hostPlatform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python'));

/** Giả một bản cài Hermes mới: <home>/installs/<id>/facts.json trỏ tới môi trường có python. Trả đường python. */
function seedManaged(home, { id = 'inst1', hostPlatform = process.platform, withPython = true, mtime = null } = {}) {
  const env = join(home, 'envs', id);
  const python = join(env, envPythonRel(hostPlatform));
  if (withPython) { mkdirSync(dirname(python), { recursive: true }); writeFileSync(python, ''); }
  const facts = join(home, 'installs', id, 'facts.json');
  mkdirSync(dirname(facts), { recursive: true });
  writeFileSync(facts, JSON.stringify({ packages: { venv: { environment: env } } }));
  if (mtime) utimesSync(facts, mtime, mtime);
  return python;
}

function seedVenv(repo) {
  const python = join(repo, '.venv', envPythonRel());
  mkdirSync(dirname(python), { recursive: true });
  writeFileSync(python, '');
  return python;
}

test('hermesRuntimePython: facts.json có môi trường còn tồn tại → python của môi trường đó (đúng kiểu đường theo hệ điều hành)', (t) => {
  const fx = fixture(t);
  const layout = { home: fx.hermesHome, repoRoot: fx.hermesRepo };
  seedVenv(fx.hermesRepo);
  for (const hostPlatform of ['linux', 'win32']) {
    const home = join(fx.root, `home-${hostPlatform}`);
    const python = seedManaged(home, { hostPlatform });
    assert.equal(hermesRuntimePython(layout, home, { hostPlatform }), python);
    assert.equal(managedHermes(layout, home, { hostPlatform }), true);
  }
});

test('hermesRuntimePython: nhiều facts.json → bỏ cái có môi trường đã mất, chọn cái mới sửa nhất', (t) => {
  const fx = fixture(t);
  const layout = { home: fx.hermesHome, repoRoot: fx.hermesRepo };
  const old = seedManaged(fx.hermesHome, { id: 'old', mtime: new Date('2026-01-01') });
  const fresh = seedManaged(fx.hermesHome, { id: 'fresh', mtime: new Date('2026-10-01') });
  seedManaged(fx.hermesHome, { id: 'gone', withPython: false, mtime: new Date('2026-10-10') });
  assert.equal(hermesRuntimePython(layout, fx.hermesHome), fresh);
  utimesSync(join(fx.hermesHome, 'installs', 'old', 'facts.json'), new Date('2026-10-12'), new Date('2026-10-12'));
  assert.equal(hermesRuntimePython(layout, fx.hermesHome), old);
});

test('hermesRuntimePython: thiếu / hỏng facts.json → quay về <repo>/.venv (Hermes cũ); không có gì → null', (t) => {
  const fx = fixture(t);
  const layout = { home: fx.hermesHome, repoRoot: fx.hermesRepo };
  assert.equal(hermesRuntimePython(layout, fx.hermesHome), null);
  const venv = seedVenv(fx.hermesRepo);
  assert.equal(hermesRuntimePython(layout, fx.hermesHome), venv);
  const facts = join(fx.hermesHome, 'installs', 'x', 'facts.json');
  mkdirSync(dirname(facts), { recursive: true });
  for (const body of ['{không phải json', '{}', JSON.stringify({ packages: { venv: { environment: 42 } } }),
    JSON.stringify({ packages: { venv: { environment: join(fx.root, 'khong-co') } } })]) {
    writeFileSync(facts, body);
    assert.equal(hermesRuntimePython(layout, fx.hermesHome), venv, body);
    assert.equal(managedHermes(layout, fx.hermesHome), false, body);
  }
});

test('managedHermes: facts.json hợp lệ, hoặc mã Hermes có pm/workspace.py; còn lại là Hermes cũ', (t) => {
  const fx = fixture(t);
  const layout = { home: fx.hermesHome, repoRoot: fx.hermesRepo };
  assert.equal(managedHermes(layout, fx.hermesHome), false);
  mkdirSync(join(fx.hermesRepo, 'pm'));
  writeFileSync(join(fx.hermesRepo, 'pm', 'workspace.py'), '');
  assert.equal(managedHermes(layout, fx.hermesHome), true);
  assert.equal(managedHermes({ home: fx.hermesHome, repoRoot: '' }, fx.hermesHome), false);
});

test('hermesExecutable: ZALO_HERMES_BIN → <HERMES_HOME>/bin → PATH → venv mã Hermes → "hermes"', () => {
  const layout = { home: '/h', repoRoot: '/r' };
  const has = (...paths) => (p) => paths.includes(p);
  assert.equal(hermesExecutable(layout, { env: { ZALO_HERMES_BIN: '/x/hermes' }, hostPlatform: 'linux', exists: has() }), '/x/hermes');
  assert.equal(hermesExecutable(layout, { env: { PATH: '/usr/bin' }, hostPlatform: 'linux', exists: has(join('/h', 'bin', 'hermes'), join('/usr/bin', 'hermes')) }), join('/h', 'bin', 'hermes'));
  assert.equal(hermesExecutable(layout, { env: { PATH: '/usr/bin' }, hostPlatform: 'linux', exists: has(join('/usr/bin', 'hermes'), join('/r', '.venv', 'bin', 'hermes')) }), join('/usr/bin', 'hermes'));
  assert.equal(hermesExecutable(layout, { env: {}, hostPlatform: 'linux', exists: has(join('/r', '.venv', 'bin', 'hermes')) }), join('/r', '.venv', 'bin', 'hermes'));
  assert.equal(hermesExecutable(layout, { env: {}, hostPlatform: 'win32', exists: has() }), 'hermes');
});

/** commandProbe giả: ghi lại mọi lệnh; `missing` = các module Python coi như chưa cài. */
function fakeProbe(calls, missing = []) {
  return (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === '-c') return { status: missing.some((m) => args[1].includes(m)) ? 1 : 0 };
    return { status: 0, stdout: '', stderr: '' };
  };
}

test('cài trên Hermes mới: chạy `hermes pm install` sau khi đã ghi plugin + config, dò lại bằng Python của Hermes, không pip tay', async (t) => {
  const fx = fixture(t);
  const python = seedManaged(fx.hermesHome);
  const calls = []; const pm = []; const logs = [];
  const result = await installHermes({
    sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome,
    commandProbe: fakeProbe(calls, ['pillow_jxl']),
    pmRunner: (cmd, args, opts) => {
      // Lúc này plugin (kèm plugin.yaml khai python_dependencies) và config.yaml đã nằm sẵn cho Hermes PM đọc.
      assert.ok(existsSync(join(pluginTargets(fx.hermesHome).platform, 'plugin.yaml')));
      assert.match(readFileSync(join(fx.hermesHome, 'config.yaml'), 'utf8'), /platforms\/zalo/);
      pm.push({ cmd, args, opts });
      return { status: 0 };
    },
    log: (s) => logs.push(s),
  });
  assert.equal(pm.length, 1);
  assert.deepEqual(pm[0].args, ['pm', 'install']);
  assert.equal(pm[0].opts.env.HERMES_HOME, fx.hermesHome);
  assert.ok(pm[0].opts.timeout >= 15 * 60_000);
  assert.equal(result.pm.ok, true);
  assert.ok(calls.some((c) => c[0] === python && c[2] === 'import websockets'), 'dò bằng python của môi trường do Hermes quản lý');
  assert.ok(!calls.some((c) => c.includes('pip')), 'không pip install tay vào môi trường sẽ bị dựng lại');
  assert.ok(logs.some((l) => /\[PASS\] hermes-pm-install/.test(l)));
  assert.match(result.checks.find((c) => c.name === 'python-pillow-jxl').detail, /pm install/);
});

test('cài trên Hermes cũ: không chạy `hermes pm install`, vẫn cài thẳng từng gói vào <repo>/.venv như trước', async (t) => {
  const fx = fixture(t);
  const python = seedVenv(fx.hermesRepo);
  const calls = [];
  const result = await installHermes({
    sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome,
    commandProbe: fakeProbe(calls, ['pillow_jxl']),
    pmRunner: () => { throw new Error('không được gọi trên Hermes cũ'); },
    log: () => {},
  });
  assert.equal(result.pm, null);
  assert.ok(calls.some((c) => c[0] === python && c.join(' ').includes('pip install pillow-jxl-plugin')), 'vẫn cài tay pillow-jxl-plugin');
  assert.match(result.checks.find((c) => c.name === 'python-pillow-jxl').detail, /uv pip install --python <venv Hermes> pillow-jxl-plugin/);
});

test('cài trên Hermes mới: `hermes pm install` lỗi / quá giờ → [WARN] kèm lệnh chạy tay, cài đặt vẫn xong', async (t) => {
  const timeout = { status: null, error: Object.assign(new Error('spawnSync hermes ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
  for (const failure of [{ status: 1 }, timeout, 'throw']) {
    const fx = fixture(t);
    seedManaged(fx.hermesHome);
    const logs = [];
    const result = await installHermes({
      sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome,
      commandProbe: fakeProbe([], ['websockets', 'pillow_jxl', 'docx', 'pymupdf', 'yt_dlp']),
      pmRunner: () => { if (failure === 'throw') throw new Error('ENOENT'); return failure; },
      log: (s) => logs.push(s),
    });
    assert.equal(result.pm.ok, false);
    const warn = logs.find((l) => l.startsWith('[WARN] hermes-pm-install'));
    assert.ok(warn, JSON.stringify(logs));
    assert.match(warn, /pm install/);
    assert.ok(warn.includes(`HERMES_HOME="${fx.hermesHome}"`), warn);
    if (failure === timeout) assert.match(warn, /quá 20 phút/);
    // Plugin + config đã ghi; thiếu websockets chỉ được báo, không dừng bản cài.
    assert.ok(existsSync(join(pluginTargets(fx.hermesHome).platform, 'adapter.py')));
    const ws = result.checks.find((c) => c.name === 'python-websockets');
    assert.equal(ws.ok, false);
    assert.match(ws.detail, /pm install/);
  }
});

test('cài trên Hermes mới: pm install chạy được mà vẫn thiếu websockets → báo hỏng (không che lỗi thật)', async (t) => {
  const fx = fixture(t);
  seedManaged(fx.hermesHome);
  await assert.rejects(installHermes({
    sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, commandProbe: fakeProbe([], ['websockets']),
    pmRunner: () => ({ status: 0 }), log: () => {},
  }), /Cài đặt chưa hoàn chỉnh/);
});

test('cài với --skip-python: không đụng `hermes pm install` dù là Hermes mới', async (t) => {
  const fx = fixture(t);
  seedManaged(fx.hermesHome);
  const result = await installHermes({
    sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true,
    pmRunner: () => { throw new Error('không được gọi'); }, log: () => {},
  });
  assert.equal(result.pm, null);
});

test('doctor: gợi ý sửa thư viện theo loại Hermes — mới: `hermes pm install`, cũ: uv pip install vào venv', async (t) => {
  const fx = fixture(t);
  await installHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, skipPython: true });
  seedVenv(fx.hermesRepo);
  const missing = ['websockets', 'pillow_jxl', 'docx', 'pymupdf', 'yt_dlp'];
  const doctor = () => doctorHermes({ sidecarRoot: fx.sidecar, hermesHome: fx.hermesHome, noDashboard: true, commandProbe: fakeProbe([], missing) });
  const names = ['python-websockets', 'python-pillow-jxl', 'python-document-libs', 'python-pdf-libs', 'video-tools'];
  let d = doctor();
  for (const name of names) {
    const detail = d.checks.find((c) => c.name === name).detail;
    assert.match(detail, /uv pip install --python <venv Hermes>/, name);
    assert.doesNotMatch(detail, /pm install/, name);
  }
  seedManaged(fx.hermesHome);
  d = doctor();
  for (const name of names) {
    const detail = d.checks.find((c) => c.name === name).detail;
    assert.match(detail, /pm install/, name);
    assert.doesNotMatch(detail, /uv pip/, name);
  }
});
