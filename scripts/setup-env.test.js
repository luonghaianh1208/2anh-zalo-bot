import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadRepoEnv, loadHermesEnv } from './setup-env.js';

const PROJECT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));

function temporaryEnvFile(t, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'setup-env-'));
  const path = join(dir, '.env');
  writeFileSync(path, contents, 'utf8');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path;
}

function preserveEnv(t, key) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const previous = process.env[key];
  t.after(() => {
    if (had) process.env[key] = previous;
    else delete process.env[key];
  });
}

// --- loadRepoEnv (Hạng mục 3: trình cài đọc .env trước khi dò HERMES_HOME) ---

test('loadRepoEnv loads HERMES_HOME from the repository .env', (t) => {
  preserveEnv(t, 'HERMES_HOME');
  delete process.env.HERMES_HOME;
  const path = temporaryEnvFile(t, 'HERMES_HOME=D:\\custom-hermes\n');

  loadRepoEnv(path);

  assert.equal(process.env.HERMES_HOME, 'D:\\custom-hermes');
});

test('an exported HERMES_HOME wins over the repository .env', (t) => {
  preserveEnv(t, 'HERMES_HOME');
  process.env.HERMES_HOME = 'D:\\shell-hermes';
  const path = temporaryEnvFile(t, 'HERMES_HOME=D:\\file-hermes\n');

  loadRepoEnv(path);

  assert.equal(process.env.HERMES_HOME, 'D:\\shell-hermes');
});

test('a malformed repository .env fails with a clear line number', (t) => {
  const path = temporaryEnvFile(t, 'HERMES_HOME=D:\\hermes\nTHIS IS NOT AN ASSIGNMENT\n');

  assert.throws(() => loadRepoEnv(path), /\.env không hợp lệ.*dòng 2/i);
});

// --- Wiring: install-hermes.js / doctor.js / uninstall-hermes.js phải gọi loadRepoEnv ---

function cliFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'zalo-setup-env-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sidecar = join(root, 'sidecar');
  const home = join(root, 'home');
  const repo = join(home, 'hermes-agent');
  mkdirSync(sidecar, { recursive: true });
  writeFileSync(join(sidecar, 'server.js'), '// fixture\n');
  writeFileSync(join(sidecar, '.env.example'), 'ZALO_BRIDGE_PORT=3873\n');
  mkdirSync(join(repo, 'plugins', 'platforms'), { recursive: true });
  mkdirSync(join(repo, 'gateway'), { recursive: true });
  writeFileSync(join(repo, 'pyproject.toml'), '[project]\nname="hermes-agent"\n');
  writeFileSync(join(home, 'config.yaml'), 'customer: keep\n');
  return { root, sidecar, home, repo };
}

function runDoctorWithoutHermesHomeFlag(fx, extraEnv = {}) {
  return spawnSync(
    process.execPath,
    [join(PROJECT, 'scripts', 'doctor.js'), '--sidecar-root', fx.sidecar, '--skip-python'],
    { encoding: 'utf8', env: { ...process.env, ...extraEnv } },
  );
}

test('doctor.js resolves HERMES_HOME from the sidecar .env when --hermes-home is not passed', (t) => {
  const fx = cliFixture(t);
  writeFileSync(join(fx.sidecar, '.env'), `HERMES_HOME=${fx.home}\n`);

  const result = runDoctorWithoutHermesHomeFlag(fx, { HERMES_HOME: '' });

  assert.match(result.stdout, /\[PASS\] hermes-layout/);
});

test('doctor.js prefers the real shell HERMES_HOME over the sidecar .env value', (t) => {
  const fx = cliFixture(t);
  const wrongHome = join(fx.root, 'wrong-home');
  mkdirSync(wrongHome, { recursive: true });
  writeFileSync(join(fx.sidecar, '.env'), `HERMES_HOME=${wrongHome}\n`);

  const result = runDoctorWithoutHermesHomeFlag(fx, { HERMES_HOME: fx.home });

  assert.match(result.stdout, /\[PASS\] hermes-layout/);
  assert.match(result.stdout, new RegExp(fx.repo.replace(/\\/g, '\\\\')));
});

