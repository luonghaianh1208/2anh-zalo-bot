import { useEffect, useRef, useState } from '../vendor/hooks.mjs';
import { api } from '../api.js';
import { html, BrandMark, Icon, PoweredBy, roleLabel } from '../ui.js';
import { Overview } from './overview.js';
import { Zalo } from './zalo.js';
import { Users } from './users.js';
import { Alerts } from './alerts.js';
import { Profile } from './profile.js';
import { Chats } from './chats.js';
import { Audit, AuditAi } from './audit.js';
import { Ai } from './ai.js';
import { Permissions } from './permissions.js';
import { Brand } from './brand.js';
import { Owners } from './owners.js';
import { Health } from './health.js';
import { Contacts } from './contacts.js';
import { Broadcast } from './broadcast.js';
import { Schedules } from './schedules.js';
import { Memory } from './memory.js';
import { Kb } from './kb.js';
import { Insight } from './insight.js';
import { SecondBrain } from './second-brain.js';
import { Agent } from './agent.js';
import { Tools } from './tools.js';
import { Mcp } from './mcp.js';
import { Skills } from './skills.js';
import { Maintenance } from './maintenance.js';
import { DonateButton } from './donate.js';
import { CommunityButton } from './community.js';
import { Settings } from './settings.js';

const STATUS_MS = 3000;

const ROUTES = {
  '/': { view: Overview },
  '/chats': { view: Chats },
  '/permissions': { view: Permissions },
  '/zalo': { view: Zalo },
  '/audit': { view: Audit },
  '/brand': { view: Brand },
  '/health': { view: Health },
  '/users': { view: Users, admin: true },
  '/owners': { view: Owners, admin: true },
  '/alerts': { view: Alerts, admin: true },
  '/profile': { view: Profile },
  '/contacts': { view: Contacts },
  '/broadcast': { view: Broadcast },
  '/schedules': { view: Schedules },
  '/memory': { view: Memory },
  '/kb': { view: Kb },
  '/insight': { view: Insight },
  '/second-brain': { view: SecondBrain, admin: true },
  '/mcp': { view: Mcp, admin: true },
  '/agent': { view: Agent, admin: true },
  '/ai': { view: Ai, admin: true },
  '/tools': { view: Tools, admin: true },
  '/skills': { view: Skills, admin: true },
  '/maintenance': { view: Maintenance, admin: true },
  '/trace': { view: AuditAi, admin: true }, // đường cũ Theo dõi agent → Nhật ký › Hoạt động AI
  '/settings': { view: Settings, admin: true },
};

// Thanh bên theo dashboard mẫu (spec §18.3): mục `admin: true` chỉ Quản trị thấy, nhóm rỗng thì ẩn.
export const GROUPS = [
  { label: 'Tổng quan', items: [{ path: '/', text: 'Tổng quan', icon: 'home' }] },
  { label: 'Hội thoại', items: [
    { path: '/chats', text: 'Phiên chat', icon: 'chat' },
    { path: '/contacts', text: 'Liên hệ', icon: 'users' },
    { path: '/broadcast', text: 'Gửi hàng loạt', icon: 'send' },
    { path: '/permissions', text: 'Phân quyền Bot', icon: 'shield' },
    { path: '/schedules', text: 'Lịch hẹn', icon: 'clock' },
  ] },
  { label: 'Dữ liệu', items: [
    { path: '/memory', text: 'Trí nhớ', icon: 'brain' },
    { path: '/kb', text: 'Kho tri thức', icon: 'file' },
    { path: '/insight', text: 'Insight nhóm', icon: 'chart' },
    { path: '/second-brain', text: 'Second brain', icon: 'search', admin: true, feature: 'secondBrain' },
    { path: '/mcp', text: 'Kết nối MCP', icon: 'plug', admin: true },
  ] },
  { label: 'Hệ thống', items: [
    { path: '/zalo', text: 'Tài khoản Zalo', icon: 'phone' },
    { path: '/agent', text: 'Tính cách AI', icon: 'bot', admin: true },
    { path: '/ai', text: 'Khoá API & Model', icon: 'key', admin: true },
    { path: '/tools', text: 'Công cụ', icon: 'tool', admin: true },
    { path: '/skills', text: 'Skill', icon: 'book', admin: true },
    { path: '/audit', text: 'Nhật ký', icon: 'list' },
    { path: '/brand', text: 'Thương hiệu', icon: 'image' },
    { path: '/health', text: 'Sức khoẻ máy chủ', icon: 'activity' },
    { path: '/maintenance', text: 'Bảo trì', icon: 'refresh', admin: true },
    { path: '/settings', text: 'Cấu hình', icon: 'settings', admin: true },
  ] },
  { label: 'Quản trị', admin: true, items: [
    { path: '/users', text: 'Người dùng', icon: 'users' },
    { path: '/owners', text: 'Chủ nhân bot', icon: 'crown' },
    { path: '/alerts', text: 'Cảnh báo Telegram', icon: 'bell' },
  ] },
];

