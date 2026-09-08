import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const PROJECT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'zalo-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sidecar = join(root, 'sidecar');
  const home = join(root, 'home');
  const repo = join(home, 'hermes-agent');
  mkdirSync(sidecar, { recursive: true });
  cpSync(join(PROJECT, 'hermes-plugin'), join(sidecar, 'hermes-plugin'), { recursive: true });
  writeFileSync(join(sidecar, 'server.js'), '// fixture\n');
  writeFileSync(join(sidecar, '.env.example'), 'ZALO_BRIDGE_PORT=3873\n');
  mkdirSync(join(repo, 'plugins', 'platforms'), { recursive: true });
  mkdirSync(join(repo, 'gateway'), { recursive: true });
  writeFileSync(join(repo, 'pyproject.toml'), '[project]\nname="hermes-agent"\n');
  writeFileSync(join(home, 'config.yaml'), 'customer: keep\n');
  return { root, sidecar, home, repo };
}

function run(script, fx) {
  return spawnSync(process.execPath, [join(PROJECT, 'scripts', script), '--hermes-home', fx.home,
    '--sidecar-root', fx.sidecar, '--skip-python'], { encoding: 'utf8' });
}

test('doctor is read-only and fails before installation', (t) => {
  const fx = fixture(t);
  const before = readFileSync(join(fx.home, 'config.yaml'), 'utf8');
  const result = run('doctor.js', fx);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /zalo-platform.*FAIL/s);
  assert.equal(readFileSync(join(fx.home, 'config.yaml'), 'utf8'), before);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /ZALO_BRIDGE_TOKEN=/);
});

test('install, repeated install, doctor, and uninstall work end to end', (t) => {
  const fx = fixture(t);
  const first = run('install-hermes.js', fx);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  writeFileSync(join(fx.sidecar, '.env'), 'CUSTOM_SENTINEL=keep\nZALO_BRIDGE_TOKEN=fixed\n');
  const second = run('install-hermes.js', fx);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const envText = readFileSync(join(fx.sidecar, '.env'), 'utf8');
  assert.match(envText, /^CUSTOM_SENTINEL=keep$/m);
  assert.match(envText, /^ZALO_BRIDGE_TOKEN=fixed$/m);
  assert.match(envText, /^HERMES_HOME=.+$/m);
  assert.match(readFileSync(join(fx.home, 'config.yaml'), 'utf8'), /customer: keep/);
  const doctor = run('doctor.js', fx);
  assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
  const uninstall = run('uninstall-hermes.js', fx);
  assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
  assert.equal(existsSync(join(fx.repo, 'plugins', 'platforms', 'zalo')), false);
  assert.equal(existsSync(join(fx.repo, 'plugins', 'zalo_tools')), false);
  assert.equal(existsSync(join(fx.sidecar, '.env')), true);
  assert.equal(existsSync(join(fx.home, 'config.yaml')), true);
});
