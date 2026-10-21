// Phần dùng chung cho mọi màn: htm gắn preact, biểu tượng SVG, định dạng giờ, hộp thông báo.
import { h } from './vendor/preact.mjs';
import htm from './vendor/htm.mjs';
import { useEffect, useRef } from './vendor/hooks.mjs';

export const html = htm.bind(h);

const PATHS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  phone: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm4 17h2',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm13 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  check: 'M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4 12 14.01l-3-3',
  warn: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4m0 4h.01',
  error: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm3-13-6 6m0-6 6 6',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-6v-4m0-4h.01',
  bot: 'M12 8V4H8M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zm-4 6h2m16 0h2m-7-1v2m-6-2v2',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-14v4l3 2',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  send: 'm22 2-7 20-4-9-9-4zM22 2 11 13',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2m3.45-6.89L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  qr: 'M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h3v3h-3zm4 4h3v3h-3z',
  monitor: 'M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm4 18h8m-4-4v4',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9',
  refresh: 'M23 4v6h-6M1 20v-6h6m14.49-5A9 9 0 0 0 5.64 5.64L1 10m22 4-4.64 4.36A9 9 0 0 1 3.51 15',
  plus: 'M12 5v14m-7-7h14',
  lock: 'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zm2 0V7a5 5 0 0 1 10 0v4',
  unlock: 'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zm2 0V7a5 5 0 0 1 9.9-1',
  key: 'm21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6m4-3h6v6m-11 5L21 3',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2-4.35-4.35',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  image: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm3.5 7a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21',
  crown: 'M2 18h20M3 7l4.5 5L12 5l4.5 7L21 7l-2 11H5z',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  server: 'M4 3h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm0 10h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1zm3-6h.01M7 17h.01',
  disk: 'M22 12H2m3.45-6.89L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11zM6 16h.01M10 16h.01',
  play: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm-2-14 6 4-6 4z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm0 0v6h6',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4m4-5 5 5 5-5m-5 5V3',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  close: 'M18 6 6 18M6 6l12 12',
  clip: 'm21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  prev: 'm15 18-6-6 6-6',
  next: 'm9 18 6-6-6-6',
  brain: 'M9.5 2a2.5 2.5 0 0 0-2.45 2A3 3 0 0 0 4 7a3 3 0 0 0 .5 5.5A3 3 0 0 0 7 17a2.5 2.5 0 0 0 5 .5V4.5A2.5 2.5 0 0 0 9.5 2zm5 0a2.5 2.5 0 0 1 2.45 2A3 3 0 0 1 20 7a3 3 0 0 1-.5 5.5A3 3 0 0 1 17 17a2.5 2.5 0 0 1-5 .5',
  chart: 'M3 3v18h18M7 16v-5m5 5V8m5 8v-3',
  tool: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zm0 0A2.5 2.5 0 0 0 6.5 22H20v-5',
  heart: 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z',
  reply: 'M9 17 4 12l5-5M20 18v-2a4 4 0 0 0-4-4H4',
  undo: 'M3 7v6h6M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13',
  copy: 'M9 9h11a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  plug: 'M9 2v6m6-6v6M6 8h12v4a6 6 0 0 1-12 0zm6 10v4',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zm11 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  sidebar: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm10 0v18',
  pin: 'M12 17v5M9 3h6l-1 6 4 4v2H6v-2l4-4z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-4l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.07-.4.1-.8.1-1.2z',
};

export function Icon({ name, size = 18 }) {
  return html`<svg class="icon" width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d=${PATHS[name] || PATHS.info} /></svg>`;
}

const KIND_ICON = { ok: 'check', warn: 'warn', danger: 'error', info: 'info' };

/** Hộp thông báo có biểu tượng + chữ (không chỉ dựa vào màu). Không tự đọc to — muốn đọc thì đặt trong <Live>. */
export function Notice({ kind = 'info', children }) {
  if (!children) return null;
  return html`<div class=${`notice notice-${kind}`}>
    <${Icon} name=${KIND_ICON[kind]} /><div>${children}</div></div>`;
}

