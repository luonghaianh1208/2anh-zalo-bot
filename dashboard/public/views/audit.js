// Nhật ký (spec §9), gộp cả Theo dõi agent — dùng khi có lỗi hoặc cần tra lại. Mở ra là tab "Có lỗi" (7 ngày): việc
// bot làm hỏng, thao tác dashboard lỗi, công cụ AI báo lỗi. Tab khác chỉ mở khi cần: Thao tác (người trên dashboard),
// Bot gửi, Hoạt động AI (chỉ Quản trị). Mỗi mục là một câu dễ hiểu, nhóm theo ngày; Quản trị mở "Chi tiết kỹ thuật".
import { useEffect, useRef, useState } from '../vendor/hooks.mjs';
import { api } from '../api.js';
import { html, Icon, Live, PageHead, Spinner } from '../ui.js';
import { fold } from '../fold.js';
import { Trace } from './trace.js';

export function codeText(code) {
  if (!code) return '';
  return Object.entries(code).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `${k}=${v}`).join(' · ');
}

const lcFirst = (s) => (s ? s[0].toLocaleLowerCase('vi') + s.slice(1) : s);

/** Câu tự nhiên cho một mục nhật ký, chỉ từ các trường /api/audit đã trả (what, who, where, source). */
export function auditSentence(it) {
  const what = String(it.what || 'Thao tác khác');
  // Quản trị thấy mã hành động lạ (vd. "foo_bar") thay cho nhãn — giữ nguyên, không hạ chữ.
  const raw = /^[\w.-]+$/.test(what);
  if (it.source === 'dashboard') {
    const who = String(it.who || 'Ai đó').replace(/ \(dashboard\)$/, '');
    const act = raw ? `làm thao tác ${what}` : lcFirst(what);
    return `${who} ${act}${/dashboard/i.test(what) ? '' : ' trên dashboard'}.`;
  }
  const who = String(it.who || '');
  // Nơi trùng tên người yêu cầu → tin nhắn riêng với chính người đó.
  const own = it.where && it.where !== '—' && who.endsWith(` ${it.where}`);
  const where = own ? ' (nhắn riêng)' : it.where && it.where !== '—' ? ` ở ${it.where}` : '';
  let by = '';
  if (who === 'Bot (tự động)') by = ' (bot tự làm)';
  else if (/ \(dashboard\)$/.test(who)) by = `, do ${who.replace(/ \(dashboard\)$/, '')} gửi từ dashboard`;
  else if (who) by = `, theo yêu cầu của ${who}`;
  return `${raw ? `Thao tác ${what}` : what}${where}${by}.`;
}

export const AUDIT_NEXT = 'Nếu lỗi lặp lại, hãy báo người cài đặt kèm thời điểm này.';

const dayKeyFmt = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayLabelFmt = (tz) => new Intl.DateTimeFormat('vi-VN', { timeZone: tz, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });

/** Nhóm mục theo ngày (mới trước, giữ thứ tự): nhãn "Hôm nay", "Hôm qua" hoặc thứ + ngày. */
export function groupByDay(items, { now = Date.now(), tz } = {}) {
  const key = dayKeyFmt(tz);
  const today = key.format(new Date(now));
  const yesterday = key.format(new Date(now - 86_400_000));
  const out = [];
  for (const it of items) {
    const k = key.format(new Date(it.at));
    let g = out.at(-1);
    if (!g || g.key !== k) {
      const label = k === today ? 'Hôm nay' : k === yesterday ? 'Hôm qua' : dayLabelFmt(tz).format(new Date(it.at));
      g = { key: k, label: label[0].toLocaleUpperCase('vi') + label.slice(1), items: [] };
      out.push(g);
    }
    g.items.push(it);
  }
  return out;
}

export const ERROR_DAYS = 7;

/** Tab của Nhật ký; "Hoạt động AI" chỉ Quản trị. */
export function auditTabs(admin) {
  return [
    { value: 'errors', label: 'Có lỗi' },
    { value: 'dashboard', label: 'Thao tác' },
    { value: 'zalo', label: 'Bot gửi' },
    ...(admin ? [{ value: 'ai', label: 'Hoạt động AI' }] : []),
  ];
}

/** Ô tìm chung: khớp câu nhật ký (ai · làm gì · ở đâu) hoặc mục lỗi AI (nhóm, người hỏi, câu hỏi, công cụ). */
export function matches(it, q) {
  const n = fold(q || '').trim();
  if (!n) return true;
  const text = it.kind === 'ai' ? [it.chatName, it.who, it.user, ...(it.tools || [])].join(' ') : auditSentence(it);
  return fold(text).includes(n);
}

