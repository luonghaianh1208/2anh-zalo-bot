import { Reactions } from 'zca-js';

/**
 * Phân tích cảm xúc & nội dung câu hỏi/tin nhắn để chọn Reaction phù hợp nhất trên Zalo:
 * Không còn cố định Tim/Like, sử dụng linh hoạt đa dạng các sắc thái cảm xúc:
 * - Vui vẻ, hài hước, đùa: HAHA (😆), TEARS_OF_JOY (😂), BIG_SMILE (😃)
 * - Yêu thương, cảm kích, chúc mừng: LOVE (🥰), KISS (😘), ROSE (🌹), BIRTHDAY (🎂)
 * - Ngạc nhiên, thán phục, ngầu: WOW (😮), COOL / SUNGLASSES (😎), HANDCLAP (👏)
 * - Cảm ơn, kính cẩn, biết ơn: THANKS / PRAY (🙏), PEACE (✌️)
 * - Thắc mắc, suy nghĩ, băn khoăn: CONFUSED (🤔), NERD (🤓)
 * - Buồn bã, đồng cảm, tiếc nuối: CRY (😢), SAD (😔), BROKEN_HEART (💔)
 * - Tức giận, phản đối, cảnh báo: ANGRY (😡), BOMB (💣)
 * - Tự tin, đồng ý, quyết tâm: OK (👌), PUNCH (👊), SUN (☀️)
 */
export function pickSmartReaction(content) {
  if (!content) return Reactions.OK || 23;
  const text = content.toLowerCase();

  // 1. Hài hước / Cười đùa / Vui vẻ
  if (text.includes('haha') || text.includes('hihi') || text.includes('hehe') || text.includes('lol') || text.includes('kiki') || text.includes('vui') || text.includes('hài') || text.includes('buồn cười')) {
    const list = [Reactions.HAHA, Reactions.TEARS_OF_JOY, Reactions.BIG_SMILE];
    return list[Math.floor(Math.random() * list.length)];
  }

  // 2. Cảm ơn / Biết ơn / Cầu chúc / Lễ phép
  if (text.includes('cảm ơn') || text.includes('cam on') || text.includes('tks') || text.includes('thanks') || text.includes('cám ơn') || text.includes('biết ơn') || text.includes('giúp')) {
    const list = [Reactions.PRAY, Reactions.THANKS, Reactions.ROSE, Reactions.PEACE];
    return list[Math.floor(Math.random() * list.length)];
  }

  // 3. Khen ngợi / Đỉnh / Ngầu / Tuyệt vời / Vỗ tay
  if (text.includes('đỉnh') || text.includes('quá đỉnh') || text.includes('xịn') || text.includes('pro') || text.includes('giỏi') || text.includes('tuyệt') || text.includes('vip') || text.includes('hay')) {
    const list = [Reactions.COOL, Reactions.HANDCLAP, Reactions.SUNGLASSES, Reactions.WOW];
    return list[Math.floor(Math.random() * list.length)];
  }

  // 4. Ngạc nhiên / Bất ngờ / Kỳ diệu
  if (text.includes('thật á') || text.includes('ghê') || text.includes('uầy') || text.includes('oa') || text.includes('wow') || text.includes('bất ngờ') || text.includes('ảo')) {
    return Reactions.WOW;
  }

  // 5. Thắc mắc / Hỏi bài / Nghiên cứu / Suy ngẫm
  if (text.includes('sao lại') || text.includes('tại sao') || text.includes('nghĩa là gì') || text.includes('như thế nào') || text.includes('hóa học') || text.includes('công thức') || text.includes('bài tập') || text.includes('?')) {
    const list = [Reactions.CONFUSED, Reactions.NERD, Reactions.OK];
    return list[Math.floor(Math.random() * list.length)];
  }

  // 6. Buồn / Tiếc nuối / Thất vọng / Mệt mỏi
  if (text.includes('buồn') || text.includes('huhu') || text.includes('toang') || text.includes('chán') || text.includes('mệt') || text.includes('khóc') || text.includes('khó quá') || text.includes('fail')) {
    const list = [Reactions.CRY, Reactions.SAD, Reactions.BROKEN_HEART];
    return list[Math.floor(Math.random() * list.length)];
  }

  // 7. Chúc mừng sinh nhật / Sự kiện / Lễ hội
  if (text.includes('sinh nhật') || text.includes('chúc mừng') || text.includes('năm mới') || text.includes('tết') || text.includes('kỷ niệm')) {
    const list = [Reactions.BIRTHDAY, Reactions.ROSE, Reactions.LOVE];
    return list[Math.floor(Math.random() * list.length)];
  }

  // 8. Tình cảm / Quý mến / Nhiệt huyết
  if (text.includes('yêu') || text.includes('quý') || text.includes('thương') || text.includes('cute') || text.includes('dễ thương') || text.includes('đáng yêu')) {
    const list = [Reactions.LOVE, Reactions.KISS, Reactions.LOVE_YOU];
    return list[Math.floor(Math.random() * list.length)];
  }

  // 9. Quyết tâm / Đồng ý / Giao việc / Ok / Lệnh
  if (text.includes('ok') || text.includes('nhất trí') || text.includes('triển') || text.includes('làm đi') || text.includes('lệnh') || text.includes('giúp anh') || text.includes('soạn')) {
    const list = [Reactions.OK, Reactions.PUNCH, Reactions.SUN];
    return list[Math.floor(Math.random() * list.length)];
  }

  // 10. Chào hỏi ban đầu
  if (text.includes('chào') || text.includes('hello') || text.includes('hi') || text.includes('hí')) {
    const list = [Reactions.PEACE, Reactions.WINK, Reactions.BIG_SMILE, Reactions.SUN];
    return list[Math.floor(Math.random() * list.length)];
  }

  // Mặc định đa sắc thái (Random nhẹ nhàng tạo cảm giác người thật)
  const defaultList = [Reactions.OK, Reactions.PEACE, Reactions.BIG_SMILE, Reactions.WINK, Reactions.SUN];
  return defaultList[Math.floor(Math.random() * defaultList.length)];
}