/** Vùng thông báo luôn có mặt trong DOM để trình đọc màn hình bắt được nội dung mới. */
export function Live({ error, ok }) {
  return html`<div aria-live="polite" class="live">
    ${error ? html`<${Notice} kind="danger">${error}<//>` : null}
    ${ok ? html`<${Notice} kind="ok">${ok}<//>` : null}
  </div>`;
}

const fmt = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
export const fmtTime = (ms) => (ms ? fmt.format(new Date(ms)) : 'Chưa có');

export const roleLabel = (role) => (role === 'admin' ? 'Quản trị' : 'Chủ bot');

export function Spinner({ label = 'Đang tải…' }) {
  return html`<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span>${label}</div>`;
}

/** Logo thương hiệu: ảnh đã tải lên (cùng nguồn, hợp CSP), chưa có thì biểu tượng bot trên nền màu thương hiệu. */
export function BrandMark({ brand, size = 20 }) {
  return brand?.logoUrl
    ? html`<img class="logo logo-img" src=${brand.logoUrl} alt="" />`
    : html`<span class="logo" aria-hidden="true"><${Icon} name="bot" size=${size} /></span>`;
}

export function PoweredBy({ brand }) {
  return brand?.poweredBy ? html`<p class="powered">Vận hành bởi 2Anh AI</p>` : null;
}

/**
 * Ô bật/tắt có nhãn và dòng gợi ý (Phân quyền Bot: nhóm và nhắn riêng); `more` = phần giải thích gập thêm;
 * `disabled` = máy chủ khoá nút này (lý do nằm ở dòng gợi ý).
 */
export function Toggle({ id, checked, onChange, label, hint, more, disabled }) {
  return html`<div class="perm-row">
    <label class="check" for=${id}><input id=${id} type="checkbox" checked=${checked} disabled=${disabled}
      aria-describedby=${hint ? `${id}-hint` : undefined} onChange=${(e) => onChange(e.currentTarget.checked)} />${label}</label>
    ${hint ? html`<small id=${`${id}-hint`} class="muted">${hint}</small>` : null}
    ${more ? html`<details class="more-hint"><summary>Chi tiết</summary><p class="muted small">${more}</p></details>` : null}
  </div>`;
}

/** "N thay đổi chưa lưu" hoặc câu khi chưa sửa gì. */
export const changesText = (count, idle = 'Chưa có thay đổi.') => (count ? `${count} thay đổi chưa lưu` : idle);

/** Đếm "a/b đang bật" của một bộ nút theo danh sách tính năng. */
export function onText(values, features) {
  const on = features.filter((f) => values[f.key]).length;
  return `${on}/${features.length} đang bật`;
}

/**
 * Thanh Lưu dính đáy khung sửa (Phân quyền Bot): số thay đổi, Hoàn tác, Lưu; thông báo lưu xong/lỗi nằm ngay trên.
 * Nút Lưu là nút submit của form chứa nó.
 */
export function SaveBar({ count, busy, canSave, onUndo, idle, msg }) {
  return html`<div class="save-bar">
    <${Live} error=${msg?.error} ok=${msg?.ok} />
    <span class=${`save-bar-text${count ? '' : ' muted'}`}>${changesText(count, idle)}</span>
    <button type="button" class="btn btn-secondary" disabled=${busy || !count} onClick=${onUndo}>Hoàn tác</button>
    <button class="btn btn-primary" disabled=${busy || !canSave}>${busy ? 'Đang lưu…' : 'Lưu'}</button>
  </div>`;
}

export function PageHead({ title, sub }) {
  return html`<header class="page-head"><h1>${title}</h1>${sub ? html`<p class="muted">${sub}</p>` : null}</header>`;
}

let dialogSeq = 0;
/**
 * Cửa sổ chi tiết (<dialog> gốc: khoá focus, Esc để đóng). Bấm nền tối bên ngoài cũng đóng — chỉ khi cả lúc nhấn
 * lẫn lúc thả chuột đều ở nền (kéo chọn chữ ra ngoài không đóng). `dirty()` true → hỏi trước khi đóng, khỏi mất bản đang sửa.
 * Đóng xong trả focus về nút đã mở (nút đã mất thì về tiêu đề trang).
 */
export function Dialog({ title, onClose, dirty, children, wide = false }) {
  const ref = useRef(null);
  const id = useRef(`dlg-${++dialogSeq}`).current;
  const latest = useRef({ onClose, dirty });
  latest.current = { onClose, dirty };
  const close = () => {
    const { onClose: done, dirty: isDirty } = latest.current;
    if (isDirty?.() && !confirm('Bỏ các thay đổi chưa lưu?')) return;
    done();
  };
  useEffect(() => {
    const d = ref.current;
    const back = document.activeElement;
    if (d && !d.open) d.showModal();
    let downOnBackdrop = false;
    const cancel = (e) => { e.preventDefault(); close(); };
    const down = (e) => { downOnBackdrop = e.target === d; };
    const click = (e) => { if (downOnBackdrop && e.target === d) close(); downOnBackdrop = false; };
    d?.addEventListener('cancel', cancel);
    d?.addEventListener('mousedown', down);
    d?.addEventListener('click', click);
    return () => {
      d?.removeEventListener('cancel', cancel); d?.removeEventListener('mousedown', down); d?.removeEventListener('click', click);
      if (d?.open) d.close();
      const target = back?.isConnected ? back : document.querySelector('main h1, h1');
      if (target && !back?.isConnected) target.setAttribute('tabindex', '-1');
      target?.focus?.();
    };
  }, []);
  return html`<dialog ref=${ref} class=${wide ? 'dialog dialog-wide' : 'dialog'} aria-labelledby=${id}>
    <div class="dialog-head"><h2 id=${id}>${title}</h2>
      <button type="button" class="btn btn-secondary btn-sm icon-btn" aria-label="Đóng" onClick=${close}><${Icon} name="close" size=${16} /></button></div>
    <div class="dialog-body">${children}</div>
  </dialog>`;
}