// Mỗi mục một màu (ô biểu tượng ở thanh bên, tiêu đề thẻ trong trang) — kiểu macOS: nhìn màu là biết đang ở đâu.
export const TINTS = {
  '/': 'indigo', '/chats': 'blue', '/contacts': 'green', '/broadcast': 'teal', '/permissions': 'purple', '/schedules': 'orange',
  '/memory': 'pink', '/kb': 'brown', '/insight': 'teal', '/second-brain': 'purple', '/mcp': 'cyan',
  '/zalo': 'blue', '/agent': 'gray', '/ai': 'yellow', '/tools': 'gray', '/skills': 'green', '/audit': 'gray',
  '/brand': 'pink', '/health': 'red', '/maintenance': 'indigo', '/settings': 'gray',
  '/users': 'blue', '/owners': 'yellow', '/alerts': 'red', '/profile': 'gray', '/trace': 'gray',
};
export const tintOf = (path) => TINTS[path] || 'gray';

function NavIcon({ path, icon }) {
  return html`<span class=${`nav-ico tint-${tintOf(path)}`} aria-hidden="true"><${Icon} name=${icon} size=${16} /></span>`;
}

/** Số liệu nhỏ bên phải mục menu (như "CPU 59%"): số hội thoại có tin hôm nay, CPU máy chủ, có bản mới. */
export function navValue(path, status, notice) {
  if (path === '/chats' && status?.today) {
    // Bản cũ của máy chủ chưa có `threads` → vẫn hiện số tin như trước.
    return Number.isFinite(status.today.threads) ? String(status.today.threads) : String((status.today.received || 0) + (status.today.sent || 0));
  }
  if (path === '/health' && Number.isFinite(status?.host?.cpuPct)) return `${Math.round(status.host.cpuPct)}%`;
  if (path === '/zalo' && status) return status.sidecar === 'down' || status.zalo?.status !== 'logged-in' ? 'Tắt' : '';
  if (path === '/maintenance' && notice?.newer) return 'Mới';
  return '';
}

/** Tính năng bật theo cấu hình máy chủ (/api/features); lỗi → mọi tính năng tuỳ chọn ẩn. */
function useFeatures() {
  const [features, setFeatures] = useState({});
  useEffect(() => { api('/api/features').then((r) => setFeatures(r)).catch(() => setFeatures({})); }, []);
  return features;
}

/** Poll /api/status mỗi 3 s, không chồng yêu cầu; trả kèm hàm làm mới ngay. */
function useStatus() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const kick = useRef(() => {});
  useEffect(() => {
    let alive = true; let timer = null; let inflight = false; let again = false;
    const tick = async () => {
      if (inflight) { again = true; return; }
      clearTimeout(timer); inflight = true;
      try {
        const s = await api('/api/status');
        if (alive) { setStatus(s); setError(''); }
      } catch (err) {
        if (alive && err.status !== 401) setError(err.message);
      } finally {
        inflight = false;
        const next = again ? 0 : STATUS_MS; again = false;
        if (alive) timer = setTimeout(tick, next);
      }
    };
    kick.current = tick;
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, []);
  return [status, error, () => kick.current()];
}

