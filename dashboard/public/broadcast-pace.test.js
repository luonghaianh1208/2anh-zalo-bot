import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACE_FIELDS, PACE_PRESETS, estimateMs, estimateText, folderTargets, previewText, targetSummary } from './broadcast-pace.js';
import { DEFAULT_PACE, normalizePace, renderText } from '../../zalo-broadcast.js';

const safe = PACE_PRESETS.find((p) => p.value === 'safe').pace;

test('mọi mức nhịp có sẵn đều qua được kiểm tra của bot; mức An toàn là mặc định của bot', () => {
  for (const p of PACE_PRESETS) assert.deepEqual(normalizePace(p.pace), p.pace);
  assert.deepEqual(safe, DEFAULT_PACE);
});

test('ô tuỳ chỉnh không cho nhập dưới sàn của bot', () => {
  assert.throws(() => normalizePace({ minDelayS: PACE_FIELDS[0].min - 1 }));
  for (const f of PACE_FIELDS) assert.equal(normalizePace({ ...DEFAULT_PACE, [f.key]: DEFAULT_PACE[f.key] })[f.key], DEFAULT_PACE[f.key]);
});

test('xem trước khớp đúng cách bot chèn tên', () => {
  for (const [t, n] of [['Chào {ten}', 'Lan'], ['{ TÊN }!', ''], ['$& {ten}', '$1']]) assert.equal(previewText(t, n), renderText(t, n));
});

test('ước tính gồm giãn cách và thời gian nghỉ giữa tốp', () => {
  const { activeMs } = estimateMs(21, safe); // 20 khoảng 67,5 giây + 1 lần nghỉ 15 phút
  assert.equal(activeMs, (20 * 67.5 + 15 * 60) * 1000);
  assert.equal(estimateText(1, safe), 'khoảng 1 phút');
  assert.equal(estimateText(21, safe), 'khoảng 38 phút');
  assert.equal(estimateText(0, safe), '');
});

test('vượt trần ngày thì ước tính theo ngày', () => {
  assert.equal(estimateMs(250, safe).days, 3);
  assert.equal(estimateText(250, safe), 'khoảng 3 ngày');
  assert.equal(estimateText(100, { ...safe, fromHour: 8, toHour: 9 }), 'khoảng 3 ngày'); // khung giờ 1 tiếng
});

test('nơi nhận theo thư mục: lọc nhóm/người, mỗi nơi một lần, thư mục không chọn thì bỏ', () => {
  const book = { groups: [{ id: '1', name: 'Lớp A' }], people: [{ uid: '9', name: 'Lan' }] };
  const folders = [{ id: 'a', groups: ['1'], people: ['9'] }, { id: 'b', groups: ['1'], people: [] }, { id: 'c', groups: ['2'], people: [] }];
  const picked = new Set(['a', 'b']);
  assert.deepEqual(folderTargets(folders, picked, 'all', book), [{ id: '1', type: 1, name: 'Lớp A' }, { id: '9', type: 0, name: 'Lan' }]);
  assert.deepEqual(folderTargets(folders, picked, 'groups', book).map((t) => t.type), [1]);
  assert.deepEqual(folderTargets(folders, picked, 'people', book).map((t) => t.type), [0]);
  assert.equal(targetSummary(folderTargets(folders, picked, 'all', book)), '1 nhóm, 1 người');
});
