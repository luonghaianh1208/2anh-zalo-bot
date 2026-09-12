import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAttachments, guessAttachment, hasRealMedia, isFileMessage } from './zalo-attachments.js';

test('tin gửi tệp chỉ giữ chính tệp, kèm tên và MIME thật', () => {
  const msg = {
    data: {
      msgType: 'share.file',
      content: {
        title: '22-KH.Triển khai cuộc thi Tiếng nói xanh mùa IV.pdf',
        href: 'https://file-stal-19.dlfl.vn/gr/0d3f/2aOboQy2',
        thumb: 'https://photo-stal-1.zdn.vn/thumb/abc',
      },
    },
  };
  const urls = ['https://photo-stal-1.zdn.vn/thumb/abc', 'https://file-stal-19.dlfl.vn/gr/0d3f/2aOboQy2'];

  assert.deepEqual(classifyAttachments(msg, urls), [{
    url: 'https://file-stal-19.dlfl.vn/gr/0d3f/2aOboQy2',
    name: '22-KH.Triển khai cuộc thi Tiếng nói xanh mùa IV.pdf',
    mime: 'application/pdf',
    kind: 'document',
  }]);
});

test('tin ảnh vẫn là ảnh, kể cả khi URL không có đuôi', () => {
  const msg = { data: { msgType: 'chat.photo', content: { href: 'https://photo-stal-7.zdn.vn/gr/jxl/abc' } } };
  const got = classifyAttachments(msg, ['https://photo-stal-7.zdn.vn/gr/jxl/abc']);

  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'image');
  assert.equal(got[0].mime, 'image/jpeg');
});

test('thẻ chia sẻ link không phải media: để nguyên link trong chữ', () => {
  const msg = {
    data: {
      msgType: 'chat.recommended',
      content: {
        title: 'TikTok',
        href: 'https://vt.tiktok.com/ZSqa1xG7s/',
        thumb: 'https://photo-stal-1.zdn.vn/thumb/x',
      },
    },
  };

  assert.deepEqual(classifyAttachments(msg, ['https://vt.tiktok.com/ZSqa1xG7s/', 'https://photo-stal-1.zdn.vn/thumb/x']), []);
  assert.deepEqual(classifyAttachments({ data: { msgType: 'webchat', content: 'xem https://example.com nhé' } },
                                       ['https://example.com']), []);
  assert.equal(hasRealMedia('chat.photo'), true);
  assert.equal(hasRealMedia('share.file'), true);
  assert.equal(hasRealMedia('chat.recommended'), false);
  // Phần trích dẫn của Zalo chỉ có cliMsgType dạng số — phải coi là có media,
  // không thì reply vào ảnh sẽ mất ảnh.
  assert.equal(hasRealMedia(36), true);
  assert.equal(hasRealMedia(''), true);
});

test('đoán theo đuôi tệp: bảng tính, ảnh, tệp lạ', () => {
  assert.equal(guessAttachment('https://x/y', { name: 'Danh sách.xlsx', msgType: 'share.file' }).kind, 'document');
  assert.equal(guessAttachment('https://x/anh.png?v=2').mime, 'image/png');
  assert.equal(guessAttachment('https://x/y', { name: 'ban-ghi.abcdef', msgType: 'share.file' }).mime,
               'application/octet-stream');
  assert.equal(isFileMessage('share.file'), true);
  assert.equal(isFileMessage('webchat'), false);
});
