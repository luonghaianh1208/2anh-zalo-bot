import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBroadcastManager, DEFAULT_PACE, MAX_FAIL_STREAK, SEND_TIMEOUT_MS, nextOpenAt, normalizePace, readBroadcasts, renderText, vnDay, writeBroadcasts } from './zalo-broadcast.js';

const NOON_VN = Date.UTC(2026, 10, 2, 5, 0, 0); // 12:00 giờ Việt Nam
const FAST = { minDelayS: 15, maxDelayS: 15, batchSize: 100, batchRestMin: 1, dailyCap: 300, fromHour: 0, toHour: 24 };
const targets = (n) => Array.from({ length: n }, (_, i) => ({ id: String(1000 + i), type: 0, name: `Khách ${i}` }));

function rig({ ready = () => true, sendText, sendFile, data, clock = NOON_VN, random = () => 0, acquire = async () => {} } = {}) {
  const box = { saved: data || { jobs: [], sentByDay: {}, lastSentAt: 0 }, sent: [], files: [], dropped: [], hangs: [], clock, saveFails: false };
  box.m = createBroadcastManager({
    load: () => box.saved, ready, acquire,
    save: (d) => { if (box.saveFails) throw new Error('ENOSPC'); box.saved = JSON.parse(JSON.stringify(d)); },
    sendText: sendText || (async (m) => { box.sent.push(m); }),
    sendFile: sendFile || (async (m) => { box.files.push(m); }),
    dropFile: (p) => box.dropped.push(p),
    now: () => box.clock, random, sleep: async () => {},
    setTimer: (fn, ms) => { if (ms >= SEND_TIMEOUT_MS) box.hangs.push(fn); return null; }, clearTimer: () => {},
  });
  // Chạy tay từng nhịp với đồng hồ giả: không cần chờ thật.
  box.run = async (times = 1, stepMs = 15_000) => { for (let i = 0; i < times; i++) { await box.m.tick(); box.clock += stepMs; } };
  return box;
}

const job = (b) => b.m.list().jobs[0];

test('renderText thay {ten}/{tên}, chưa biết tên thì "bạn"', () => {
  assert.equal(renderText('Chào {ten}, {TÊN} ơi', 'Lan'), 'Chào Lan, Lan ơi');
  assert.equal(renderText('Chào { tên }!', ''), 'Chào bạn!');
  assert.equal(renderText('Không có gì', 'Lan'), 'Không có gì');
  assert.equal(renderText('{ten}', '$& $1'), '$& $1');
});

test('nhịp vượt khoảng cho phép bị từ chối, sàn 15 giây không lách được', () => {
  assert.throws(() => normalizePace({ minDelayS: 5 }), (e) => e.validation);
  assert.throws(() => normalizePace({ minDelayS: 60, maxDelayS: 30 }), /tối đa/);
  assert.throws(() => normalizePace({ dailyCap: 301 }), (e) => e.validation);
  assert.throws(() => normalizePace({ fromHour: 21, toHour: 8 }), /kết thúc/);
  assert.throws(() => normalizePace({ batchSize: 1.5 }), (e) => e.validation);
  assert.deepEqual(normalizePace({}), DEFAULT_PACE);
});

test('nextOpenAt theo giờ Việt Nam: trước giờ mở, trong giờ, sau giờ đóng', () => {
  const pace = { fromHour: 8, toHour: 21 };
  assert.equal(nextOpenAt(NOON_VN, pace), NOON_VN);
  assert.equal(nextOpenAt(Date.UTC(2026, 10, 2, 0, 0), pace), Date.UTC(2026, 10, 2, 1, 0)); // 07:00 → 08:00
  assert.equal(nextOpenAt(Date.UTC(2026, 10, 2, 14, 0), pace), Date.UTC(2026, 11 - 1, 3, 1, 0)); // 21:00 → 08:00 hôm sau
  assert.equal(vnDay(Date.UTC(2026, 10, 2, 17, 30)), '2026-11-03');
});

