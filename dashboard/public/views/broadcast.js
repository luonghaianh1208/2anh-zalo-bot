// Gửi hàng loạt: chọn nơi nhận (theo thư mục hoặc tự chọn) · nội dung · nhịp gửi · theo dõi các đợt.
// Bot chạy nền ở máy chủ nên đóng trang không làm dừng việc gửi.
import { useEffect, useRef, useState } from '../vendor/hooks.mjs';
import { api, sendFile } from '../api.js';
import { html, fmtTime, Icon, Live, Notice, PageHead, Spinner } from '../ui.js';
import { PACE_FIELDS, PACE_PRESETS, estimateText, folderTargets, previewText, targetSummary } from '../broadcast-pace.js';
import { filterOptions, flip, toggleAll } from './multi-pick.js';
import { FolderChip } from './folder-ui.js';

const MAX_TEXT = 2000;
const POLL_MS = 5000;
const WHO = [{ value: 'all', label: 'Nhóm và người' }, { value: 'groups', label: 'Chỉ nhóm' }, { value: 'people', label: 'Chỉ người' }];
const KINDS = [{ value: 'all', label: 'Tất cả' }, { value: 'groups', label: 'Nhóm' }, { value: 'people', label: 'Người' }];
const STATUS = { running: ['Đang gửi', 'badge-ok'], paused: ['Tạm dừng', 'badge-warn'], done: ['Đã xong', 'badge-idle'], cancelled: ['Đã huỷ', 'badge-idle'] };

export function waitText(job) {
  if (job.queued) return 'Đang xếp hàng sau đợt trước.';
  const at = job.wait?.until ? fmtTime(job.wait.until) : '';
  switch (job.wait?.reason) {
    case 'zalo': return 'Đang chờ Zalo kết nối lại. Bot sẽ tự gửi tiếp.';
    case 'hours': return `Ngoài khung giờ gửi, sẽ gửi tiếp lúc ${at}.`;
    case 'daily': return `Đã đủ số lượng trong ngày, sẽ gửi tiếp lúc ${at}.`;
    case 'batch': return `Đang nghỉ giữa các tốp, sẽ gửi tiếp lúc ${at}.`;
    case 'delay': return 'Đang giãn cách trước tin kế tiếp.';
    default: return '';
  }
}

function FolderPicker({ data, picked, onPick, who, onWho }) {
  if (!data.folders.length) return html`<p class="muted">Chưa có thư mục nào. Tạo thư mục ở <a href="#/permissions">Phân quyền Bot</a>, hoặc chuyển sang thẻ Tự chọn.</p>`;
  return html`<div class="chips" role="group" aria-label="Gửi cho">
      ${WHO.map((w) => html`<button key=${w.value} type="button" class="btn btn-secondary btn-sm chip" aria-pressed=${who === w.value ? 'true' : 'false'} onClick=${() => onWho(w.value)}>${w.label}</button>`)}
    </div>
    <ul class="multi-pick-list" aria-label="Chọn thư mục">
      ${data.folders.map((f) => html`<li key=${f.id}><label class="multi-pick-item">
        <input type="checkbox" checked=${picked.has(f.id)} onChange=${() => onPick(flip(picked, f.id))} />
        <${FolderChip} folder=${f} small=${false} /><small class="muted">${f.groups.length} nhóm, ${f.people.length} người</small></label></li>`)}
    </ul>`;
}