export function statusLevel(s) {
  if (s.sidecar === 'down') return { kind: 'danger', icon: 'error', text: 'Kết nối Zalo đang tắt — hệ thống sẽ tự bật lại trong ít phút.', qr: true };
  if (s.zalo.needsRelogin || s.zalo.status !== 'logged-in') return { kind: 'danger', icon: 'error', text: 'Bot đang mất kết nối Zalo — cần quét mã đăng nhập lại.', qr: true };
  if (s.zalo.listener != null && s.zalo.listener !== 'connected') {
    return { kind: 'warn', icon: 'warn', text: 'Đang nối lại Zalo… — bot tạm thời chưa nhận được tin nhắn. Nếu quá 10 phút vẫn vậy, hãy quét mã đăng nhập lại.' };
  }
  if (s.assistant !== 'connected') return { kind: 'warn', icon: 'warn', text: 'Trợ lý chưa phản hồi — bot nhận tin nhưng chưa trả lời được. Báo người cài đặt nếu kéo dài.' };
  return { kind: 'ok', icon: 'check', text: `Bot đang hoạt động bình thường${s.zalo.displayName ? ` — ${s.zalo.displayName}` : ''}.` };
}

/**
 * Báo có bản bot mới. Hỏi máy chủ khi mở trang, khi quay lại tab, mỗi 15 giây lúc đang cập nhật, mỗi 2 phút lúc đang
 * báo có bản mới (để nhãn tự tắt ngay khi cập nhật xong ở nơi khác), còn lại mỗi giờ. `loaded`: bản máy chủ lúc trang
 * này mở — máy chủ đã lên bản khác thì nhắc tải lại trang.
 */
function useUpdateNotice() {
  const [n, setN] = useState(null);
  const loaded = useRef('');
  const updating = Boolean(n?.updating);
  const newer = Boolean(n?.newer);
  useEffect(() => {
    const load = () => api('/api/update-notice').then((r) => { if (!loaded.current && r.current) loaded.current = r.current; setN({ ...r, loaded: loaded.current }); }).catch(() => {});
    load();
    const t = setInterval(load, updating ? 15_000 : newer ? 120_000 : 3600_000);
    const onShow = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onShow);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onShow); };
  }, [updating, newer]);
  return n;
}

/** Máy chủ đã chạy bản khác bản lúc trang mở (vừa cập nhật xong) → cần tải lại trang. */
export const reloadNeeded = (n) => Boolean(n && !n.updating && n.loaded && n.current && n.current !== n.loaded);

export function noticeText(n) {
  if (!n) return '';
  if (n.updating) return 'Đang cập nhật bot…';
  if (reloadNeeded(n)) return `Đã cập nhật lên v${String(n.current).replace(/^v/, '')} — tải lại trang`;
  return n.newer ? `Có bản mới ${n.latest}` : '';
}

function StatusStrip({ status, error, path, admin, update }) {
  const notice = noticeText(update);
  let lv;
  if (error) lv = { kind: 'warn', icon: 'warn', text: `Không cập nhật được trạng thái. ${error}` };
  else if (status) lv = statusLevel(status);
  else lv = { kind: 'idle', icon: 'clock', text: 'Đang kiểm tra trạng thái bot…' };
  return html`<div class=${`strip strip-${lv.kind}`} role="status" aria-live="polite">
    <span class="strip-text"><${Icon} name=${lv.icon} /> ${lv.text}</span>
    <span class="strip-actions">
      ${notice && reloadNeeded(update) ? html`<button type="button" class="update-pill" onClick=${() => location.reload()}><${Icon} name="refresh" size=${16} /> ${notice}</button>`
        : notice ? (admin && path !== '/maintenance' ? html`<a class="update-pill" href="#/maintenance"><${Icon} name="download" size=${16} /> ${notice}</a>`
        : html`<span class="update-pill" title=${admin ? '' : 'Báo người quản trị để cập nhật'}><${Icon} name="download" size=${16} /> ${notice}</span>`) : null}
      ${lv.qr && path !== '/zalo' ? html`<a class="btn btn-light btn-sm" href="#/zalo"><${Icon} name="qr" size=${16} /> Quét mã đăng nhập lại</a>` : null}
      <${CommunityButton} />
      <${DonateButton} className="donate-pill" />
    </span>
  </div>`;
}

