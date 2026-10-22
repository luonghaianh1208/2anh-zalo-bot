// Skill (kỹ năng) của trợ lý — chỉ Quản trị. Tab "Đã cài": bật/tắt trên Zalo, xem nội dung, gỡ skill cài thêm.
// Tab "Thêm skill": tải lên .zip / SKILL.md, danh mục chính thức của Hermes, tìm trên kho cộng đồng. Mọi skill
// cài thêm đều qua bộ quét an toàn của Hermes; skill bị chặn không cài được từ đây.
import { useEffect, useState } from '../vendor/hooks.mjs';
import { api, sendFile } from '../api.js';
import { html, Dialog, Icon, Live, Notice, PageHead, Spinner } from '../ui.js';
import { fold } from '../fold.js';
import { RestartBanner } from './restart-banner.js';
import { BulkBar, bulkMessage, flip, stillPicked } from './multi-pick.js';
import { SKILL_DOMAINS, SKILL_USES, countTags, filterChips, filterSkills, viSkill } from '../skills-vi.js';

export const ORIGIN = { bundled: 'Có sẵn', local: 'Tự tạo', hub: 'Từ kho', upload: 'Tải lên' };
export const TRUST = { builtin: 'Chính thức', trusted: 'Tin cậy', community: 'Cộng đồng' };
export const VERDICT = { safe: ['ok', 'An toàn'], caution: ['warn', 'Cần cân nhắc'], dangerous: ['danger', 'Nguy hiểm'] };
const SEVERITY = { critical: 'nghiêm trọng', high: 'cao', medium: 'vừa', low: 'thấp' };

/** Skill đã chọn cần đổi sang `enabled` (bỏ skill đã đúng trạng thái và skill lõi luôn bật). */
export function skillsToToggle(list, picked, enabled) {
  return list.filter((s) => picked.includes(s.name) && !s.essential && s.enabled !== enabled);
}

/** Câu kết luận quét an toàn cho người không rành kỹ thuật. */
export function scanText(scan) {
  if (!scan) return '';
  const n = Object.values(scan.counts || {}).reduce((a, b) => a + b, 0);
  const found = n ? ` — ${n} điểm cần chú ý` : '';
  if (scan.policy === 'allow') return `Đạt kiểm tra an toàn${found}.`;
  return `Không cài được: bộ quét đánh giá “${VERDICT[scan.verdict]?.[1] || scan.verdict}” với nguồn ${TRUST[scan.trust] || scan.trust}${found}.`;
}

function ScanResult({ scan }) {
  if (!scan) return null;
  return html`<div class=${`ai-result ${scan.policy === 'allow' ? 'is-ok' : 'is-bad'}`}><p class="small">${scanText(scan)}</p>
    ${scan.findings?.length ? html`<details><summary class="small">Chi tiết ${scan.findings.length} điểm</summary><ul class="small">
      ${scan.findings.map((f, i) => html`<li key=${i}>[${SEVERITY[f.severity] || f.severity}] ${f.description} <span class="muted mono">${f.file}${f.line ? `:${f.line}` : ''}</span></li>`)}</ul></details>` : null}</div>`;
}

/** Xem nội dung một skill đã cài. */
function ViewDialog({ name, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api(`/api/admin/skills/view?name=${encodeURIComponent(name)}`).then(setData).catch((e) => setError(e.message)); }, [name]);
  return html`<${Dialog} title=${`Skill — ${name}`} onClose=${onClose} wide>
    <${Live} error=${error} />${!data && !error ? html`<${Spinner} />` : null}
    ${data ? html`${data.files?.length > 1 ? html`<p class="muted small">Gồm ${data.files.length} tệp: ${data.files.slice(0, 8).join(', ')}${data.files.length > 8 ? '…' : ''}</p>` : null}
      <pre class="skill-md">${data.content}${data.truncated ? '\n…' : ''}</pre>` : null}
  <//>`;
}

