import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeIds, createHermesEnvs, inUseIds, listEnvs, plan } from './hermes-envs.js';

const id = (n) => String(n).padStart(32, '0').replace(/^0/, 'a');

function home(nEnv, active) {
  const h = mkdtempSync(join(tmpdir(), 'hermes-envs-'));
  const envRoot = join(h, 'installs', 'bceb66d11c12ceaa', 'environments');
  for (let i = 1; i <= nEnv; i += 1) {
    const d = join(envRoot, id(i));
    mkdirSync(join(d, 'venv'), { recursive: true });
    writeFileSync(join(d, 'venv', 'x.py'), 'x');
    const t = new Date(2026, 9, i);                       // id(i) càng lớn càng mới
    utimesSync(d, t, t);
  }
  writeFileSync(join(h, 'installs', 'bceb66d11c12ceaa', 'facts.json'),
    JSON.stringify({ packages: { venv: { environment: `/root/.hermes/installs/bceb66d11c12ceaa/environments/${id(active)}/venv` } } }));
  mkdirSync(join(envRoot, 'khong-phai-ma'), { recursive: true });   // thư mục lạ: không đụng
  return h;
}

test('liệt kê môi trường mới nhất trước, bỏ thư mục không phải mã', () => {
  const h = home(5, 5);
  try {
    assert.deepEqual(listEnvs(h).map((e) => e.id), [5, 4, 3, 2, 1].map(id));
    assert.deepEqual([...activeIds(h)], [id(5)]);
    assert.deepEqual(listEnvs(join(h, 'khong-co')), []);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('kế hoạch: giữ bản đang dùng, bản có tiến trình và 3 bản mới nhất', () => {
  const envs = [9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => ({ id: id(n), dir: `/x/${n}`, at: n }));
  const p = plan(envs, new Set([id(2)]), new Set([id(5)]));
  assert.deepEqual(p.keep.map((k) => k.id).sort(), [id(9), id(8), id(7), id(5), id(2)].sort());
  assert.match(p.keep.find((k) => k.id === id(2)).why, /đang dùng/);
  assert.match(p.keep.find((k) => k.id === id(5)).why, /có tiến trình/);
  assert.deepEqual(p.remove.map((r) => r.id), [6, 4, 3, 1].map(id));
  assert.equal(plan(envs.slice(0, 3), new Set(), new Set()).remove.length, 0);   // ≤ 3 bản: không xoá gì
});

test('tiến trình đang nạp thư viện: đọc mã từ maps (Linux) và danh sách module (Windows)', async () => {
  const linux = await inUseIds({ platform: 'linux', readProc: () => `7f0 r-xp /root/.hermes/installs/a/environments/${id(4)}/venv/lib/x.so\n` });
  assert.deepEqual([...linux], [id(4)]);
  const win = await inUseIds({ platform: 'win32', listWinModules: async () => `E:\\Hermes\\installs\\b\\environments\\${id(6).toUpperCase()}\\venv\\x.pyd\r\n` });
  assert.deepEqual([...win], [id(6)]);
});

test('dọn: xoá đúng phần thừa, giữ thư mục lạ, ghi lần dọn gần nhất; không chạy hai lần cùng lúc', async () => {
  const h = home(7, 3);
  try {
    const envs = createHermesEnvs({ hermesHome: h, inUse: async () => new Set([id(1)]), now: () => 123 });
    const s = await envs.status();
    assert.equal(s.total, 7);
    assert.equal(s.removable, 2);                          // giữ 7,6,5 (mới nhất), 3 (đang dùng), 1 (có tiến trình)
    const r = await envs.clean('tu-dong');
    assert.deepEqual({ by: r.by, removed: r.removed, kept: r.kept, failed: r.failed, at: r.at }, { by: 'tu-dong', removed: 2, kept: 5, failed: [], at: 123 });
    assert.deepEqual(listEnvs(h).map((e) => e.id).sort(), [7, 6, 5, 3, 1].map(id).sort());
    assert.ok(existsSync(join(h, 'installs', 'bceb66d11c12ceaa', 'environments', 'khong-phai-ma')));
    assert.equal((await envs.status()).removable, 0);

    let tha;
    const cham = createHermesEnvs({ hermesHome: h, inUse: () => new Promise((r) => { tha = () => r(new Set()); }) });
    const dang = cham.clean();
    await assert.rejects(cham.clean(), /Đang dọn/);
    tha();
    await dang;
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('xoá lỗi một bản thì ghi lại và dọn tiếp bản khác', async () => {
  const h = home(6, 6);
  try {
    let lan = 0;
    const envs = createHermesEnvs({ hermesHome: h, inUse: async () => new Set(),
      rm: (dir) => { lan += 1; if (lan === 1) throw Object.assign(new Error('bận'), { code: 'EBUSY' }); rmSync(dir, { recursive: true, force: true }); } });
    const r = await envs.clean();
    assert.equal(r.removed, 2);
    assert.equal(r.failed.length, 1);
    assert.match(r.failed[0], /EBUSY/);
  } finally { rmSync(h, { recursive: true, force: true }); }
});
