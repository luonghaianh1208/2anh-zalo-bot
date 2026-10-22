import test from 'node:test';
import assert from 'node:assert/strict';
import { SKILL_DOMAINS, SKILL_USES, countTags, filterChips, filterSkills, viSkill } from './skills-vi.js';
import { SKILL_VI } from './skills-vi-data.js';
import { fold } from './fold.js';

test('dữ liệu dịch: mỗi skill có mô tả tiếng Việt và chỉ dùng nhãn đã khai báo', () => {
  const domains = new Set(SKILL_DOMAINS.map(([id]) => id));
  const uses = new Set(SKILL_USES.map(([id]) => id));
  assert.ok(Object.keys(SKILL_VI).length > 200);
  for (const [name, [desc, d, u]] of Object.entries(SKILL_VI)) {
    assert.ok(desc && desc.length <= 260, name);
    assert.ok(d.length >= 1 && d.every((x) => domains.has(x)), `${name} lĩnh vực`);
    assert.ok(u.length >= 1 && u.every((x) => uses.has(x)), `${name} mục đích`);
  }
});

test('skill chưa dịch: giữ mô tả gốc, đoán lĩnh vực theo nhóm Hermes, còn lại vào Khác', () => {
  const a = viSkill({ name: 'skill-moi-xyz', description: 'Brand new skill', category: 'creative' });
  assert.equal(a.descVi, 'Brand new skill');
  assert.deepEqual(a.domains, ['sang-tao']);
  assert.deepEqual(a.uses, ['khac']);
  assert.deepEqual(viSkill({ name: 'la-hoan-toan', description: '', category: '' }).domains, ['khac']);
});

test('lọc theo lĩnh vực, mục đích và chữ gõ không dấu', () => {
  const list = [
    { name: 'de-kiem-tra', descVi: 'Ra đề kiểm tra theo ma trận', domains: ['giao-duc'], uses: ['hoc-tap', 'tao-tep'] },
    { name: 'docker', descVi: 'Quản lí container', description: 'Manage containers', domains: ['he-thong'], uses: ['ky-thuat'] },
    { name: 'pptx', descVi: 'Tạo slide PowerPoint', domains: ['van-phong', 'giao-duc'], uses: ['tao-tep'] },
  ];
  const names = (o) => filterSkills(list, { fold, ...o }).map((s) => s.name);
  assert.deepEqual(names({ domain: 'giao-duc' }), ['de-kiem-tra', 'pptx']);
  assert.deepEqual(names({ domain: 'giao-duc', use: 'hoc-tap' }), ['de-kiem-tra']);
  assert.deepEqual(names({ use: 'tao-tep' }), ['de-kiem-tra', 'pptx']);
  assert.deepEqual(names({ q: 'de kiem' }), ['de-kiem-tra']);
  assert.deepEqual(names({ q: 'container' }), ['docker']);
  const counts = countTags(list, 'domains');
  assert.deepEqual(counts, { 'giao-duc': 2, 'he-thong': 1, 'van-phong': 1 });
  const chips = filterChips(list.length, SKILL_DOMAINS, { ...counts, khac: 1 });
  assert.deepEqual(chips.map((c) => c[0]), ['all', 'giao-duc', 'van-phong', 'he-thong', 'khac']);
  assert.equal(chips[0][2], 3);
});
