import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberDirectory, findMentions } from './zalo-mentions.js';

const members = [
  { uid: '111', name: 'Liên Lưu Thu' },
  { uid: '222', name: 'Lương Hải Anh Cnt' },
  { uid: '333', name: 'Trang' },
  { uid: '444', name: 'Trang' },
  { uid: '555', name: 'Thu' },
  { uid: 'bot', name: 'Lăng Tiêu' },
];

test('gắn tag đúng người khi "@Tên" khớp trọn tên thành viên', () => {
  const msg = 'Chị @Liên Lưu Thu ơi, sếp @lương hải anh cnt đã duyệt, @Thu nhớ nộp nhé.';
  assert.deepEqual(findMentions(msg, members, { selfUid: 'bot' }), [
    { pos: msg.indexOf('@Liên'), len: '@Liên Lưu Thu'.length, uid: '111' },
    { pos: msg.indexOf('@lương'), len: '@Lương Hải Anh Cnt'.length, uid: '222' },
    { pos: msg.indexOf('@Thu'), len: '@Thu'.length, uid: '555' },
  ]);
});

test('tên trùng, không khớp, dính chữ, email và chính bot thì để nguyên dạng chữ', () => {
  const msg = '@Trang ơi, @Người Lạ, @Liên Lưu Thuỷ, mail a@Liên Lưu Thu, và @Lăng Tiêu';
  assert.deepEqual(findMentions(msg, members, { selfUid: 'bot' }), []);
  assert.deepEqual(findMentions('không có ai được gọi', members), []);
});

test('tên còn tiếp bằng chữ hoa hoặc bị cắt ở cuối chunk thì không tag người tên ngắn hơn', () => {
  assert.deepEqual(findMentions('Nhờ @Thu Hà xem giúp', members), []);

  const tail = 'Việc này nhờ @Thu ';
  assert.deepEqual(findMentions(tail, members, { continuesInNextChunk: true }), []);
  assert.deepEqual(findMentions(tail, members), [{ pos: tail.indexOf('@Thu'), len: 4, uid: '555' }]);
});

test('danh bạ nhớ tạm kết quả đầy đủ, không nhớ kết quả thiếu, lỗi thì dùng bản cũ', async () => {
  let calls = 0;
  let clock = 0;
  let next = { members: [{ uid: '1', name: 'A' }], cacheable: true };
  const directory = createMemberDirectory({
    ttlMs: 1000,
    now: () => clock,
    fetchMembers: async () => {
      calls += 1;
      if (next instanceof Error) throw next;
      return next;
    },
  });

  assert.deepEqual(await directory.get('g1'), [{ uid: '1', name: 'A' }]);
  await directory.get('g1');
  assert.equal(calls, 1);

  clock = 2000;
  next = { members: [{ uid: '9', name: 'Chỉ người vừa nhắn' }], cacheable: false };
  assert.deepEqual(await directory.get('g1'), [{ uid: '1', name: 'A' }]);
  assert.deepEqual(await directory.get('g2'), [{ uid: '9', name: 'Chỉ người vừa nhắn' }]);
  await directory.get('g2');
  assert.equal(calls, 4);

  next = new Error('mạng chập chờn');
  assert.deepEqual(await directory.get('g1'), [{ uid: '1', name: 'A' }]);
  assert.deepEqual(await directory.get('g3'), []);
});
