import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStickerDirectory, enrichSticker, isStickerMessage, stickerAttachment, stickerRefOf, stickerText,
} from './zalo-stickers.js';

const stickerFrame = (content = { id: 4001, catId: 10, type: 7 }) => ({
  threadId: 'g1', type: 1, data: { msgType: 'chat.sticker', content, dName: 'Trang' },
});

const detail = {
  id: 4001, text: 'cười lăn', stickerUrl: 'https://zalo.vn/sticker/4001.png',
  stickerWebpUrl: 'https://zalo.vn/sticker/4001.webp',
};

test('nhận ra tin sticker và lấy đúng id', () => {
  assert.equal(isStickerMessage('chat.sticker'), true);
  assert.equal(isStickerMessage('chat.photo'), false);
  assert.deepEqual(stickerRefOf(stickerFrame()), { id: 4001, cateId: 10, type: 7 });
  assert.equal(stickerRefOf({ data: { msgType: 'chat.photo', content: { id: 1 } } }), null);
  assert.equal(stickerRefOf({ data: { msgType: 'chat.sticker', content: 'xin chào' } }), null);
  assert.equal(stickerRefOf({ data: { msgType: 'chat.sticker', content: { id: 0 } } }), null);
});

test('nhãn chữ và ảnh tĩnh của sticker', () => {
  assert.equal(stickerText(detail), '[Nhãn dán: cười lăn]');
  assert.equal(stickerText({ text: '  ' }), '[Nhãn dán]');
  assert.equal(stickerText(null), '[Nhãn dán]');
  // Zalo thường trả mã nội bộ chứ không phải chữ cho người đọc.
  assert.equal(stickerText({ text: '[^10751.27703^]' }), '[Nhãn dán]');

  // Dùng bản PNG tĩnh, không dùng webp động — tầng ảnh chỉ đọc được khung đầu.
  assert.deepEqual(stickerAttachment(detail), {
    url: 'https://zalo.vn/sticker/4001.png',
    name: 'sticker-4001.png',
    mime: 'image/png',
    kind: 'image',
  });
  assert.equal(stickerAttachment({ id: 9, stickerUrl: '' }), null);
});

test('chỉ tra Zalo một lần cho mỗi sticker', async () => {
  let calls = 0;
  const dir = createStickerDirectory({ fetchDetail: (id) => { calls += 1; return [{ ...detail, id }]; } });

  assert.equal((await dir.get(4001)).text, 'cười lăn');
  assert.equal((await dir.get(4001)).text, 'cười lăn');
  assert.equal(calls, 1);

  await dir.get(4002);
  assert.equal(calls, 2);
});

test('tra hỏng hoặc quá lâu thì trả null chứ không ném lỗi', async () => {
  const hỏng = createStickerDirectory({ fetchDetail: () => { throw new Error('Zalo từ chối'); } });
  assert.equal(await hỏng.get(4001), null);

  const treo = createStickerDirectory({
    fetchDetail: () => new Promise(() => {}),
    timeoutMs: 20,
  });
  assert.equal(await treo.get(4001), null);

  const rỗng = createStickerDirectory({ fetchDetail: () => [] });
  assert.equal(await rỗng.get(4001), null);
});

test('nhớ có hạn, sticker cũ nhất bị đẩy ra trước', async () => {
  let calls = 0;
  const dir = createStickerDirectory({ fetchDetail: (id) => { calls += 1; return [{ ...detail, id }]; }, limit: 2 });
  await dir.get(1); await dir.get(2); await dir.get(3);
  assert.equal(calls, 3);
  await dir.get(1); // đã bị đẩy ra, phải tra lại
  assert.equal(calls, 4);
  await dir.get(3); // vẫn còn trong bộ nhớ
  assert.equal(calls, 4);
});

test('gắn nhãn vào khung tin; tra hỏng vẫn gắn nhãn trống để tin không bị bỏ', async () => {
  const dir = createStickerDirectory({ fetchDetail: () => [detail] });
  const msg = stickerFrame();
  const info = await enrichSticker(msg, dir);
  assert.equal(info.text, '[Nhãn dán: cười lăn]');
  assert.equal(msg.data.__sticker.attachment.url, 'https://zalo.vn/sticker/4001.png');

  const hỏng = createStickerDirectory({ fetchDetail: () => { throw new Error('mất mạng'); } });
  const msg2 = stickerFrame();
  const info2 = await enrichSticker(msg2, hỏng);
  assert.equal(info2.text, '[Nhãn dán]');
  assert.equal(info2.attachment, null);

  // Tin thường không bị đụng tới.
  const thường = { data: { msgType: 'webchat', content: 'chào em' } };
  assert.equal(await enrichSticker(thường, dir), null);
  assert.equal(thường.data.__sticker, undefined);
});
