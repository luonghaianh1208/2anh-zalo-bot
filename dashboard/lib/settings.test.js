import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { SETTINGS, createSettings, validateSetting } from './settings.js';
import { readEnvKey, writeEnvKey } from './env-file.js';

const ENV = 'OPENAI_API_KEY=sk-bimat\nZALO_FLOOD_THRESHOLD=8\nZALO_FRIEND_TOOLS=true\n';
const CONFIG = 'platforms:\n  zalo:\n    extra:\n      reply_only_tagged: false\n      owner_only_groups:\n      - "111"\n      bridge_token: bi-mat\n';

function setup(t, { env = ENV, config = CONFIG, inherited = {} } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'zd-set-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  writeFileSync(join(d, '.env'), env);
  writeFileSync(join(d, 'config.yaml'), config);
  return { d, s: createSettings({ envFile: join(d, '.env'), configFile: join(d, 'config.yaml'), inherited }) };
}
const pick = (view, id) => view.find((x) => x.id === id);

test('danh sách cố định: không khoá bí mật nào; mỗi mục có kiểu, nhóm, đích khởi động lại', () => {
  assert.equal(SETTINGS.length, 17);
  assert.deepEqual(SETTINGS.filter((s) => s.restart.length).map((s) => s.id), ['friendTools', 'historyDays', 'auditDays'], 'còn lại áp dụng ngay');
  for (const s of SETTINGS) {
    assert.doesNotMatch(s.env, /KEY|TOKEN|SECRET|PASSWORD/, s.env);
    assert.ok(['bool', 'int', 'enum', 'ids', 'names', 'patterns'].includes(s.type), s.id);
    assert.ok(Array.isArray(s.restart) && s.group && s.label, s.id);
  }
});

test('đọc đúng thứ tự ưu tiên của adapter: config.yaml thắng .env với khoá extraWins; .env thắng với cờ tag; mặc định', (t) => {
  const { s } = setup(t, { env: `${ENV}ZALO_GROUP_REPLY_ONLY_TAGGED=true\nZALO_OWNER_ONLY_GROUPS=999\n` });
  const v = s.view();
  assert.deepEqual([pick(v, 'replyOnlyTagged').value, pick(v, 'replyOnlyTagged').source], [true, 'env'], 'env khác rỗng đè extra.reply_only_tagged');
  assert.deepEqual([pick(v, 'ownerOnlyGroups').value, pick(v, 'ownerOnlyGroups').source], [['111'], 'config'], 'extra thắng .env');
  assert.deepEqual([pick(v, 'floodThreshold').value, pick(v, 'floodWindow').value, pick(v, 'floodWindow').source], [8, 15, 'default']);
  assert.equal(pick(v, 'friendTools').value, true);
  assert.doesNotMatch(JSON.stringify(v), /sk-bimat|bi-mat/);
});

test('lưu: ghi vào đúng nơi đang có hiệu lực, giữ dòng khác; không đổi thì không ghi; trả danh sách đổi + đích khởi động lại', (t) => {
  const { d, s } = setup(t);
  const changes = s.save({ floodThreshold: 10, ownerOnlyGroups: ['111', '333'], friendTools: true, kbPublicDirs: ['Năm 2026', 'Văn bản'] });
  assert.deepEqual(changes.map((c) => [c.id, c.restart]), [['floodThreshold', []], ['ownerOnlyGroups', []], ['kbPublicDirs', []]]);
  const env = readFileSync(join(d, '.env'), 'utf8');
  assert.match(env, /^OPENAI_API_KEY=sk-bimat$/m);
  assert.match(env, /^ZALO_FLOOD_THRESHOLD=10$/m);
  assert.match(env, /^ZALO_KB_PUBLIC_DIRS="Năm 2026,Văn bản"$/m);
  assert.doesNotMatch(env, /ZALO_OWNER_ONLY_GROUPS/, 'khoá đang ở config.yaml thì sửa config.yaml');
  const y = YAML.parse(readFileSync(join(d, 'config.yaml'), 'utf8'));
  assert.deepEqual(y.platforms.zalo.extra.owner_only_groups, ['111', '333']);
  assert.equal(y.platforms.zalo.extra.bridge_token, 'bi-mat');
  assert.equal(pick(s.view(), 'kbPublicDirs').value.join('|'), 'Năm 2026|Văn bản');
  assert.ok(existsSync(join(d, '.env.bak')) && existsSync(join(d, 'config.yaml.bak')), 'có bản .bak');
  assert.deepEqual(s.save({ floodThreshold: 10 }), [], 'không đổi thì không ghi');
});