test('gửi lần lượt, cá nhân hoá tên, xong thì done và có ghi actor', async () => {
  const b = rig();
  b.m.create({ text: 'Chào {ten}', targets: targets(2), pace: FAST, actor: 'anh' });
  await b.run(3);
  assert.deepEqual(b.sent.map((m) => m.text), ['Chào Khách 0', 'Chào Khách 1']);
  assert.equal(b.sent[0].actor, 'anh');
  assert.equal(job(b).status, 'done');
  assert.equal(job(b).counts.sent, 2);
});

test('giữ đúng giãn cách: chưa đủ giây thì chưa gửi', async () => {
  const b = rig();
  b.m.create({ text: 'x', targets: targets(2), pace: FAST, actor: 'a' });
  await b.m.tick();
  b.clock += 14_000;
  await b.m.tick();
  assert.equal(b.sent.length, 1);
  assert.equal(job(b).wait.reason, 'delay');
  b.clock += 1000;
  await b.m.tick();
  assert.equal(b.sent.length, 2);
});

test('giãn cách ngẫu nhiên nằm trong khoảng đã chọn', async () => {
  const b = rig({ random: () => 1 });
  b.m.create({ text: 'x', targets: targets(2), pace: { ...FAST, maxDelayS: 60 }, actor: 'a' });
  await b.m.tick();
  b.clock += 59_000;
  await b.m.tick();
  assert.equal(b.sent.length, 1);
  b.clock += 1000;
  await b.m.tick();
  assert.equal(b.sent.length, 2);
});

test('đủ một tốp thì nghỉ thêm batchRestMin phút', async () => {
  const b = rig();
  b.m.create({ text: 'x', targets: targets(3), pace: { ...FAST, batchSize: 2, batchRestMin: 10 }, actor: 'a' });
  await b.run(2);
  assert.equal(b.sent.length, 2);
  await b.m.tick();
  assert.equal(job(b).wait.reason, 'batch');
  b.clock += 10 * 60_000 - 1000;
  await b.m.tick();
  assert.equal(b.sent.length, 2);
  b.clock += 16_000;
  await b.m.tick();
  assert.equal(b.sent.length, 3);
});

test('trần ngày dùng chung các đợt: chạm trần thì chờ sang ngày mai rồi gửi tiếp', async () => {
  const b = rig();
  b.m.create({ text: 'a', targets: targets(2), pace: { ...FAST, dailyCap: 2 }, actor: 'a' });
  await b.run(3);
  assert.equal(b.sent.length, 2);
  b.m.create({ text: 'b', targets: targets(1), pace: { ...FAST, dailyCap: 2 }, actor: 'a' });
  await b.m.tick();
  assert.equal(b.sent.length, 2);
  assert.equal(job(b).wait.reason, 'daily');
  assert.equal(b.m.list().sentToday, 2);
  b.clock = NOON_VN + 24 * 3600_000;
  await b.m.tick();
  assert.equal(b.sent.length, 3);
});

test('ngoài khung giờ thì chờ, không gửi đêm', async () => {
  const b = rig({ clock: Date.UTC(2026, 10, 2, 15, 0) }); // 22:00 giờ Việt Nam
  b.m.create({ text: 'x', targets: targets(1), pace: { ...FAST, fromHour: 8, toHour: 21 }, actor: 'a' });
  await b.m.tick();
  assert.equal(b.sent.length, 0);
  assert.equal(job(b).wait.reason, 'hours');
  assert.equal(job(b).wait.until, Date.UTC(2026, 10, 3, 1, 0));
});

test('Zalo chưa sẵn sàng thì chờ, không tính lỗi, sẵn sàng lại thì gửi', async () => {
  let up = false;
  const b = rig({ ready: () => up });
  b.m.create({ text: 'x', targets: targets(1), pace: FAST, actor: 'a' });
  await b.m.tick();
  assert.equal(b.sent.length, 0);
  assert.equal(job(b).wait.reason, 'zalo');
  assert.equal(job(b).counts.failed, 0);
  up = true;
  await b.m.tick();
  assert.equal(b.sent.length, 1);
});