function CustomPicker({ options, picked, onPick }) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('all');
  const pool = options.filter((o) => kind === 'all' || (kind === 'groups') === (o.type === 1));
  const shown = filterOptions(pool, q);
  const allOn = shown.length > 0 && shown.every((o) => picked.has(o.uid));
  return html`<div class="multi-pick">
    <div class="chips" role="group" aria-label="Loại nơi nhận">
      ${KINDS.map((k) => html`<button key=${k.value} type="button" class="btn btn-secondary btn-sm chip" aria-pressed=${kind === k.value ? 'true' : 'false'} onClick=${() => setKind(k.value)}>${k.label}</button>`)}
    </div>
    <div class="multi-pick-bar">
      <label for="bc-q" class="sr-only">Lọc theo tên</label>
      <input id="bc-q" type="search" placeholder=${`Lọc ${pool.length} nơi theo tên`} value=${q} onInput=${(e) => setQ(e.currentTarget.value)} />
      <button type="button" class="btn btn-ghost btn-sm" disabled=${!shown.length} onClick=${() => onPick(toggleAll(picked, shown))}>
        ${allOn ? 'Bỏ chọn' : `Chọn tất cả${q.trim() ? ' (đang lọc)' : ''}`}</button>
    </div>
    <ul class="multi-pick-list" aria-label="Chọn nơi nhận">
      ${shown.map((o) => html`<li key=${o.uid}><label class="multi-pick-item">
        <input type="checkbox" checked=${picked.has(o.uid)} onChange=${() => onPick(flip(picked, o.uid))} />
        <span>${o.name || 'Chưa rõ tên'} <small class="muted">${o.note}</small></span></label></li>`)}
      ${shown.length ? null : html`<li class="muted small">Không có nơi nào khớp.</li>`}
    </ul>
  </div>`;
}

