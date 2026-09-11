import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberDirectory, findMentions } from './zalo-mentions.js';

const members = [
  { uid: '111', name: 'Liên Lưu Thu' },
  { uid: '222', name: 'Lương Hải Anh Cnt' },
  { uid: '333', name: 'Trang' },
  { uid: '444', name: 'Trang' },
  { uid: 'bot', name: 'Lăng Tiêu' },
];

test('gắn tag đúng người khi "@Tên" khớp trọn tên thành viên', () => {
  const msg = 'Chị @Liên Lưu Thu ơi, sếp @lương hải anh cnt đã duyệt.';
  assert.deepEqual(findMentions(msg, members, { selfUid: 'bot' }), [
    { pos: msg.indexOf('@Liên'), len: '@Liên Lưu Thu'.length, uid: '111' },
    { pos: msg.indexOf('@lương'), len: '@Lương Hải Anh Cnt'.length, uid: '222' },
  ]);
});

test('tên trùng, không khớp, dính chữ, email và chính bot thì để nguyên dạng chữ', () => {
  const msg = '@Trang ơi, @Người Lạ, @Liên Lưu Thuỷ, mail a@Liên Lưu Thu, và @Lăng Tiêu';
  assert.deepEqual(findMentions(msg, members, { selfUid: 'bot' }), []);
  assert.deepEqual(findMentions('không có ai được gọi', members), []);
});

test('danh bạ thành viên được nhớ tạm, tra lỗi thì dùng bản cũ hoặc rỗng', async () => {
  let calls = 0;
  let clock = 0;
  let fail = false;
  const directory = createMemberDirectory({
    ttlMs: 1000,
    now: () => clock,
    fetchMembers: async () => {
      calls += 1;
      if (fail) throw new Error('mạng chập chờn');
      return [{ uid: '1', name: 'A' }];
    },
  });

  assert.deepEqual(await directory.get('g1'), [{ uid: '1', name: 'A' }]);
  await directory.get('g1');
  assert.equal(calls, 1);

  clock = 2000;
  fail = true;
  assert.deepEqual(await directory.get('g1'), [{ uid: '1', name: 'A' }]);
  assert.deepEqual(await directory.get('g2'), []);
});