const hhmm = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function Entry({ it, admin, onOpenAi }) {
  if (it.kind === 'ai') {
    return html`<li class="audit-item">
      <time class="audit-time" datetime=${new Date(it.at).toISOString()}>${hhmm.format(new Date(it.at))}</time>
      <div class="audit-body">
        <p>Công cụ AI báo lỗi ở ${it.chatName || 'phiên không có hội thoại'}: <span class="mono">${it.tools.join(', ')}</span>.</p>
        <p class="muted small">${it.who ? `${it.who}: ` : ''}${it.user || '(không có chữ)'}</p>
        <p><button type="button" class="btn btn-ghost btn-sm" onClick=${() => onOpenAi(it.chatName)}>Xem trong Hoạt động AI</button></p>
      </div>
    </li>`;
  }
  return html`<li class="audit-item">
    <time class="audit-time" datetime=${new Date(it.at).toISOString()}>${hhmm.format(new Date(it.at))}</time>
    <div class="audit-body">
      <p>${auditSentence(it)}</p>
      ${it.ok ? null : html`<p class="audit-fail"><span class="badge badge-danger"><${Icon} name="error" size=${14} /> ${it.result}</span>
        <span class="muted small">${AUDIT_NEXT}</span></p>`}
      ${admin && it.code ? html`<details class="audit-tech"><summary>Chi tiết kỹ thuật</summary>
        <p class="mono muted small">${codeText(it.code)}</p></details>` : null}
    </div>
  </li>`;
}

function Days({ items, admin, onOpenAi }) {
  return groupByDay(items).map((g) => html`<section class="audit-day" key=${g.key}>
    <h2 class="audit-day-head">${g.label}</h2>
    <ol class="audit-list">${g.items.map((it, i) => html`<${Entry} key=${`${it.at}-${i}`} it=${it} admin=${admin} onOpenAi=${onOpenAi} />`)}</ol>
  </section>`);
}

/** Tab "Có lỗi": lỗi của bot + dashboard (máy chủ lọc) và lỗi công cụ AI (Quản trị) trong ERROR_DAYS ngày. */
function Errors({ admin, q, round, onOpenAi, onCount }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setItems(null); setError('');
    const since = Date.now() - ERROR_DAYS * 86_400_000;
    Promise.all([
      api('/api/audit?status=failed').then((r) => r.items.filter((it) => it.at >= since)),
      admin ? api(`/api/admin/trace/errors?days=${ERROR_DAYS}`).then((r) => r.errors.map((e) => ({ ...e, kind: 'ai' }))).catch(() => []) : Promise.resolve([]),
    ]).then(([a, b]) => {
      if (!alive) return;
      const all = [...a, ...b].sort((x, y) => y.at - x.at);
      setItems(all); onCount(all.length);
    }).catch((e) => { if (alive) { setItems([]); setError(e.message); } });
    return () => { alive = false; };
  }, [round]);
  if (items === null) return html`<${Live} error=${error} />${error ? null : html`<${Spinner} />`}`;
  if (!items.length) {
    return html`<${Live} error=${error} />${error ? null : html`<p class="audit-clean"><${Icon} name="check" size=${18} /> Không có lỗi nào trong ${ERROR_DAYS} ngày qua.</p>`}`;
  }
  const shown = items.filter((it) => matches(it, q));
  return html`<${Live} error=${error} />
    ${shown.length ? html`<${Days} items=${shown} admin=${admin} onOpenAi=${onOpenAi} />` : html`<p class="muted">Không có lỗi nào khớp ô tìm.</p>`}`;
}

/** Tab "Thao tác" / "Bot gửi": danh sách theo nguồn, có "Xem cũ hơn". */
function Feed({ source, admin, q, round }) {
  const [items, setItems] = useState(null);
  const [next, setNext] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const gen = useRef(0); // đổi tab/làm mới → bỏ trang "Xem cũ hơn" còn đang về của danh sách cũ
  const url = (before) => `/api/audit?source=${source}${before ? `&before=${before}` : ''}`;
  useEffect(() => {
    let alive = true;
    gen.current += 1;
    setItems(null); setError(''); setBusy(false);
    api(url(null))
      .then((r) => { if (alive) { setItems(r.items); setNext(r.nextBefore); } })
      .catch((err) => { if (alive) { setItems([]); setNext(null); setError(err.message); } });
    return () => { alive = false; };
  }, [source, round]);
  async function more() {
    if (busy || !next) return;
    const my = gen.current;
    setBusy(true); setError('');
    try {
      const r = await api(url(next));
      if (my !== gen.current) return;
      setItems((cur) => [...(cur || []), ...r.items]); setNext(r.nextBefore);
    } catch (err) { if (my === gen.current) setError(err.message); } finally { if (my === gen.current) setBusy(false); }
  }
  if (items === null) return html`<${Spinner} />`;
  const shown = items.filter((it) => matches(it, q));
  return html`<${Live} error=${error} />
    ${shown.length ? html`<${Days} items=${shown} admin=${admin} />` : error ? null : html`<p class="muted">${q ? 'Chưa thấy mục nào khớp — bấm "Xem cũ hơn" để tìm tiếp.' : 'Chưa có hoạt động nào được ghi lại.'}</p>`}
    ${next ? html`<button type="button" class="btn btn-secondary btn-sm load-more" disabled=${busy} onClick=${more}>${busy ? 'Đang tải…' : 'Xem cũ hơn'}</button>` : null}`;
}