// Thanh điều hướng điện thoại: 4 mục chính luôn hiện, còn lại trong "Thêm ▾".
export const MOBILE_PRIMARY = ['/', '/chats', '/zalo', '/permissions'];
const SHORT = { '/broadcast': 'Gửi loạt', '/ai': 'Khoá & Model', '/second-brain': 'Second brain', '/mcp': 'MCP', '/zalo': 'Zalo', '/permissions': 'Phân quyền', '/health': 'Sức khoẻ', '/alerts': 'Cảnh báo', '/owners': 'Chủ nhân', '/profile': 'Tài khoản' };

/**
 * Nhóm thanh bên vai trò này thấy: bỏ nhóm/mục `admin` với Chủ bot, bỏ mục có `feature` đang tắt
 * (`features` từ /api/features — vd. Second brain chỉ khi bật trên máy chủ Linux), bỏ nhóm rỗng.
 */
export function visibleGroups(role, features = {}) {
  return GROUPS.filter((g) => !g.admin || role === 'admin')
    .map((g) => ({ ...g, items: g.items.filter((it) => (!it.admin || role === 'admin') && (!it.feature || features[it.feature] === true)) }))
    .filter((g) => g.items.length);
}

/** Đường dẫn vị trí trên đầu trang: "Hệ thống / Thương hiệu"; Tổng quan và trang lạ thì không có. */
export function crumbsFor(path) {
  if (path === '/profile') return ['Tài khoản của tôi'];
  for (const g of GROUPS) {
    const it = g.items.find((x) => x.path === path);
    if (it) return it.path === '/' ? [] : [g.label, it.text];
  }
  return [];
}

/**
 * Tách mục thanh bên cho điện thoại theo vai trò: `primary` (đúng thứ tự MOBILE_PRIMARY, nhãn ngắn),
 * `more` (mọi mục còn lại theo thứ tự thanh bên, kèm Tài khoản của tôi), `activeMore` = mục đang mở nằm trong "Thêm".
 */
export function navSplit(role, path, features = {}) {
  const items = visibleGroups(role, features).flatMap((g) => g.items.map((it) => ({ ...it, group: g.label })));
  const primary = MOBILE_PRIMARY.map((p) => items.find((it) => it.path === p)).filter(Boolean)
    .map((it) => ({ ...it, short: SHORT[it.path] || it.text }));
  const more = [...items.filter((it) => !MOBILE_PRIMARY.includes(it.path)), { path: '/profile', text: 'Tài khoản của tôi', icon: 'user', group: 'Tài khoản' }]
    .map((it) => ({ ...it, short: SHORT[it.path] || it.text }));
  return { primary, more, activeMore: more.find((it) => it.path === path) || null };
}

/** Mục "Thêm" chia theo nhóm thanh bên để menu dài vẫn dễ tìm: [{ label, items }]. */
export function moreSections(more) {
  const out = [];
  for (const it of more) {
    const last = out[out.length - 1];
    if (last && last.label === it.group) last.items.push(it); else out.push({ label: it.group, items: [it] });
  }
  return out;
}