function JobCard({ job, onAct, busy }) {
  const c = job.counts;
  const done = c.sent + c.failed + c.unknown;
  const [label, cls] = STATUS[job.status] || STATUS.done;
  const open = job.status === 'running' || job.status === 'paused';
  return html`<li class="bc-job">
    <div class="bc-job-head">
      <span class=${`badge ${cls}`}>${label}</span>
      <strong class="bc-job-title">${job.text ? job.text.slice(0, 80) : job.fileName}</strong>
      <small class="muted">${fmtTime(job.createdAt)} · ${job.actor}</small>
    </div>
    <div class="bar-top"><span>Đã gửi ${c.sent}/${c.total}</span><span>${c.failed ? `${c.failed} lỗi` : ''}${c.unknown ? ` · ${c.unknown} chưa rõ` : ''}</span></div>
    <div class="bar-track"><div class=${`bar-fill bar-w-${Math.round((done / c.total) * 10)}`}></div></div>
    ${job.note ? html`<${Notice} kind="warn">${job.note}<//>` : null}
    ${job.status === 'running' && waitText(job) ? html`<p class="muted small">${waitText(job)}</p>` : null}
    ${job.issues.length ? html`<details class="bc-issues"><summary class="small">Xem ${job.issues.length} nơi chưa gửi được</summary>
      <ul class="small">${job.issues.map((i, n) => html`<li key=${n}>${i.name || 'Chưa rõ tên'}: ${i.status === 'unknown' ? 'chưa rõ đã gửi chưa' : i.error}</li>`)}</ul></details>` : null}
    ${open ? html`<div class="row-actions">
      ${job.status === 'running' ? html`<button type="button" class="btn btn-secondary btn-sm" disabled=${busy} onClick=${() => onAct(job, 'pause')}>Tạm dừng</button>`
        : html`<button type="button" class="btn btn-primary btn-sm" disabled=${busy} onClick=${() => onAct(job, 'resume')}>Tiếp tục</button>`}
      <button type="button" class="btn btn-danger-outline btn-sm" disabled=${busy} onClick=${() => onAct(job, 'cancel')}>Huỷ đợt</button>
    </div>` : null}
  </li>`;
}

function Jobs({ reload }) {
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState({});
  const [busy, setBusy] = useState(false);
  const load = () => api('/api/broadcasts').then((r) => { setData(r); setMsg((m) => (m.error ? {} : m)); }).catch((e) => setMsg({ error: e.message }));
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [reload]);
  async function act(job, action) {
    if (action === 'cancel' && !confirm(`Huỷ đợt này? ${job.counts.pending} nơi chưa gửi sẽ không nhận được tin.`)) return;
    setBusy(true); setMsg({});
    try { await api(`/api/broadcasts/${encodeURIComponent(job.id)}/${action}`, { method: 'POST' }); await load(); } catch (e) { setMsg({ error: e.message }); } finally { setBusy(false); }
  }
  return html`<section class="card">
    <h2>Các đợt gửi</h2>
    <${Live} error=${msg.error} />
    ${!data && !msg.error ? html`<${Spinner} />` : null}
    ${data ? html`<p class="muted small">Hôm nay bot đã gửi hàng loạt tới ${data.sentToday} nơi.</p>` : null}
    ${data && !data.jobs.length ? html`<p class="muted">Chưa có đợt gửi nào.</p>` : null}
    <ul class="bc-jobs">${(data?.jobs || []).map((j) => html`<${JobCard} key=${j.id} job=${j} onAct=${act} busy=${busy} />`)}</ul>
  </section>`;
}

export function Broadcast() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('folder');
  const [folders, setFolders] = useState(() => new Set());
  const [who, setWho] = useState('all');
  const [custom, setCustom] = useState(() => new Set());
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [preset, setPreset] = useState('safe');
  const [pace, setPace] = useState(PACE_PRESETS[1].pace);
  const [msg, setMsg] = useState({});
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const area = useRef(null);
  const fileInput = useRef(null);

  useEffect(() => { api('/api/broadcasts/recipients').then(setData).catch((e) => setError(e.message)); }, []);

  const options = data ? [
    ...data.groups.map((g) => ({ uid: `1:${g.id}`, id: g.id, type: 1, name: g.name, note: 'Nhóm' })),
    ...data.people.map((p) => ({ uid: `0:${p.uid}`, id: p.uid, type: 0, name: p.name, note: p.friend ? 'Bạn bè' : 'Người quen' })),
  ] : [];
  const targets = !data ? [] : tab === 'folder' ? folderTargets(data.folders, folders, who, data)
    : options.filter((o) => custom.has(o.uid)).map((o) => ({ id: o.id, type: o.type, name: o.name }));
  const presetInfo = PACE_PRESETS.find((p) => p.value === preset);
  const eta = estimateText(targets.length, pace);
  const canSend = targets.length > 0 && (text.trim() || file) && text.length <= MAX_TEXT && !busy;

  function insertName() {
    const el = area.current;
    const at = el ? el.selectionStart : text.length;
    setText(`${text.slice(0, at)}{ten}${text.slice(at)}`);
    el?.focus();
  }

  async function start(e) {
    e.preventDefault();
    if (!canSend) return;
    if (!confirm(`Gửi cho ${targets.length} nơi (${targetSummary(targets)}), ${eta}? Sau khi bắt đầu, những tin đã gửi không lấy lại được.`)) return;
    setBusy(true); setMsg({});
    try {
      const fileId = file ? (await sendFile('/api/broadcasts/file', file)).fileId : undefined;
      await api('/api/broadcasts', { method: 'POST', body: { text: text.trim(), pace, fileId, targets: targets.map(({ id, type }) => ({ id, type })) } });
      setMsg({ ok: `Đã bắt đầu gửi cho ${targets.length} nơi. Bot chạy nền, anh chị đóng trang cũng được.` });
      setText(''); setFile(null); setFolders(new Set()); setCustom(new Set()); setReload((n) => n + 1);
      if (fileInput.current) fileInput.current.value = '';
    } catch (err) { setMsg({ error: err.message }); } finally { setBusy(false); }
  }

  const errs = Object.values(data?.errors || {});
  return html`<${PageHead} title="Gửi hàng loạt" sub="Gửi một nội dung tới nhiều nhóm hoặc khách, giãn cách để giảm rủi ro cho tài khoản Zalo." />
    <${Live} error=${error} />
    ${errs.map((m) => html`<${Notice} key=${m} kind="warn">${m}<//>`)}
    ${!data && !error ? html`<${Spinner} />` : null}
    ${data ? html`<form onSubmit=${start}>
      <section class="card">
        <h2>Nơi nhận</h2>
        <div class="tabs" role="tablist" aria-label="Cách chọn nơi nhận">
          <button type="button" role="tab" class=${`tab${tab === 'folder' ? ' active' : ''}`} aria-selected=${tab === 'folder' ? 'true' : 'false'} onClick=${() => setTab('folder')}>Theo thư mục</button>
          <button type="button" role="tab" class=${`tab${tab === 'custom' ? ' active' : ''}`} aria-selected=${tab === 'custom' ? 'true' : 'false'} onClick=${() => setTab('custom')}>Tự chọn</button>
        </div>
        <div role="tabpanel">
          ${tab === 'folder' ? html`<${FolderPicker} data=${data} picked=${folders} onPick=${setFolders} who=${who} onWho=${setWho} />`
            : html`<${CustomPicker} options=${options} picked=${custom} onPick=${setCustom} />`}
        </div>
        <p class="small" aria-live="polite">${targets.length ? html`Sẽ gửi cho <strong>${targets.length} nơi</strong> (${targetSummary(targets)}).` : 'Chưa chọn nơi nhận.'}</p>
        <p class="muted small">Chỉ gửi được cho nhóm của bot và người bot đã quen: bạn bè, người từng nhắn riêng, người trong sổ hoặc thư mục.</p>
      </section>

      <section class="card">
        <h2>Nội dung</h2>
        <div class="field">
          <label for="bc-text">Tin nhắn</label>
          <textarea id="bc-text" ref=${area} rows="6" maxlength=${MAX_TEXT} value=${text} onInput=${(e) => setText(e.currentTarget.value)}></textarea>
          <small>${text.length}/${MAX_TEXT} ký tự. Dùng {ten} để chèn tên người nhận hoặc tên nhóm, chưa biết tên thì thành "bạn".</small>
        </div>
        <div class="row-actions">
          <button type="button" class="btn btn-secondary btn-sm" onClick=${insertName}>Chèn {ten}</button>
          <label class="btn btn-secondary btn-sm bc-file"><${Icon} name="clip" size=${16} /> ${file ? 'Đổi tệp' : 'Đính kèm một tệp'}
            <input ref=${fileInput} type="file" class="sr-only" onChange=${(e) => setFile(e.currentTarget.files[0] || null)} /></label>
          ${file ? html`<span class="small">${file.name}</span>
            <button type="button" class="btn btn-ghost btn-sm" onClick=${() => { setFile(null); if (fileInput.current) fileInput.current.value = ''; }}>Bỏ tệp</button>` : null}
        </div>
        ${text.trim() && targets.length ? html`<p class="muted small">Xem trước cho ${targets[0].name || 'người đầu tiên'}:</p>
          <blockquote class="bc-preview">${previewText(text, targets[0].name)}</blockquote>` : null}
      </section>

      <section class="card">
        <h2>Nhịp gửi</h2>
        <div class="chips" role="group" aria-label="Mức nhịp gửi">
          ${PACE_PRESETS.map((p) => html`<button key=${p.value} type="button" class="btn btn-secondary btn-sm chip" aria-pressed=${preset === p.value ? 'true' : 'false'}
            onClick=${() => { setPreset(p.value); setPace(p.pace); }}>${p.label}</button>`)}
        </div>
        <p class="muted small">${presetInfo ? presetInfo.hint : 'Đang dùng nhịp tự chỉnh.'} Mỗi nơi cách nhau ${pace.minDelayS} đến ${pace.maxDelayS} giây, nghỉ ${pace.batchRestMin} phút sau mỗi ${pace.batchSize} nơi, tối đa ${pace.dailyCap} nơi một ngày, chỉ gửi từ ${pace.fromHour} giờ đến ${pace.toHour} giờ.</p>
        <details>
          <summary class="small">Tuỳ chỉnh</summary>
          <div class="form-grid bc-pace">
            ${PACE_FIELDS.map((f) => html`<div class="field" key=${f.key}>
              <label for=${`bc-${f.key}`}>${f.label}</label>
              <input id=${`bc-${f.key}`} type="number" min=${f.min} max=${f.max} value=${pace[f.key]}
                onInput=${(e) => { setPreset(''); setPace({ ...pace, [f.key]: Number(e.currentTarget.value) }); }} />
            </div>`)}
          </div>
        </details>
        <${Notice} kind="warn">Zalo không công bố ngưỡng chặn nên không có mức nào đảm bảo an toàn tuyệt đối. Gửi nội dung người nhận cần, tránh gửi cho người chưa từng tương tác. Bot tự tạm dừng nếu 5 nơi liên tiếp gửi lỗi.<//>
        ${eta ? html`<p class="small">Thời gian dự kiến: <strong>${eta}</strong>.</p>` : null}
        <${Live} error=${msg.error} ok=${msg.ok} />
        <button type="submit" class="btn btn-primary" disabled=${!canSend}><${Icon} name="send" size=${16} /> ${busy ? 'Đang bắt đầu…' : targets.length ? `Bắt đầu gửi cho ${targets.length} nơi` : 'Bắt đầu gửi'}</button>
      </section>
    </form>` : null}
    <${Jobs} reload=${reload} />`;
}