test('doctor.js reports a clear error for a malformed sidecar .env instead of ignoring it', (t) => {
  const fx = cliFixture(t);
  writeFileSync(join(fx.sidecar, '.env'), 'THIS IS NOT AN ASSIGNMENT\n');

  const result = runDoctorWithoutHermesHomeFlag(fx, { HERMES_HOME: '' });

  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /\.env không hợp lệ/);
});

// --- loadHermesEnv (Hạng mục 4: server.js phải đọc .env của Hermes) ---

test('loadHermesEnv loads variables from the Hermes .env pointed to by HERMES_HOME', (t) => {
  preserveEnv(t, 'HERMES_HOME');
  preserveEnv(t, 'ZALO_ALLOWED_USERS');
  const dir = mkdtempSync(join(tmpdir(), 'hermes-home-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, '.env'), 'ZALO_ALLOWED_USERS=123456789012345\n');
  delete process.env.ZALO_ALLOWED_USERS;

  const result = loadHermesEnv({ env: { HERMES_HOME: dir }, warn: () => {} });

  assert.equal(result.loaded, true);
  assert.equal(process.env.ZALO_ALLOWED_USERS, '123456789012345');
});

test('loadHermesEnv does not override a variable already set before it runs', (t) => {
  preserveEnv(t, 'HERMES_HOME');
  preserveEnv(t, 'ZALO_ALLOWED_USERS');
  const dir = mkdtempSync(join(tmpdir(), 'hermes-home-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, '.env'), 'ZALO_ALLOWED_USERS=from-hermes-env\n');
  process.env.ZALO_ALLOWED_USERS = 'already-set';

  loadHermesEnv({ env: { HERMES_HOME: dir }, warn: () => {} });

  assert.equal(process.env.ZALO_ALLOWED_USERS, 'already-set');
});

test('loadHermesEnv warns clearly and does not throw when HERMES_HOME is missing', (t) => {
  const warnings = [];

  const result = loadHermesEnv({ env: {}, warn: (message) => warnings.push(message) });

  assert.equal(result.loaded, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /HERMES_HOME/);
});

test('loadHermesEnv silently ignores a missing .env file when HERMES_HOME is set', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-home-empty-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const warnings = [];

  const result = loadHermesEnv({ env: { HERMES_HOME: dir }, warn: (message) => warnings.push(message) });

  assert.equal(result.loaded, false);
  assert.equal(warnings.length, 0);
});

test('loadHermesEnv throws on a genuinely broken Hermes .env instead of swallowing it', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-home-broken-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.env')); // a directory named .env makes the real read fail with EISDIR, not ENOENT

  assert.throws(() => loadHermesEnv({ env: { HERMES_HOME: dir }, warn: () => {} }));
});

// --- Kịch bản cụ thể từ báo cáo lỗi: ownerConfigured phải đúng khi ZALO_ALLOWED_USERS
//     chỉ nằm trong .env của Hermes, không nằm trong .env của sidecar ---

test('ownerConfigured logic reads true once ZALO_ALLOWED_USERS is loaded from the Hermes .env', (t) => {
  preserveEnv(t, 'HERMES_HOME');
  preserveEnv(t, 'ZALO_ALLOWED_USERS');
  delete process.env.ZALO_ALLOWED_USERS;
  const dir = mkdtempSync(join(tmpdir(), 'hermes-home-owner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, '.env'), 'ZALO_ALLOWED_USERS=987654321098765\n');

  const before = String(process.env.ZALO_ALLOWED_USERS || '').split(',').some((v) => v.trim());
  assert.equal(before, false);

  loadHermesEnv({ env: { HERMES_HOME: dir }, warn: () => {} });

  const after = String(process.env.ZALO_ALLOWED_USERS || '').split(',').some((v) => v.trim());
  assert.equal(after, true);
});