test('mất phiên ngay lúc gửi (not_ready) thì trả về hàng chờ, không tính trần ngày', async () => {
  let fail = true;
  const sent = [];
  const b = rig({ sendText: async (m) => {
    if (fail) { fail = false; throw Object.assign(new Error('Zalo chưa đăng nhập'), { code: 'not_ready' }); }
    sent.push(m);
  } });
  b.m.create({ text: 'x', targets: targets(1), pace: FAST, actor: 'a' });
  await b.m.tick();
  assert.equal(job(b).counts.pending, 1);
  assert.equal(b.m.list().sentToday, 0);
  await b.m.tick();
  assert.equal(sent.length, 0); // không lặp nhanh, chờ một nhịp rồi thử lại
  b.clock += 60_000;
  await b.m.tick();
  assert.equal(sent.length, 1);
});

test('một nơi lỗi thì ghi lại rồi đi tiếp', async () => {
  const sent = [];
  const b = rig({ sendText: async (m) => { if (m.threadId === '1000') throw new Error('bị chặn tin'); sent.push(m); } });
  b.m.create({ text: 'x', targets: targets(2), pace: FAST, actor: 'a' });
  await b.run(3);
  assert.equal(sent.length, 1);
  assert.equal(job(b).status, 'done');
  assert.deepEqual(job(b).issues, [{ name: 'Khách 0', type: 0, status: 'failed', error: 'bị chặn tin' }]);
});

test('lỗi liên tiếp thì tự tạm dừng, chủ bot tiếp tục được', async () => {
  let attempts = 0;
  const b = rig({ sendText: async () => { attempts += 1; throw new Error('Zalo từ chối'); } });
  b.m.create({ text: 'x', targets: targets(8), pace: FAST, actor: 'a' });
  await b.run(10);
  assert.equal(attempts, MAX_FAIL_STREAK);
  assert.equal(job(b).status, 'paused');
  assert.match(job(b).note, /liên tiếp/);
  b.m.resume(job(b).id);
  await b.run(1);
  assert.equal(attempts, MAX_FAIL_STREAK + 1);
  assert.equal(job(b).status, 'running');
});