test('kiểm giá trị: kiểu, giới hạn, ký tự; khoá ngoài danh sách bị từ chối, không ghi gì', (t) => {
  const { d, s } = setup(t);
  const def = (id) => SETTINGS.find((x) => x.id === id);
  assert.throws(() => validateSetting(def('floodThreshold'), 1), /từ 2 đến 50/);
  assert.throws(() => validateSetting(def('floodThreshold'), '8'), /số nguyên/);
  assert.throws(() => validateSetting(def('dmPolicy'), 'everyone'), /chọn lại/);
  assert.throws(() => validateSetting(def('ownerOnlyGroups'), ['12a']), /không hợp lệ/);
  assert.throws(() => validateSetting(def('kbPublicDirs'), ['..']), /không hợp lệ/);
  assert.throws(() => validateSetting(def('kbPublicDirs'), ['a"\nOPENAI_API_KEY=x']), /không hợp lệ/);
  assert.throws(() => validateSetting(def('publicMcp'), ['rag;rm']), /không hợp lệ/);
  assert.throws(() => validateSetting(def('friendTools'), 'true'), /bật hoặc tắt/);
  assert.throws(() => s.save({ OPENAI_API_KEY: 'x' }), /không nằm trong danh sách/);
  assert.throws(() => s.save({ __proto__: { x: 1 }, toString: 1 }), /không nằm trong danh sách/);
  assert.throws(() => s.save({ floodThreshold: 999 }), /từ 2 đến 50/);
  assert.throws(() => s.save({ friendTools: false, floodThreshold: 999 }), /từ 2 đến 50/, 'một mục sai thì không ghi mục nào');
  assert.equal(readFileSync(join(d, '.env'), 'utf8'), ENV);
});

test('env-file: khoá Cấu hình ghi được chữ có dấu (trong ngoặc kép), không bao giờ chèn được dòng/khoá khác', (t) => {
  const d = mkdtempSync(join(tmpdir(), 'zd-envset-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const f = join(d, '.env');
  writeFileSync(f, 'A=1\n');
  writeEnvKey(f, 'ZALO_KB_PUBLIC_DIRS', 'Năm 2026,Văn bản');
  assert.equal(readEnvKey(f, 'ZALO_KB_PUBLIC_DIRS'), 'Năm 2026,Văn bản');
  writeEnvKey(f, 'ZALO_PUBLIC_MCP', 'rag,mcp-*');
  assert.match(readFileSync(f, 'utf8'), /^ZALO_PUBLIC_MCP=rag,mcp-\*$/m);
  for (const v of ['a"\nB=1', 'a\\b', 'x#y', 'a=b', "it's"]) assert.throws(() => writeEnvKey(f, 'ZALO_KB_PUBLIC_DIRS', v), /ký tự không cho phép/, v);
  assert.throws(() => writeEnvKey(f, 'ZALO_ALLOWED_USERS', 'abc'), /chữ số và dấu phẩy/);
});

test('đọc: bool rỗng = tắt (như _truthy); số thập phân của float() hiện đúng, số nguyên thì không', (t) => {
  const v = setup(t, { env: 'ZALO_FRIEND_TOOLS=\nZALO_FLOOD_WINDOW_S=7.5\nZALO_FLOOD_THRESHOLD=6.5\n', config: 'a: 1\n' }).s.view();
  assert.equal(pick(v, 'friendTools').value, false);
  assert.equal(pick(v, 'autoReact').value, true, 'khoá không đặt → mặc định');
  assert.equal(pick(setup(t, { env: 'ZALO_ACK_GESTURES=\n', config: 'a: 1\n' }).s.view(), 'ackGestures').value, false);
  assert.equal(pick(v, 'floodWindow').value, 7.5);
  assert.equal(pick(v, 'floodThreshold').value, 6, 'int() của adapter không nhận 6.5 → mặc định');
});

test('lưu nhiều tệp: .env ghi một lần (một .bak); .env hỏng sau khi config.yaml đã ghi → lỗi tiếng Việt kèm mục đã lưu', (t) => {
  const { d, s } = setup(t, { config: 'platforms:\n  zalo:\n    extra:\n      dm_policy: owner-only\n' });
  const seen = [];
  s.save({ dmPolicy: 'open', historyDays: 90, floodMute: 120 }, { onApplied: (c) => seen.push(c.map((x) => x.id)) });
  assert.deepEqual(seen, [['dmPolicy'], ['historyDays', 'floodMute']]);
  assert.equal(readFileSync(join(d, '.env.bak'), 'utf8'), ENV, 'một .bak = bản trước lần lưu');
  rmSync(join(d, '.env'), { force: true }); mkdirSync(join(d, '.env'));
  const seen2 = [];
  assert.throws(() => s.save({ dmPolicy: 'owner-only', historyDays: 100 }, { onApplied: (c) => seen2.push(c.map((x) => x.id)) }),
    (e) => e.partial && e.statusCode === 500 && /Đã lưu .*chưa lưu được/.test(e.message) && e.applied.map((a) => a.id).join() === 'dmPolicy');
  assert.deepEqual(seen2, [['dmPolicy']], 'cờ khởi động lại đã đánh dấu ngay sau khi ghi YAML');
});
