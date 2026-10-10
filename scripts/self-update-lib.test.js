import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSelfUpdate } from './self-update-lib.js';

function setup(t, { git = true, healthy = () => ({ ok: true }), runHook = () => '', lockChangesOn = '' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'zalo-selfupdate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (git) mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'package-lock.json'), 'v1');
  const tmp = join(root, 'tmp'); mkdirSync(tmp);
  const calls = []; const logs = [];
  let clock = 0;
  const deps = {
    log: (s) => logs.push(s),
    run: async (cmd, args) => {
      const line = `${cmd.endsWith('node') || cmd.endsWith('node.exe') ? 'node' : cmd} ${args.join(' ')}`;
      calls.push(line);
      if (lockChangesOn && line.includes(lockChangesOn)) writeFileSync(join(root, 'package-lock.json'), `changed ${calls.length}`);
      const r = runHook(line);
      if (r instanceof Error) throw r;
      if (cmd === 'git' && args[0] === 'rev-parse') return 'abc123\n';
      return r || '';
    },
    download: async (url, dest) => { calls.push(`download ${url}`); writeFileSync(dest, 'tgz'); },
    backup: async () => 'hermes-zalo-x.zip',
    restartSidecar: async () => calls.push('restart sidecar'),
    restartAssistant: async () => calls.push('restart assistant'),
    restartDashboard: async () => calls.push('restart dashboard'),
    healthy: async () => healthy(calls),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  };
  const stateFile = join(root, 'state.json');
  const go = (to = 'v2.9.0') => runSelfUpdate({ root, hermesHome: '/h', to, from: '2.8.3', stateFile, tmpDir: tmp, deps });
  return { root, calls, logs, go, state: () => JSON.parse(readFileSync(stateFile, 'utf8')) };
}

test('bản cài git: sao lưu → checkout tag → cài bằng bộ cài mã mới → khởi động lại 3 phần → khoẻ', async (t) => {
  const { calls, go, state } = setup(t);
  const st = await go();
  assert.equal(st.status, 'done');
  const seq = calls.filter((c) => !c.startsWith('git status')).map((c) => (c.includes('install-hermes.js') ? c.replace(/^node \S+install-hermes\.js/, 'install').replace(/--sidecar-root \S+/, '--sidecar-root ROOT') : c));
  assert.deepEqual(seq, [
    'git rev-parse HEAD', 'git fetch -q --tags origin', 'git checkout -q v2.9.0',
    'install --hermes-home /h --sidecar-root ROOT --no-dashboard',
    'restart sidecar', 'restart assistant', 'restart dashboard',
  ]);
  assert.ok(!calls.some((c) => c.startsWith('npm')), 'thư viện không đổi → không npm ci');
  assert.equal(state().status, 'done');
});

test('package-lock đổi thì chạy npm ci', async (t) => {
  const { calls, go } = setup(t, { lockChangesOn: 'git checkout -q v2.9.0' });
  assert.equal((await go()).status, 'done');
  assert.ok(calls.some((c) => c.startsWith('npm ci --omit=dev')));
});

test('không khoẻ sau khi cập nhật → quay về commit cũ, cài lại, khởi động lại', async (t) => {
  const { calls, go } = setup(t, { healthy: (c) => (c.includes('git checkout -q abc123') ? { ok: true } : { ok: false, detail: 'trợ lý chưa nối' }) });
  const st = await go();
  assert.equal(st.status, 'rolled-back');
  assert.match(st.error, /chưa chạy lại bình thường/);
  const back = calls.indexOf('git checkout -q abc123');
  assert.ok(back > calls.indexOf('git checkout -q v2.9.0'));
  assert.ok(calls.slice(back).some((c) => c.includes('install-hermes.js')));
  assert.equal(calls.slice(back).filter((c) => c.startsWith('restart')).length, 3);
});

test('mã nguồn có sửa đổi chưa commit → dừng trước khi đụng gì', async (t) => {
  const { calls, go } = setup(t, { runHook: (l) => (l.startsWith('git status') ? ' M server.js\n' : '') });
  const st = await go();
  assert.equal(st.status, 'failed');
  assert.match(st.error, /chưa commit/);
  assert.ok(!calls.some((c) => c.includes('checkout') || c.startsWith('restart')));
});

test('bản cài không git: nén mã cũ, tải gói phát hành, giải nén đè; lỗi cài → giải nén lại mã cũ', async (t) => {
  const { calls, go } = setup(t, { git: false, runHook: (l) => (l.includes('install-hermes.js') && !globalThis.__once ? (globalThis.__once = true, new Error('install lỗi')) : '') });
  t.after(() => { delete globalThis.__once; });
  const st = await go();
  assert.equal(st.status, 'rolled-back');
  assert.ok(calls.some((c) => /^tar -czf .*code-before-update\.tar\.gz --exclude=\.\/node_modules --exclude=\.\/data --exclude=\.\/\.env/.test(c)));
  assert.ok(calls.includes('download https://codeload.github.com/luonghaianh1208/2anh-zalo-bot/tar.gz/refs/tags/v2.9.0'));
  assert.ok(calls.some((c) => /^tar -xzf .*2anh-zalo-bot-v2\.9\.0\.tar\.gz .*--strip-components=1/.test(c)));
  assert.ok(calls.some((c) => /^tar -xzf .*code-before-update\.tar\.gz -C /.test(c)), 'quay về mã cũ');
});

test('phiên bản lạ bị từ chối', async (t) => {
  const { go } = setup(t);
  await assert.rejects(go('v2.9.0; rm -rf /'), /không hợp lệ/);
  await assert.rejects(go('main'), /không hợp lệ/);
});