test('khởi động lại giữa lúc gửi: nơi đang gửi thành "chưa rõ", không gửi lại; các nơi còn lại chạy tiếp', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bc-'));
  const path = join(dir, 'b.json');
  try {
    const first = rig({ sendText: async () => new Promise(() => {}) });
    first.m.create({ text: 'x', targets: targets(2), pace: FAST, actor: 'a' });
    first.m.tick();
    await new Promise((r) => setImmediate(r));
    writeBroadcasts(path, first.saved);
    const b = rig({ data: readBroadcasts(path), clock: NOON_VN + 60_000 });
    b.m.start();
    b.m.stop();
    assert.equal(job(b).counts.unknown, 1);
    b.clock += 15_000;
    await b.m.tick();
    assert.deepEqual(b.sent.map((m) => m.threadId), ['1001']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tạm dừng thì không gửi nữa; đợt thứ hai không gửi cùng lúc mà xếp sau', async () => {
  const b = rig();
  const one = b.m.create({ text: 'một', targets: targets(2), pace: FAST, actor: 'a' });
  const two = b.m.create({ text: 'hai', targets: [{ id: '9', type: 1, name: 'Nhóm' }], pace: FAST, actor: 'a' });
  assert.equal(b.m.list().jobs.find((j) => j.id === two.id).queued, true);
  await b.run(1);
  b.m.pause(one.id);
  await b.run(2);
  assert.deepEqual(b.sent.map((m) => m.text), ['một', 'hai']);
  assert.equal(b.sent[1].threadType, 1);
  assert.throws(() => b.m.pause(two.id), (e) => e.validation);
});

test('giữa hai đợt liên tiếp vẫn giữ giãn cách tối thiểu', async () => {
  const b = rig();
  b.m.create({ text: 'một', targets: targets(1), pace: FAST, actor: 'a' });
  await b.m.tick();
  b.m.create({ text: 'hai', targets: targets(1), pace: FAST, actor: 'a' });
  await b.m.tick();
  await b.m.tick();
  assert.equal(b.sent.length, 1);
  b.clock += 15_000;
  await b.m.tick();
  assert.equal(b.sent.length, 2);
});

test('gửi kèm tệp: chữ trước tệp sau; xong đợt mới xoá tệp', async () => {
  const b = rig();
  b.m.create({ text: 'Tài liệu', file: { path: '/o/broadcast/a/x.pdf', name: 'x.pdf' }, targets: targets(2), pace: FAST, actor: 'a' });
  await b.run(1);
  assert.equal(b.files.length, 1);
  assert.equal(b.dropped.length, 0);
  await b.run(1);
  await b.run(1);
  assert.deepEqual(b.dropped, ['/o/broadcast/a/x.pdf']);
  assert.equal(job(b).fileName, 'x.pdf');
});

test('chỉ có tệp, không có chữ: không gửi tin rỗng', async () => {
  const b = rig();
  b.m.create({ file: { path: '/o/broadcast/a/x.pdf', name: 'x.pdf' }, targets: targets(1), pace: FAST, actor: 'a' });
  await b.run(1);
  assert.equal(b.sent.length, 0);
  assert.equal(b.files.length, 1);
});

test('huỷ đợt thì dừng và xoá tệp, các nơi chưa gửi không được gửi', async () => {
  const b = rig();
  const j = b.m.create({ text: 'x', file: { path: '/o/broadcast/a/x.pdf', name: 'x.pdf' }, targets: targets(3), pace: FAST, actor: 'a' });
  await b.run(1);
  b.m.cancel(j.id);
  await b.run(2);
  assert.equal(b.sent.length, 1);
  assert.equal(job(b).status, 'cancelled');
  assert.equal(job(b).counts.pending, 2);
  assert.deepEqual(b.dropped, ['/o/broadcast/a/x.pdf']);
  assert.throws(() => b.m.cancel(j.id), (e) => e.validation);
});

test('huỷ giữa lúc đang gửi: gửi xong nơi đó rồi dừng, tệp xoá sau khi gửi xong', async () => {
  let release;
  const b = rig({ sendText: () => new Promise((r) => { release = r; }) });
  const j = b.m.create({ text: 'x', file: { path: '/o/broadcast/a/x.pdf', name: 'x.pdf' }, targets: targets(2), pace: FAST, actor: 'a' });
  const running = b.m.tick();
  await new Promise((r) => setImmediate(r));
  b.m.cancel(j.id);
  assert.equal(b.dropped.length, 0);
  release();
  await running;
  assert.deepEqual(b.dropped, ['/o/broadcast/a/x.pdf']);
  assert.equal(job(b).status, 'cancelled');
});

test('bỏ trùng người nhận, từ chối đầu vào sai và đợt trùng đang chạy', () => {
  const b = rig();
  const one = b.m.create({ text: 'x', targets: [{ id: '1', type: 0 }, { id: '1', type: 0 }, { id: '1', type: 1 }], pace: FAST, actor: 'a' });
  assert.equal(one.counts.total, 2);
  assert.throws(() => b.m.create({ text: 'x', targets: [{ id: '1', type: 0 }, { id: '1', type: 1 }], pace: FAST, actor: 'a' }), /đúng nội dung/);
  assert.throws(() => b.m.create({ text: '', targets: targets(1) }), /nội dung/);
  assert.throws(() => b.m.create({ text: 'x', targets: [] }), /nơi nhận/);
  assert.throws(() => b.m.create({ text: 'x', targets: [{ id: 'abc', type: 0 }] }), /không hợp lệ/);
  assert.throws(() => b.m.create({ text: 'x', targets: [{ id: '1', type: 2 }] }), /không hợp lệ/);
  assert.throws(() => b.m.create({ text: 'y', targets: targets(501) }), /Tối đa/);
  assert.throws(() => b.m.create({ text: 'y'.repeat(2001), targets: targets(1) }), /2000/);
});

test('tệp hỏng được cất sang bên cạnh, không ghi đè mất', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bc-'));
  try {
    const path = join(dir, 'b.json');
    writeFileSync(path, '{hỏng');
    assert.deepEqual(readBroadcasts(path).jobs, []);
    assert.ok(readdirSync(dir).some((f) => f.includes('.corrupt-')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const FILE = { path: '/o/broadcast/a/x.pdf', name: 'x.pdf' };

test('phiên rớt giữa chữ và tệp: không gửi lại chữ, chỉ gửi tiếp tệp, trần ngày tính một lần', async () => {
  let drop = true;
  const b = rig({ sendFile: async (m) => {
    if (drop) { drop = false; throw Object.assign(new Error('Zalo chưa đăng nhập'), { code: 'not_ready' }); }
    b.files.push(m);
  } });
  b.m.create({ text: 'Tài liệu', file: FILE, targets: targets(1), pace: FAST, actor: 'a' });
  await b.m.tick();
  assert.equal(b.sent.length, 1);
  assert.equal(job(b).counts.pending, 1);
  b.clock += 60_000;
  await b.m.tick();
  assert.equal(b.sent.length, 1);
  assert.equal(b.files.length, 1);
  assert.equal(job(b).counts.sent, 1);
  assert.equal(b.m.list().sentToday, 1);
});

test('huỷ giữa chữ và tệp: nơi đó ghi rõ đã nhận chữ, không tính là chưa gửi', async () => {
  let release;
  let b;
  let calls = 0;
  b = rig({ acquire: () => { calls += 1; return calls === 2 ? new Promise((r) => { release = r; }) : Promise.resolve(); } });
  const j = b.m.create({ text: 'x', file: FILE, targets: targets(2), pace: FAST, actor: 'a' });
  const run = b.m.tick();
  await new Promise((r) => setImmediate(r));
  b.m.cancel(j.id);
  release();
  await run;
  assert.equal(b.files.length, 0);
  assert.deepEqual(job(b).issues.map((i) => i.error), ['Đã gửi chữ, chưa gửi tệp']);
  assert.equal(job(b).counts.pending, 1);
});

test('Zalo đá phiên trong lúc chờ lượt gửi: không gọi Zalo, nơi đó vẫn chờ chứ không thành lỗi', async () => {
  let up = true;
  let release;
  const b = rig({ ready: () => up, acquire: () => new Promise((r) => { release = r; }) });
  b.m.create({ text: 'x', targets: targets(1), pace: FAST, actor: 'a' });
  const run = b.m.tick();
  await new Promise((r) => setImmediate(r));
  up = false;
  release();
  await run;
  assert.equal(b.sent.length, 0);
  assert.equal(job(b).counts.pending, 1);
  assert.equal(job(b).counts.failed, 0);
});

test('huỷ trong lúc chờ lượt gửi: tin không được đi nữa', async () => {
  let release;
  const b = rig({ acquire: () => new Promise((r) => { release = r; }) });
  const j = b.m.create({ text: 'x', targets: targets(1), pace: FAST, actor: 'a' });
  const run = b.m.tick();
  await new Promise((r) => setImmediate(r));
  b.m.cancel(j.id);
  release();
  await run;
  assert.equal(b.sent.length, 0);
});

test('Zalo treo khi gửi tệp: hết hạn thì ghi "chưa rõ", không gửi lại, các nơi sau chạy tiếp', async () => {
  let n = 0;
  const b = rig({ sendFile: (m) => { n += 1; if (n === 1) return new Promise(() => {}); b.files.push(m); return Promise.resolve(); } });
  b.m.create({ file: FILE, targets: targets(2), pace: FAST, actor: 'a' });
  const run = b.m.tick();
  await new Promise((r) => setImmediate(r));
  b.hangs[0]();
  await run;
  assert.equal(job(b).counts.unknown, 1);
  assert.match(job(b).issues[0].error, /không phản hồi/);
  b.clock += 15_000;
  await b.m.tick();
  assert.deepEqual(b.files.map((m) => m.threadId), ['1001']);
});

test('lỗi liên tiếp thì dừng cả các đợt đang xếp hàng, không gửi tiếp vào lúc Zalo từ chối', async () => {
  let attempts = 0;
  const b = rig({ sendText: async () => { attempts += 1; throw new Error('Zalo từ chối'); } });
  b.m.create({ text: 'một', targets: targets(8), pace: FAST, actor: 'a' });
  b.m.create({ text: 'hai', targets: targets(8), pace: FAST, actor: 'a' });
  await b.run(12);
  assert.equal(attempts, MAX_FAIL_STREAK);
  assert.deepEqual(b.m.list().jobs.map((j) => j.status), ['paused', 'paused']);
});

test('nghỉ theo tốp tính chung các đợt nối tiếp nhau', async () => {
  const b = rig();
  const pace = { ...FAST, batchSize: 2, batchRestMin: 10 };
  b.m.create({ text: 'một', targets: targets(2), pace, actor: 'a' });
  b.m.create({ text: 'hai', targets: targets(1), pace, actor: 'a' });
  await b.run(4);
  assert.equal(b.sent.length, 2);
  assert.equal(job(b).wait.reason, 'batch');
});

test('khởi động lại giữa lúc gửi: tin dở vẫn tính vào trần ngày và giãn cách', async () => {
  const first = rig({ sendText: async () => new Promise(() => {}) });
  first.m.create({ text: 'x', targets: targets(2), pace: FAST, actor: 'a' });
  first.m.tick();
  await new Promise((r) => setImmediate(r));
  const b = rig({ data: first.saved, clock: NOON_VN + 3600_000 });
  b.m.start();
  b.m.stop();
  assert.equal(b.m.list().sentToday, 1);
  await b.m.tick();
  assert.equal(b.sent.length, 0);
  b.clock += 15_000;
  await b.m.tick();
  assert.equal(b.sent.length, 1);
});

test('không ghi được trạng thái (đầy đĩa): tự tạm dừng, không gửi, nơi đó vẫn còn trong hàng chờ', async () => {
  const b = rig();
  b.m.create({ text: 'x', targets: targets(2), pace: FAST, actor: 'a' });
  b.saveFails = true;
  await b.m.tick().catch(() => {});
  b.saveFails = false;
  assert.equal(b.sent.length, 0);
  assert.equal(job(b).status, 'paused');
  assert.equal(job(b).counts.pending, 2);
  assert.match(job(b).note, /ghi được/);
});

test('tạo đợt mà không ghi được thì không để lại đợt ma', () => {
  const b = rig();
  b.saveFails = true;
  assert.throws(() => b.m.create({ text: 'x', targets: targets(1), pace: FAST, actor: 'a' }), /ENOSPC/);
  assert.equal(b.m.list().jobs.length, 0);
});

test('cùng nội dung tới một phần người của đợt đang chạy thì từ chối; khác tệp thì được', () => {
  const b = rig();
  b.m.create({ text: 'x', targets: targets(2), pace: FAST, actor: 'a' });
  assert.throws(() => b.m.create({ text: 'x', targets: targets(3), pace: FAST, actor: 'a' }), /đúng nội dung/);
  b.m.create({ file: { path: '/o/broadcast/a/a.pdf', name: 'a.pdf' }, targets: targets(1), pace: FAST, actor: 'a' });
  b.m.create({ file: { path: '/o/broadcast/b/b.pdf', name: 'b.pdf' }, targets: targets(1), pace: FAST, actor: 'a' });
  assert.equal(b.m.list().jobs.length, 3);
});
