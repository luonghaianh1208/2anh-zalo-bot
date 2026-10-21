import { html, Icon, fmtTime } from '../ui.js';

/** "vừa xong", "5 phút trước", "3 giờ trước"; xa hơn một ngày thì hiện ngày giờ. */
export function agoText(ms, now = Date.now()) {
  const m = Math.floor((now - ms) / 60_000);
  if (m < 1) return 'vừa xong';
  if (m < 60) return `${m} phút trước`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} giờ trước`;
  return fmtTime(ms);
}

/**
 * Danh sách thiết bị đang đăng nhập. `showUser` cho trang Quản trị (hiện tên tài khoản).
 * Thiết bị đang dùng không có nút đăng xuất ở đây — thoát bằng nút "Đăng xuất" của trang Tài khoản.
 */
export function DeviceList({ sessions, busy, onLogout, showUser = false }) {
  if (!sessions.length) return html`<p class="muted">Không có thiết bị nào đang đăng nhập.</p>`;
  return html`<ul class="device-list">
    ${sessions.map((s) => html`<li key=${s.id} class="device">
      <span class="device-icon"><${Icon} name=${s.device.mobile ? 'phone' : 'monitor'} size=${20} /></span>
      <div class="device-info">
        <strong>${showUser ? `${s.username} · ` : ''}${s.device.label}</strong>
        ${s.current ? html` <span class="tag">Thiết bị này</span>` : null}
        <span class="small muted">Hoạt động ${agoText(s.lastSeen)}${s.ip ? ` · IP ${s.ip}` : ''}</span>
        <span class="small muted">Đăng nhập ${fmtTime(s.createdAt)}${s.method ? ` bằng ${s.method}` : ''}</span>
      </div>
      ${s.current ? null : html`<button class="btn btn-danger-outline btn-sm" disabled=${busy === s.id}
        aria-label=${`Đăng xuất ${showUser ? `${s.username} trên ` : ''}${s.device.label}`} onClick=${() => onLogout(s)}>
        <${Icon} name="logout" size=${14} /> ${busy === s.id ? 'Đang đăng xuất…' : 'Đăng xuất'}</button>`}
    </li>`)}
  </ul>`;
}
