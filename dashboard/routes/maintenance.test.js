import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loginAs, makeDeps, startApp } from '../test-helpers.js';

function fakes(deps) {
  const backupDir = join(deps.dir, '.hermes', 'backups'); // như VPS: /root/.hermes/… (thư mục bắt đầu bằng dấu chấm)
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, 'hermes-zalo-20261010-134504.zip'), 'PKzip');
  const calls = [];
  deps.maintenance = {
    backupDir,
    versions: async () => ({ bot: { version: '2.7.0' }, hermes: { version: 'v0.21' }, update: { running: false } }),
    checkHermes: async () => ({ status: 'current' }),
    updateHermes: async () => ({ running: true }),
    updateState: () => ({ running: false }),
    backups: () => [{ file: 'hermes-zalo-20261010-134504.zip' }],
    backupPath: (f) => { if (f !== 'hermes-zalo-20261010-134504.zip') throw Object.assign(new Error('Không còn'), { statusCode: 404 }); return join(backupDir, f); },
  };
  const ans = { 'snapshot.list': { snapshots: [{ id: 's1' }] }, 'backup.create': { file: 'b.zip', size: 1 }, 'backup.restore': { restored: 3, before: 'x.zip' }, 'snapshot.restore': { id: 's1' } };
  const run = (kind) => async (cmd, args) => { calls.push({ kind, cmd, args }); return { ok: true, ...ans[cmd] }; };
  deps.hermesAdmin = { read: run('read'), write: run('write') };
  return calls;
}

test('Bảo trì: chỉ Quản trị; tải bản sao lưu; khôi phục đánh dấu khởi động lại, ghi Nhật ký', async (t) => {
  const deps = makeDeps(t);
  const calls = fakes(deps);
  const { call, base } = await startApp(t, deps);
  const owner = await loginAs(t, deps, call, { username: 'khach', role: 'owner' });
  assert.equal((await call('/api/admin/maintenance', { cookie: owner })).status, 403);
  assert.equal((await call('/api/admin/backups/hermes-zalo-20261010-134504.zip', { cookie: owner })).status, 403);
  const admin = await loginAs(t, deps, call);
  const info = await call('/api/admin/maintenance', { cookie: admin });
  assert.deepEqual(info.json.snapshots, [{ id: 's1' }]);
  const dl = await fetch(`${base}/api/admin/backups/hermes-zalo-20261010-134504.zip`, { headers: { Cookie: admin } });
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), 'PKzip');
  assert.equal((await call('/api/admin/backups/khac.zip', { cookie: admin })).status, 404);
  await call('/api/admin/backups', { method: 'POST', cookie: admin });
  const r = await call('/api/admin/backups/hermes-zalo-20261010-134504.zip/restore', { method: 'POST', cookie: admin });
  assert.equal(r.json.restored, 3);
  await call('/api/admin/snapshots/s1/restore', { method: 'POST', cookie: admin });
  assert.deepEqual(deps.restartFlags.get().assistant.reasons, ['Khôi phục: hermes-zalo-20261010-134504.zip', 'Khôi phục: s1']);
  assert.equal(calls.find((c) => c.cmd === 'backup.restore').args.dir, deps.maintenance.backupDir);
  assert.deepEqual(deps.activity.list().map((e) => e.action).filter((a) => /backup|snapshot/.test(a)).sort(), ['backup_create', 'backup_download', 'backup_restore', 'snapshot_restore']);
  assert.equal((await call('/api/admin/maintenance/hermes-update', { method: 'POST', cookie: admin })).json.update.running, true);
});

test('Cập nhật bot: ai đăng nhập cũng thấy có bản mới; chỉ Quản trị bấm cập nhật', async (t) => {
  const deps = makeDeps(t);
  fakes(deps);
  let asked = '';
  Object.assign(deps.maintenance, {
    botNotice: async () => ({ current: '2.8.3', latest: 'v2.9.0', newer: true, updating: false }),
    botUpdateState: () => ({ running: false }),
    updateBot: async (to) => { asked = to; return { running: true, from: '2.8.3', to }; },
  });
  const { call } = await startApp(t, deps);
  assert.equal((await call('/api/update-notice')).status, 401);
  const owner = await loginAs(t, deps, call, { username: 'khach', role: 'owner' });
  assert.equal((await call('/api/update-notice', { cookie: owner })).json.latest, 'v2.9.0');
  assert.equal((await call('/api/admin/maintenance/bot-update', { method: 'POST', cookie: owner, body: { to: 'v2.9.0' } })).status, 403);
  const admin = await loginAs(t, deps, call);
  const r = await call('/api/admin/maintenance/bot-update', { method: 'POST', cookie: admin, body: { to: 'v2.9.0' } });
  assert.equal(r.json.botUpdate.running, true);
  assert.equal(asked, 'v2.9.0');
  assert.equal(deps.activity.list().find((e) => e.action === 'bot_update').detail, '2.8.3 → v2.9.0');
});