/** Xem trước một skill trên kho → kiểm tra an toàn → cài. */
function HubDialog({ item, onInstalled, onClose }) {
  const [data, setData] = useState(null);
  const [scan, setScan] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const id = `${encodeURIComponent(item.identifier)}&source=${encodeURIComponent(item.source || '')}`;
  useEffect(() => { api(`/api/admin/skills/hub/preview?id=${id}`).then(setData).catch((e) => setError(e.message)); }, [id]);
  async function check() {
    setBusy('scan'); setError('');
    try { setScan(await api(`/api/admin/skills/hub/scan?id=${id}`)); } catch (e) { setError(e.message); } finally { setBusy(''); }
  }
  async function install() {
    setBusy('install'); setError('');
    try { const r = await api('/api/admin/skills/hub/install', { method: 'POST', body: { identifier: item.identifier, source: item.source || '' } }); onInstalled(`Đã cài skill ${r.name}. Khởi động lại trợ lý để trợ lý thấy skill mới.`); } catch (e) { setError(e.message); setBusy(''); }
  }
  return html`<${Dialog} title=${`Skill trên kho — ${item.name}`} onClose=${onClose} wide>
    <div class="stack">
      <p class="small">${item.description}</p>
      <p class="muted small">Nguồn: ${TRUST[item.trust] || item.trust} · <span class="mono">${item.identifier}</span></p>
      ${!data && !error ? html`<${Spinner} label="Đang tải nội dung…" />` : null}
      ${data ? html`<details><summary class="small">Xem nội dung SKILL.md${data.files?.length > 1 ? ` (+${data.files.length - 1} tệp)` : ''}</summary><pre class="skill-md">${data.content}</pre></details>` : null}
      <${ScanResult} scan=${scan} />
      <${Live} error=${error} />
      <div class="dialog-actions">
        ${item.installed ? html`<span class="badge badge-ok">Đã cài</span>` : html`
          <button type="button" class="btn btn-secondary" disabled=${busy !== ''} onClick=${check}>${busy === 'scan' ? 'Đang kiểm tra…' : 'Kiểm tra an toàn'}</button>
          <button type="button" class="btn btn-primary" disabled=${busy !== '' || (scan && scan.policy !== 'allow')} onClick=${install}>${busy === 'install' ? 'Đang cài…' : 'Cài skill'}</button>`}
      </div>
      ${item.installed ? null : html`<small class="muted">Khi cài, Hermes luôn quét an toàn lại; skill bị đánh giá không an toàn sẽ không được cài.</small>`}
    </div>
  <//>`;
}

const DOMAIN_LABEL = Object.fromEntries([...SKILL_DOMAINS, ['khac', 'Khác']]);

/** Hai hàng nút lọc: lĩnh vực và mục đích dùng; số cạnh nhãn là số skill khớp khi kết hợp với hàng còn lại. */
function SkillFilters({ list, domain, use, onDomain, onUse }) {
  const byDomain = filterSkills(list, { use });
  const byUse = filterSkills(list, { domain });
  const row = (label, chips, value, set) => html`<div class="skill-filter-row" role="group" aria-label=${`Lọc theo ${label.toLowerCase()}`}>
    <span class="skill-filter-label">${label}</span>
    <div class="chips">${chips.map(([id, text, n]) => html`<button key=${id} type="button" class="btn btn-secondary btn-sm chip"
      aria-pressed=${value === id ? 'true' : 'false'} onClick=${() => set(value === id && id !== 'all' ? 'all' : id)}>${text} <span class="chip-count">${n}</span></button>`)}</div></div>`;
  return html`<div class="skill-filters">
    ${row('Lĩnh vực', filterChips(byDomain.length, SKILL_DOMAINS, countTags(byDomain, 'domains')), domain, onDomain)}
    ${row('Mục đích', filterChips(byUse.length, SKILL_USES, countTags(byUse, 'uses')), use, onUse)}
  </div>`;
}

const DomainTags = ({ s }) => html`<div class="skill-tags">${s.domains.map((d) => html`<span key=${d} class="tag">${DOMAIN_LABEL[d] || d}</span>`)}</div>`;

