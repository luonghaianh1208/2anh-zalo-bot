/**
 * Giãn cách nhịp gửi tin để Zalo không coi tài khoản là spam.
 *
 * Vì sao cần: Hermes trả lời xong thường bắn liền mấy thứ sát nhau — đoạn văn
 * bản, rồi sticker, rồi có khi một tệp đính kèm. Zalo quét hành vi spam trên
 * tài khoản cá nhân, và mất tài khoản là mất luôn cả kênh liên lạc.
 *
 * Vì sao là token bucket chứ không phải "ngủ 3 giây sau mỗi tin": ngủ cố định
 * làm chậm cả những lượt trả lời bình thường, tức là đánh đổi chất lượng lấy
 * an toàn. Bucket có sẵn một nhúm token (mặc định 5) nên một lượt trả lời
 * thông thường đi ra tức thì, không chờ mili giây nào; chỉ khi gửi dồn dập kéo
 * dài mới bị giãn về nhịp bền vững 20 tin/phút.
 *
 * Hai chi tiết nữa để không làm hỏng trải nghiệm:
 *
 *   - **Ưu tiên**: tin trả lời trong hội thoại xếp trước thao tác hàng loạt.
 *     Chủ nhân bảo bot chuyển tiếp tới 20 nhóm thì việc đó không được phép
 *     làm người đang nói chuyện phải chờ.
 *
 *   - **Từ chối sớm**: adapter phía Hermes chờ ack tối đa 30 giây
 *     (`ACK_TIMEOUT_SECONDS`). Nếu giữ tin lâu hơn thế, agent tưởng gửi hỏng
 *     và có thể thử lại — thành ra càng spam. Nên khi ước tính phải chờ quá
 *     `maxWaitMs`, ta báo lỗi rõ ràng ngay để agent biết đường dừng.
 */

export class RateLimitedError extends Error {
  constructor(waitMs) {
    super(`Đang bị giãn nhịp chống spam, cần chờ ~${Math.ceil(waitMs / 1000)}s. `
      + 'Hãy gửi ít tin hơn hoặc thử lại sau.');
    this.name = 'RateLimitedError';
    this.waitMs = waitMs;
  }
}

export class RateLimiter {
  #tokens;
  #capacity;
  #refillMs;
  #maxWaitMs;
  #last;
  #hi = [];
  #lo = [];
  #timer = null;

  /**
   * @param {object} opts
   * @param {number} opts.capacity  Số tin được phép bắn liền không chờ.
   * @param {number} opts.refillMs  Thời gian hồi lại một token (3000 = 20 tin/phút).
   * @param {number} opts.maxWaitMs Chờ quá mức này thì từ chối thay vì để adapter timeout.
   */
  constructor({ capacity = 5, refillMs = 3000, maxWaitMs = 20000 } = {}) {
    this.#capacity = Math.max(1, capacity);
    this.#refillMs = Math.max(1, refillMs);
    this.#maxWaitMs = Math.max(0, maxWaitMs);
    this.#tokens = this.#capacity;
    this.#last = Date.now();
  }

  get queued() {
    return this.#hi.length + this.#lo.length;
  }

  /** Số token còn lại, làm tròn xuống — chỉ dùng để hiển thị/kiểm thử. */
  get available() {
    this.#refill();
    return Math.floor(this.#tokens);
  }

  #refill() {
    const now = Date.now();
    const gained = (now - this.#last) / this.#refillMs;
    if (gained <= 0) return;
    this.#tokens = Math.min(this.#capacity, this.#tokens + gained);
    this.#last = now;
  }

  /**
   * Xin một suất gửi.
   *
   * @param {'high'|'normal'} priority 'high' cho tin trả lời trong hội thoại.
   * @returns {Promise<void>} resolve khi được phép gửi.
   * @throws {RateLimitedError} khi phải chờ lâu hơn maxWaitMs.
   */
  acquire(priority = 'normal') {
    this.#refill();

    // Đường nhanh: còn token và không ai xếp hàng trước → đi ngay, không chờ.
    // Đây là nhánh chạy trong gần như mọi lượt trả lời bình thường.
    if (this.queued === 0 && this.#tokens >= 1) {
      this.#tokens -= 1;
      return Promise.resolve();
    }

    // Ước tính thời gian chờ. Tin ưu tiên chỉ phải xếp sau tin ưu tiên khác.
    const ahead = priority === 'high' ? this.#hi.length : this.queued;
    const waitMs = Math.max(0, Math.ceil((ahead + 1 - this.#tokens) * this.#refillMs));
    if (waitMs > this.#maxWaitMs) {
      return Promise.reject(new RateLimitedError(waitMs));
    }

    return new Promise((resolve) => {
      (priority === 'high' ? this.#hi : this.#lo).push(resolve);
      this.#schedule();
    });
  }

  #schedule() {
    if (this.#timer) return;
    const tick = () => {
      this.#timer = null;
      this.#refill();
      while (this.#tokens >= 1 && this.queued > 0) {
        const next = this.#hi.shift() ?? this.#lo.shift();
        this.#tokens -= 1;
        next();
      }
      if (this.queued > 0) {
        const need = Math.ceil((1 - this.#tokens) * this.#refillMs);
        this.#timer = setTimeout(tick, Math.max(25, need));
      }
    };
    this.#timer = setTimeout(tick, 25);
  }

  /** Huỷ bộ đếm giờ để tiến trình thoát được (dùng khi tắt hoặc trong test). */
  stop() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}

/**
 * Những lệnh tạo ra nội dung người khác nhìn thấy — đây mới là thứ Zalo tính
 * là hành vi gửi. Đọc dữ liệu, gõ phím, đã xem, thả cảm xúc đều không tính:
 * bóp chúng chỉ làm bot có vẻ chậm chạp chứ không giảm rủi ro gì.
 */
export const THROTTLED_METHODS = new Set([
  'sendMessage', 'sendVoice', 'sendVideo', 'sendSticker', 'sendLink', 'sendCard',
  'uploadAttachment', 'forwardMessage',
  // Bình chọn / ghi chú / lời nhắc đều hiện thành một mục trong nhóm.
  'createPoll', 'createNote', 'createReminder',
  // Mời và thêm người hàng loạt là con đường dẫn tới khoá tài khoản không kém
  // gì nhắn tin hàng loạt.
  'addUserToGroup', 'inviteUserToGroups',
]);
