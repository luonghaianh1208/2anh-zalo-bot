import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveHermesLayout,
  mergeHermesConfig,
  renderPlatformManifest,
  installHermes,
  doctorHermes,
  uninstallHermes,
} from './hermes-install-lib.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'zalo-installer-'));
  t.after(() => import('node:fs').then(({ rmSync }) => rmSync(root, { recursive: true, force: true })));
  const sidecar = join(root, '2anh-zalo-bot');
  const hermesHome = join(root, 'hermes-home');
  const hermesRepo = join(hermesHome, 'hermes-agent');
  mkdirSync(join(sidecar, 'hermes-plugin', 'zalo'), { recursive: true });
  mkdirSync(join(sidecar, 'hermes-plugin', 'zalo_tools'), { recursive: true });
  writeFileSync(join(sidecar, 'server.js'), '// fixture\n');
  writeFileSync(join(sidecar, '.env.example'), 'ZALO_BRIDGE_PORT=3873\n');
  writeFileSync(join(sidecar, 'hermes-plugin', 'zalo', 'plugin.yaml'), 'name: zalo-platform\nstart_command: node "{{SIDECAR_SERVER}}"\n');
  writeFileSync(join(sidecar, 'hermes-plugin', 'zalo', 'adapter.py'), '# adapter\n');
  writeFileSync(join(sidecar, 'hermes-plugin', 'zalo_tools', 'plugin.yaml'), 'name: zalo-tools\n');
  writeFileSync(join(sidecar, 'hermes-plugin', 'zalo_tools', 'tools.py'), '# tools\n');
  mkdirSync(join(hermesRepo, 'plugins', 'platforms'), { recursive: true });
  mkdirSync(join(hermesRepo, 'gateway'), { recursive: true });
  writeFileSync(join(hermesRepo, 'pyproject.toml'), '[project]\nname="hermes-agent"\n');
  writeFileSync(join(hermesHome, 'config.yaml'), 'model:\n  provider: custom\ncustom_value: keep-me\nplatforms:\n  zalo:\n    extra:\n      reply_only_tagged: false\n');
  return { root, sidecar, hermesHome, hermesRepo };
}

test('resolveHermesLayout accepts a Hermes home and rejects an unrelated directory', (t) => {
  const fx = fixture(t);
  const layout = resolveHermesLayout({ hermesHome: fx.hermesHome });
  assert.equal(layout.home, fx.hermesHome);
  assert.equal(layout.repoRoot, fx.hermesRepo);
  assert.equal(layout.configPath, join(fx.hermesHome, 'config.yaml'));
  assert.throws(() => resolveHermesLayout({ hermesHome: fx.sidecar }), /Hermes Agent/);
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
  assert.deepEqual(config.known_plugin_toolsets.zalo, ['customer_tool', 'zalo_owner', 'zalo_public']);
  assert.equal(config.display.platforms.zalo.tool_progress, 'off');
  assert.deepEqual(config.plugins.enabled, ['platforms/zalo', 'zalo-tools']);
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