function HubCard({ s, onOpen }) {
  return html`<li class="skill-card">
    <div class="skill-card-head"><strong class="skill-name">${s.name}</strong>
      <span class=${`badge badge-${s.trust === 'community' ? 'warn' : 'idle'}`}>${TRUST[s.trust] || s.trust}</span></div>
    <p class="skill-desc clamp-3" title=${s.descVi}>${s.descVi}</p>
    <${DomainTags} s=${s} />
    <div class="skill-card-actions">${s.installed ? html`<span class="badge badge-ok">Đã cài</span>` : null}
      <button type="button" class="btn btn-secondary btn-sm" onClick=${() => onOpen(s)}>Xem</button></div>
  </li>`;
}

function Installed({ onChanged }) {
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState({});
  const [view, setView] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  const [domain, setDomain] = useState('all');
  const [use, setUse] = useState('all');
  const load = () => api('/api/admin/skills').then((r) => setList(r.skills)).catch((e) => setMsg({ error: e.message }));
  useEffect(() => { load(); }, []);
  async function toggle(s, enabled) {
    const everywhere = enabled && s.offEverywhere;
    if (everywhere && !confirm(`${s.name} đang tắt cho mọi nơi (cả dòng lệnh, Telegram). Bật lại ở mọi nơi?`)) return;
    setBusy(s.name); setMsg({});
    try { await api('/api/admin/skills/toggle', { method: 'PUT', body: { name: s.name, enabled, everywhere } }); setList((l) => l.map((x) => (x.name === s.name ? { ...x, enabled, offEverywhere: enabled ? false : x.offEverywhere } : x)));
      setMsg({ ok: `${enabled ? 'Đã bật' : 'Đã tắt'} ${s.name} — áp dụng từ cuộc trò chuyện mới.` }); } catch (e) { setMsg({ error: e.message }); } finally { setBusy(''); }
  }
  async function toggleMany(enabled) {
    const items = skillsToToggle(list || [], sel, enabled);
    if (!items.length) { setMsg({ ok: `Các skill đã chọn đều đang ${enabled ? 'bật' : 'tắt'}.` }); return; }
    const everywhere = enabled && items.some((s) => s.offEverywhere);
    if (everywhere && !confirm('Có skill đang tắt cho mọi nơi (cả dòng lệnh, Telegram). Bật lại ở mọi nơi?')) return;
    setBusy('bulk'); setMsg({});
    try {
      const r = await api('/api/admin/skills/toggle-many', { method: 'PUT', body: { names: items.map((s) => s.name), enabled, everywhere } });
      setPicked(new Set());
      const m = bulkMessage(r, { verb: enabled ? 'Đã bật' : 'Đã tắt', unit: 'skill', name: (f) => f.name });
      setMsg({ ...m, ok: m.ok && `${m.ok.slice(0, -1)} — áp dụng từ cuộc trò chuyện mới.` });
      await load();
    } catch (e) { setMsg({ error: e.message }); } finally { setBusy(''); }
  }
  async function remove(s) {
    if (!confirm(`Gỡ hẳn skill ${s.name}? Muốn dùng lại phải cài lại.`)) return;
    setBusy(s.name); setMsg({});
    try { await api('/api/admin/skills/uninstall', { method: 'POST', body: { name: s.lockName } }); setMsg({ ok: `Đã gỡ ${s.name}.` }); onChanged(); await load(); } catch (e) { setMsg({ error: e.message }); } finally { setBusy(''); }
  }
  const n = fold(q).trim();
  const all = (list || []).map(viSkill);
  const shown = filterSkills(all, { domain, use, q: n, fold });
  const on = (list || []).filter((s) => s.enabled).length;
  const pickable = shown.filter((s) => !s.essential).map((s) => ({ uid: s.name }));
  const sel = stillPicked(picked, (list || []).map((s) => ({ uid: s.name })));
  return html`<div class="stack">
    <div class="toolbar"><label class="sr-only" for="skill-q">Tìm skill</label>
      <input id="skill-q" type="search" placeholder="Tìm theo tên hoặc mô tả…" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} />
      ${list ? html`<small class="muted">${on}/${list.length} skill đang bật trên Zalo</small>` : null}</div>
    ${list ? html`<${SkillFilters} list=${all} domain=${domain} use=${use} onDomain=${setDomain} onUse=${setUse} />` : null}
    <${Live} error=${msg.error} ok=${msg.ok} />
    ${!list && !msg.error ? html`<${Spinner} />` : null}
    ${list && !shown.length ? html`<p class="muted">Không có skill nào khớp.</p>` : null}
    ${pickable.length > 1 ? html`<${BulkBar} shown=${pickable} picked=${new Set(sel)} onPick=${setPicked} filtered=${Boolean(n) || domain !== 'all' || use !== 'all'} unit="skill">
      <button type="button" class="btn btn-secondary btn-sm" disabled=${busy !== ''} onClick=${() => toggleMany(true)}>Bật ${sel.length} skill</button>
      <button type="button" class="btn btn-secondary btn-sm" disabled=${busy !== ''} onClick=${() => toggleMany(false)}>Tắt ${sel.length} skill</button><//>` : null}
    <ul class="skill-grid">${shown.map((s) => html`<li key=${s.name} class=${`skill-card${s.enabled ? '' : ' is-off'}`}>
      <div class="skill-card-head">
        ${pickable.length > 1 ? html`<input type="checkbox" class="bulk-check" checked=${picked.has(s.name)} disabled=${busy !== '' || s.essential}
          aria-label=${`Chọn ${s.name}`} onChange=${() => setPicked(flip(picked, s.name))} />` : null}
        <strong class="skill-name">${s.name}</strong>
        <label class="check skill-toggle"><input type="checkbox" checked=${s.enabled} disabled=${busy !== '' || s.essential}
          aria-label=${`Bật ${s.name} trên Zalo`} onChange=${(e) => toggle(s, e.currentTarget.checked)} />Bật</label>
      </div>
      <p class="skill-desc clamp-3" title=${s.descVi}>${s.descVi}</p>
      <${DomainTags} s=${s} />
      <small class="muted">${ORIGIN[s.origin] || s.origin}${s.usage ? ` · đã dùng ${s.usage} lần` : ''}${s.essential ? ' · lõi Hermes, luôn bật' : ''}${s.offEverywhere ? ' · đang tắt cho mọi nơi' : ''}</small>
      <div class="skill-card-actions">
        <button type="button" class="btn btn-ghost btn-sm" onClick=${() => setView(s.name)}>Xem</button>
        ${s.lockName ? html`<button type="button" class="btn btn-ghost btn-sm skill-remove" aria-label=${`Gỡ skill ${s.name}`} disabled=${busy !== ''} onClick=${() => remove(s)}><${Icon} name="close" size=${14} /> Gỡ</button>` : null}
      </div>
    </li>`)}</ul>
    ${view ? html`<${ViewDialog} name=${view} onClose=${() => setView('')} />` : null}
  </div>`;
}

function AddSkill({ onChanged }) {
  const [official, setOfficial] = useState(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(null);
  const [upload, setUpload] = useState({});
  const [msg, setMsg] = useState({});
  const [domain, setDomain] = useState('all');
  const [use, setUse] = useState('all');
  useEffect(() => { api('/api/admin/skills/hub/official').then((r) => setOfficial(r.skills)).catch((e) => setMsg({ error: e.message })); }, []);
  const n = fold(q).trim();
  async function search(e) {
    e.preventDefault(); if (!q.trim()) return;
    setSearching(true); setMsg({});
    try { setResults((await api(`/api/admin/skills/hub/search?q=${encodeURIComponent(q.trim())}`)).results); } catch (err) { setMsg({ error: err.message }); } finally { setSearching(false); }
  }
  async function pickFile(e) {
    const file = e.currentTarget.files?.[0]; e.currentTarget.value = '';
    if (!file) return;
    setUpload({ busy: true });
    try {
      const r = await sendFile('/api/admin/skills/upload', file);
      setUpload({ scan: r.scan, ok: r.installed ? `Đã cài skill ${r.name}. Khởi động lại trợ lý để trợ lý thấy skill mới.` : '' });
      if (r.installed) onChanged();
    } catch (err) { setUpload({ error: err.message }); }
  }
  const installed = (text) => { setOpen(null); setMsg({ ok: text }); onChanged(); setOfficial((o) => o && o.map((s) => (s.identifier === open?.identifier ? { ...s, installed: true } : s))); };
  const officialAll = (official || []).map(viSkill);
  const officialShown = filterSkills(officialAll, { domain, use, q: n, fold });
  return html`<div class="stack">
    <div class="card-sub"><h3>Tải lên skill của bạn</h3>
      <p class="muted small">Tệp .zip chứa SKILL.md (kèm thư mục tài liệu, mẫu nếu có), hoặc một tệp SKILL.md. Tối đa 8 MB.</p>
      <label class="btn btn-secondary btn-sm"><input type="file" class="sr-only" accept=".zip,.md" disabled=${upload.busy} onChange=${pickFile} />${upload.busy ? 'Đang kiểm tra và cài…' : 'Chọn tệp…'}</label>
      <${ScanResult} scan=${upload.scan} /><${Live} error=${upload.error} ok=${upload.ok} /></div>
    <${Live} error=${msg.error} ok=${msg.ok} />
    <form class="toolbar" onSubmit=${search}><label class="sr-only" for="hub-q">Tìm skill</label>
      <input id="hub-q" type="search" placeholder="Lọc danh mục chính thức, hoặc gõ rồi Enter để tìm cả kho cộng đồng…" value=${q} onInput=${(e) => { setQ(e.currentTarget.value); setResults(null); }} />
      <button class="btn btn-secondary btn-sm" disabled=${searching || !q.trim()}><${Icon} name="search" size=${14} /> ${searching ? 'Đang tìm…' : 'Tìm trên kho'}</button></form>
    ${results ? html`<div><h3>Kết quả trên kho <small class="muted">${results.length}</small></h3>
      ${results.length ? html`<${Notice} kind="warn">Skill “Cộng đồng” do người ngoài viết — đọc nội dung và bấm Kiểm tra an toàn trước khi cài.<//>` : html`<p class="muted">Không tìm thấy.</p>`}
      <ul class="skill-grid">${results.map(viSkill).map((s) => html`<${HubCard} key=${s.identifier} s=${s} onOpen=${setOpen} />`)}</ul></div>` : null}
    <div><h3>Danh mục chính thức của Hermes ${official ? html`<small class="muted">${officialShown.length}</small>` : null}</h3>
      ${!official && !msg.error ? html`<${Spinner} />` : null}
      ${official ? html`<${SkillFilters} list=${officialAll} domain=${domain} use=${use} onDomain=${setDomain} onUse=${setUse} />` : null}
      ${official && !officialShown.length ? html`<p class="muted">Không có skill nào khớp — thử bỏ bớt bộ lọc.</p>` : null}
      <ul class="skill-grid">${officialShown.map((s) => html`<${HubCard} key=${s.identifier} s=${s} onOpen=${setOpen} />`)}</ul></div>
    ${open ? html`<${HubDialog} item=${open} onInstalled=${installed} onClose=${() => setOpen(null)} />` : null}
  </div>`;
}

const TAB_KEY = 'zd-skills-tab';
export function Skills() {
  const [tab, setTab] = useState(() => { try { return localStorage.getItem(TAB_KEY) === 'add' ? 'add' : 'installed'; } catch { return 'installed'; } });
  const [rev, setRev] = useState(0);
  const pick = (t) => { setTab(t); try { localStorage.setItem(TAB_KEY, t); } catch { /* tiện ích */ } };
  return html`<${PageHead} title="Skill" sub="Bộ hướng dẫn chuyên môn trợ lý mở ra khi cần (soạn văn bản, làm báo cáo…). Tắt bớt skill không dùng để trợ lý gọn hơn. Chỉ Quản trị." />
    <${RestartBanner} version=${rev} />
    <section class="card">
      <div class="chips" role="group" aria-label="Mục">
        <button type="button" class="btn btn-secondary btn-sm chip" aria-pressed=${tab === 'installed' ? 'true' : 'false'} onClick=${() => pick('installed')}>Đã cài</button>
        <button type="button" class="btn btn-secondary btn-sm chip" aria-pressed=${tab === 'add' ? 'true' : 'false'} onClick=${() => pick('add')}>Thêm skill</button>
      </div>
      ${tab === 'installed' ? html`<${Installed} onChanged=${() => setRev((r) => r + 1)} />` : html`<${AddSkill} onChanged=${() => setRev((r) => r + 1)} />`}
    </section>`;
}