/** Mốc "Dọn nhật ký" (khớp CLEAR_DAYS của máy chủ); 0 = xoá hết. */
export const CLEAR_CHOICES = [
  { days: 90, label: 'Cũ hơn 90 ngày' },
  { days: 30, label: 'Cũ hơn 30 ngày' },
  { days: 7, label: 'Cũ hơn 7 ngày' },
  { days: 0, label: 'Xoá tất cả' },
];

/** Dọn nhật ký (chỉ Quản trị): xoá dòng cũ của bot và dashboard. Hoạt động AI (Hermes) không đụng tới. */
function Cleaner({ onDone }) {
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({});
  async function run() {
    const what = CLEAR_CHOICES.find((c) => c.days === days).label.toLocaleLowerCase('vi');
    if (!confirm(`Dọn nhật ký: ${what}? Dòng đã xoá không lấy lại được.`)) return;
    setBusy(true); setMsg({});
    try {
      const r = await api('/api/admin/audit/clear', { method: 'POST', body: { days } });
      setMsg({ ok: r.removed ? `Đã xoá ${r.removed.toLocaleString('vi-VN')} dòng nhật ký.` : 'Không có dòng nào cần xoá.' });
      onDone();
    } catch (e) { setMsg({ error: e.message }); } finally { setBusy(false); }
  }
  return html`<details class="audit-clear">
    <summary>Dọn nhật ký</summary>
    <p class="muted">Xoá dòng cũ của bot và thao tác dashboard. Bot cũng tự xoá dòng cũ mỗi ngày theo mốc ở Cấu hình › Lưu trữ (mặc định 90 ngày).</p>
    <div class="toolbar">
      <label class="sr-only" for="audit-clear-days">Mốc dọn</label>
      <select id="audit-clear-days" value=${days} onChange=${(e) => setDays(Number(e.currentTarget.value))}>
        ${CLEAR_CHOICES.map((c) => html`<option key=${c.days} value=${c.days}>${c.label}</option>`)}
      </select>
      <button type="button" class="btn btn-danger-outline btn-sm" disabled=${busy} onClick=${run}>${busy ? 'Đang dọn…' : 'Dọn'}</button>
    </div>
    <${Live} error=${msg.error} ok=${msg.ok} />
  </details>`;
}

export function Audit({ me, tab: initial = 'errors' }) {
  const admin = me.role === 'admin';
  const tabs = auditTabs(admin);
  const [tab, setTab] = useState(tabs.some((t) => t.value === initial) ? initial : 'errors');
  const [q, setQ] = useState('');
  const [round, setRound] = useState(0);
  const [count, setCount] = useState(null);
  const openAi = (name) => { setQ(name || ''); setTab('ai'); };
  return html`
    <${PageHead} title="Nhật ký" sub="Dùng khi có lỗi hoặc cần tra lại: bot đã làm gì, ai đã đổi gì trên dashboard, AI đã tra những gì." />
    <section class="card">
      <div class="toolbar">
        <div class="chips" role="group" aria-label="Loại nhật ký">
          ${tabs.map((t) => html`<button type="button" key=${t.value} class="btn btn-secondary btn-sm chip"
            aria-pressed=${tab === t.value ? 'true' : 'false'} onClick=${() => setTab(t.value)}>
            ${t.label}${t.value === 'errors' && count ? html` <span class="badge badge-danger">${count}</span>` : null}</button>`)}
        </div>
        <label class="sr-only" for="audit-q">Tìm trong nhật ký</label>
        <input id="audit-q" type="search" placeholder="Tìm theo nhóm, người, hành động…" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} />
        ${tab === 'ai' ? null : html`<button type="button" class="btn btn-secondary btn-sm" onClick=${() => setRound(round + 1)}><${Icon} name="refresh" size=${16} /> Làm mới</button>`}
      </div>
      ${admin && tab !== 'ai' ? html`<${Cleaner} onDone=${() => setRound((n) => n + 1)} />` : null}
      ${tab === 'errors' ? html`<${Errors} admin=${admin} q=${q} round=${round} onOpenAi=${openAi} onCount=${setCount} />`
        : tab === 'ai' ? html`<${Trace} embedded q=${q} />`
          : html`<${Feed} key=${tab} source=${tab} admin=${admin} q=${q} round=${round} />`}
    </section>`;
}

/** Nhật ký mở thẳng tab "Hoạt động AI" — đường cũ /trace (Theo dõi agent) vẫn dùng được. */
export const AuditAi = (props) => html`<${Audit} ...${props} tab="ai" />`;