function MobileNav({ me, path, features }) {
  const { primary, more, activeMore } = navSplit(me.role, path, features);
  const box = useRef(null);
  // Đổi trang, bấm ra ngoài hoặc Esc → gập menu "Thêm".
  useEffect(() => { if (box.current) box.current.open = false; }, [path]);
  useEffect(() => {
    const close = (e) => {
      const d = box.current;
      if (!d?.open) return;
      if (e.type === 'keydown' ? e.key === 'Escape' : !d.contains(e.target)) { d.open = false; if (e.type === 'keydown') d.querySelector('summary')?.focus(); }
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', close); };
  }, []);
  return html`<nav class="mnav" aria-label="Điều hướng chính">
    ${primary.map((it) => html`<a key=${it.path} class=${`mnav-item${path === it.path ? ' active' : ''}`} href=${`#${it.path}`}
      aria-current=${path === it.path ? 'page' : undefined}><${Icon} name=${it.icon} /><span>${it.short}</span></a>`)}
    <details class="nav-more" ref=${box}>
      <summary class=${`mnav-item${activeMore ? ' active' : ''}`} aria-label=${activeMore ? `Thêm mục — đang ở ${activeMore.text}` : 'Thêm mục'}>
        <${Icon} name=${activeMore ? activeMore.icon : 'list'} /><span>${activeMore ? activeMore.short : 'Thêm'} ▾</span></summary>
      <div class="nav-more-menu">
        ${moreSections(more).map((sec) => html`<div key=${sec.label} class="nav-more-group" role="group" aria-label=${sec.label}>
          <div class="nav-label" aria-hidden="true">${sec.label}</div>
          ${sec.items.map((it) => html`<a key=${it.path} class=${`nav-item${path === it.path ? ' active' : ''}`} href=${`#${it.path}`}
            aria-current=${path === it.path ? 'page' : undefined}><${NavIcon} path=${it.path} icon=${it.icon} /><span>${it.text}</span></a>`)}
        </div>`)}
      </div>
    </details>
  </nav>`;
}

function Sidebar({ me, brand, path, features, status, update }) {
  const link = (it) => {
    const v = navValue(it.path, status, update);
    const tip = it.path === '/chats' && status?.today && Number.isFinite(status.today.threads)
      ? `${status.today.threads} hội thoại có tin hôm nay · ${(status.today.received || 0) + (status.today.sent || 0)} tin` : undefined;
    return html`<a class=${`nav-item${path === it.path ? ' active' : ''}`} href=${`#${it.path}`} title=${tip}
      aria-current=${path === it.path ? 'page' : undefined}><${NavIcon} path=${it.path} icon=${it.icon} /><span>${it.text}</span>${v ? html`<span class="nav-val">${v}</span>` : null}</a>`;
  };
  return html`<aside class="sidebar">
    <div class="side-brand"><${BrandMark} brand=${brand} />
      <span class="side-brand-text"><span>${brand.name}</span><small>${brand.subtitle}</small></span></div>
    <${MobileNav} me=${me} path=${path} features=${features} />
    <nav class="nav" aria-label="Điều hướng chính">
      ${visibleGroups(me.role, features).map((g) => html`
        <div class="nav-group" role="group" aria-label=${g.label}>
          <div class="nav-label" aria-hidden="true">${g.label}</div>
          ${g.items.map(link)}
        </div>`)}
      <div class="nav-group nav-foot">
        <a class=${`nav-item${path === '/profile' ? ' active' : ''}`} href="#/profile" aria-current=${path === '/profile' ? 'page' : undefined}>
          <span class="avatar avatar-sm" aria-hidden="true">${me.username.slice(0, 1).toUpperCase()}</span>
          <span class="me"><span>Tài khoản của tôi</span><small>${me.username} · ${roleLabel(me.role)}</small></span>
        </a>
        <${PoweredBy} brand=${brand} />
      </div>
    </nav>
  </aside>`;
}

function Message({ icon, title, children }) {
  return html`<section class="card empty"><${Icon} name=${icon} size=${32} /><h1>${title}</h1><p class="muted">${children}</p>
    <a class="btn btn-primary" href="#/">Về Tổng quan</a></section>`;
}

export function Shell({ me, brand, path }) {
  const [status, error, refresh] = useStatus();
  const features = useFeatures();
  const update = useUpdateNotice();
  const r = ROUTES[path];
  const mainRef = useRef(null);
  const crumbs = r ? crumbsFor(path) : [];
  useEffect(() => { mainRef.current?.focus(); }, [path]);
  let body;
  if (!r) body = html`<${Message} icon="info" title="Không tìm thấy trang">Đường dẫn này không có trong dashboard.<//>`;
  else if (r.admin && me.role !== 'admin') body = html`<${Message} icon="shield" title="Không có quyền">Trang này chỉ dành cho Quản trị. Nếu cần, hãy nhờ Quản trị làm giúp.<//>`;
  else body = html`<${r.view} me=${me} status=${status} refresh=${refresh} />`;
  return html`<div class="layout">
    <${Sidebar} me=${me} brand=${brand} path=${path} features=${features} status=${status} update=${update} />
    <div class="main-col">
      <${StatusStrip} status=${status} error=${error} path=${path} admin=${me.role === 'admin'} update=${update} />
      <main class=${`content tint-${tintOf(path)}`} ref=${mainRef} tabindex="-1">
        ${crumbs.length ? html`<nav class="crumbs" aria-label="Vị trí trang"><ol>${crumbs.map((c, i) => html`<li key=${c}
          aria-current=${i === crumbs.length - 1 ? 'page' : undefined}>${c}</li>`)}</ol></nav>` : null}
        ${body}</main>
    </div>
  </div>`;
}
