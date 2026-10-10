// Bảo trì (chỉ Quản trị). Tab "Cập nhật": phiên bản bot Zalo và Hermes, kiểm tra / chạy cập nhật Hermes.
// Tab "Sao lưu": bản sao lưu cài đặt (tạo, tải về, khôi phục, xoá, khôi phục từ tệp) và điểm khôi phục của Hermes.
import { useEffect, useRef, useState } from '../vendor/hooks.mjs';
import { api, sendFile } from '../api.js';
import { html, Icon, Live, Notice, PageHead, Spinner, fmtTime } from '../ui.js';
import { RestartBanner } from './restart-banner.js';

/** 37275530 → "35,5 MB". */
export function fmtSize(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Number(n) || 0; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: i ? 1 : 0 }).format(v)} ${units[i]}`;
}

/** "20261010-134504-dashboard" (giờ máy chủ) → ngày giờ dễ đọc. */
export function snapshotTime(ts) {
  const m = /^(\d{4})(\d{2})(\d{2})[-_](\d{2})(\d{2})(\d{2})/.exec(String(ts || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : String(ts || '');
}

export const BOT_RESULT = {
  done: ['is-ok', 'Đã cập nhật xong.'],
  'rolled-back': ['is-bad', 'Cập nhật không thành công — bot đã tự quay về bản cũ và chạy bình thường.'],
  failed: ['is-bad', 'Cập nhật lỗi — báo người cài đặt kiểm tra.'],
};

/** Cập nhật bot (chỉ Quản trị thấy trang này): nút cập nhật, tiến độ (dashboard tự khởi động lại giữa chừng), kết quả. */
function BotUpdate({ bot, initial, onReload }) {
  const [st, setSt] = useState(initial || {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [offline, setOffline] = useState(false);
  const timer = useRef(0);
  useEffect(() => {
    if (!st.running) return undefined;
    timer.current = setTimeout(() => api('/api/admin/maintenance/bot-update').then((r) => {
      setOffline(false); setSt(r.botUpdate);
      if (!r.botUpdate.running) onReload();
    }).catch(() => { setOffline(true); setSt((s) => ({ ...s })); }), 3000);
    return () => clearTimeout(timer.current);
  }, [st]);
  async function start() {
    if (!confirm(`Cập nhật bot lên ${bot.latest.tag}?\n\nBot tự sao lưu trước, rồi khởi động lại (ngừng trả lời khoảng 1–3 phút). Lỗi thì tự quay về bản cũ.`)) return;
    setBusy(true); setError('');
    try { setSt((await api('/api/admin/maintenance/bot-update', { method: 'POST', body: { to: bot.latest.tag } })).botUpdate); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const result = !st.running && BOT_RESULT[st.status];
  return html`<div class="stack">
    ${bot.newer && !st.running ? html`<div class="toolbar"><button type="button" class="btn btn-primary btn-sm" disabled=${busy} onClick=${start}><${Icon} name="download" size=${14} /> ${busy ? 'Đang bắt đầu…' : `Cập nhật bot lên ${bot.latest.tag}`}</button></div>` : null}
    ${st.running ? html`<p class="ai-result is-ok">Đang cập nhật ${st.from ? `v${st.from} ` : ''}→ ${st.to}: ${st.step || '…'}${offline ? ' — dashboard đang khởi động lại, trang tự nối lại…' : ''}</p>` : null}
    ${result ? html`<p class=${`ai-result ${result[0]}`}>${result[1]} <span class="muted">(${st.from ? `v${st.from}` : ''} → ${st.to}, ${fmtTime(st.finishedAt)})</span>${st.error ? html`<br /><small>${st.error}</small>` : null}</p>` : null}
    ${st.log ? html`<details open=${st.running}><summary class="small">Nhật ký cập nhật bot</summary><pre class="skill-md">${st.log}</pre></details>` : null}
    <${Live} error=${error} />
  </div>`;
}

export const CHECK_TEXT ={ available: 'Có bản Hermes mới', current: 'Hermes đang là bản mới nhất', unknown: 'Chưa rõ — xem nhật ký máy chủ' };

function Updates({ data, onReload }) {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState({});
  const [update, setUpdate] = useState(data.update);
  const timer = useRef(0);
  useEffect(() => {
    if (!update?.running) return undefined;
    timer.current = setTimeout(() => api('/api/admin/maintenance/hermes-update').then((r) => { setUpdate(r.update); if (!r.update.running) onReload(); }).catch(() => {}), 3000);
    return () => clearTimeout(timer.current);
  }, [update]);
  async function check() {
    setBusy('check'); setMsg({});
    try { await api('/api/admin/maintenance/hermes-check', { method: 'POST' }); onReload(); } catch (e) { setMsg({ error: e.message }); } finally { setBusy(''); }
  }
  async function runUpdate() {
    if (!confirm('Cập nhật Hermes ngay? Hermes tự sao lưu trước, rồi khởi động lại trợ lý — bot ngừng trả lời vài phút.')) return;
    setBusy('update'); setMsg({});
    try { setUpdate((await api('/api/admin/maintenance/hermes-update', { method: 'POST' })).update); } catch (e) { setMsg({ error: e.message }); } finally { setBusy(''); }
  }
  const { bot, hermes } = data;
  return html`<div class="stack">
    <div class="card-sub"><h3>Bot Zalo (2anh-zalo-bot)</h3>
      <p>Đang dùng: <strong>${bot.version ? `v${bot.version}` : 'chưa rõ'}</strong>${bot.latest?.tag ? html` · Mới nhất: <strong>${bot.latest.tag}</strong>` : ' · chưa xem được bản mới nhất (mất mạng?)'}</p>
      ${bot.newer || data.botUpdate?.running ? null : bot.latest?.tag ? html`<p class="muted small">Bot đang là bản mới nhất.</p>` : null}
      <${BotUpdate} bot=${bot} initial=${data.botUpdate} onReload=${onReload} />
      ${bot.latest?.notes ? html`<details><summary class="small">Có gì mới trong ${bot.latest.tag}</summary><p class="small mem-text">${bot.latest.notes}</p></details>` : null}
    </div>
    <div class="card-sub"><h3>Hermes Agent</h3>
      <p class="small">${hermes.version || 'Chưa đọc được phiên bản Hermes.'}</p>
      ${hermes.check ? html`<p class=${`ai-result ${hermes.check.status === 'available' ? 'is-bad' : 'is-ok'}`}>${CHECK_TEXT[hermes.check.status]} <span class="muted">(kiểm lúc ${fmtTime(hermes.check.at)})</span></p>` : null}
      <div class="toolbar">
        <button type="button" class="btn btn-secondary btn-sm" disabled=${busy !== '' || update?.running} onClick=${check}><${Icon} name="refresh" size=${14} /> ${busy === 'check' ? 'Đang kiểm tra…' : 'Kiểm tra bản mới'}</button>
        ${hermes.check?.status === 'available' || update?.running ? html`<button type="button" class="btn btn-primary btn-sm" disabled=${busy !== '' || update?.running} onClick=${runUpdate}>${update?.running ? 'Đang cập nhật…' : 'Cập nhật Hermes'}</button>` : null}
      </div>
      ${update?.startedAt ? html`<details open=${update.running}><summary class="small">${update.running ? 'Đang cập nhật — nhật ký' : `Lần cập nhật gần nhất (${fmtTime(update.startedAt)})`}</summary><pre class="skill-md">${update.log || '(chưa có dòng nào)'}</pre></details>` : null}
    </div>
    <${Live} error=${msg.error} ok=${msg.ok} />
  </div>`;
}

function Backups({ data, onReload, onRestored }) {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState({});
  const act = async (key, fn, ok) => {
    setBusy(key); setMsg({});
    try { const r = await fn(); setMsg({ ok: typeof ok === 'function' ? ok(r) : ok }); onReload(); } catch (e) { setMsg({ error: e.message }); } finally { setBusy(''); }
  };
  const restoreText = (r) => `Đã khôi phục ${r.restored} tệp (bản hiện trạng trước đó đã lưu: ${r.before}). Khởi động lại trợ lý để áp dụng.`;
  const create = () => act('create', () => api('/api/admin/backups', { method: 'POST' }), (r) => `Đã tạo ${r.file} (${fmtSize(r.size)}).`);
  const restore = (b) => confirm(`Khôi phục cài đặt từ ${b.file}? Cài đặt hiện tại được lưu thành một bản riêng trước.`)
    && act(b.file, () => api(`/api/admin/backups/${encodeURIComponent(b.file)}/restore`, { method: 'POST' }), (r) => { onRestored(); return restoreText(r); });
  const remove = (b) => confirm(`Xoá bản sao lưu ${b.file}?`) && act(b.file, () => api(`/api/admin/backups/${encodeURIComponent(b.file)}/remove`, { method: 'POST' }), 'Đã xoá.');
  async function upload(e) {
    const file = e.currentTarget.files?.[0]; e.currentTarget.value = '';
    if (!file || !confirm(`Khôi phục cài đặt từ tệp ${file.name}? Cài đặt hiện tại được lưu thành một bản riêng trước.`)) return;
    act('upload', () => sendFile('/api/admin/backups-upload/restore', file), (r) => { onRestored(); return restoreText(r); });
  }
  const snapCreate = () => act('snap', () => api('/api/admin/snapshots', { method: 'POST' }), 'Đã tạo điểm khôi phục.');
  const snapRestore = (s) => confirm(`Đưa trợ lý về điểm khôi phục ${snapshotTime(s.timestamp || s.id)}? Cấu hình, khoá, lịch hẹn và lịch sử trò chuyện sẽ quay về lúc đó.`)
    && act(s.id, () => api(`/api/admin/snapshots/${encodeURIComponent(s.id)}/restore`, { method: 'POST' }), () => { onRestored(); return 'Đã khôi phục. Khởi động lại trợ lý ngay để áp dụng.'; });
  return html`<div class="stack">
    <${Live} error=${msg.error} ok=${msg.ok} />
    <div class="card-sub"><h3>Bản sao lưu cài đặt</h3>
      <p class="muted small">Gồm cấu hình, khoá API (.env), tính cách (SOUL), trí nhớ, skill, phân quyền và sổ người quen Zalo, tài khoản dashboard, lịch hẹn. Không gồm lịch sử trò chuyện. Tệp chứa khoá — giữ kín. Máy chủ giữ 5 bản gần nhất.</p>
      <div class="toolbar">
        <button type="button" class="btn btn-primary btn-sm" disabled=${busy !== ''} onClick=${create}><${Icon} name="plus" size=${14} /> ${busy === 'create' ? 'Đang sao lưu…' : 'Tạo bản sao lưu'}</button>
        <label class="btn btn-secondary btn-sm"><input type="file" class="sr-only" accept=".zip" disabled=${busy !== ''} onChange=${upload} />${busy === 'upload' ? 'Đang khôi phục…' : 'Khôi phục từ tệp…'}</label>
      </div>
      ${data.backups.length ? html`<ul class="row-list">${data.backups.map((b) => html`<li key=${b.file} class="row-item">
        <span class="row-main"><strong class="mono">${b.file}</strong><small class="muted">${fmtTime(b.at)} · ${fmtSize(b.size)}</small></span>
        <span class="key-actions">
          <a class="btn btn-secondary btn-sm" href=${`/api/admin/backups/${encodeURIComponent(b.file)}`} download><${Icon} name="download" size=${14} /> Tải về</a>
          <button type="button" class="btn btn-secondary btn-sm" disabled=${busy !== ''} onClick=${() => restore(b)}>${busy === b.file ? 'Đang khôi phục…' : 'Khôi phục'}</button>
          <button type="button" class="btn btn-ghost btn-sm" aria-label=${`Xoá ${b.file}`} disabled=${busy !== ''} onClick=${() => remove(b)}><${Icon} name="close" size=${14} /></button>
        </span></li>`)}</ul>` : html`<p class="muted small">Chưa có bản sao lưu nào.</p>`}
    </div>
    ${data.snapshots ? html`<div class="card-sub"><h3>Điểm khôi phục của Hermes</h3>
      <p class="muted small">Bản chụp nhanh gồm cả lịch sử trò chuyện. Hermes tự tạo trước mỗi lần cập nhật.</p>
      <div class="toolbar"><button type="button" class="btn btn-secondary btn-sm" disabled=${busy !== ''} onClick=${snapCreate}>${busy === 'snap' ? 'Đang tạo…' : 'Tạo điểm khôi phục'}</button></div>
      ${data.snapshots.length ? html`<ul class="row-list">${data.snapshots.map((s) => html`<li key=${s.id} class="row-item">
        <span class="row-main"><strong>${snapshotTime(s.timestamp || s.id)}</strong><small class="muted">${s.label || ''}${s.label ? ' · ' : ''}${s.files} tệp · ${fmtSize(s.size)}</small></span>
        <button type="button" class="btn btn-secondary btn-sm" disabled=${busy !== ''} onClick=${() => snapRestore(s)}>${busy === s.id ? 'Đang khôi phục…' : 'Khôi phục'}</button></li>`)}</ul>`
        : html`<p class="muted small">Chưa có điểm khôi phục nào.</p>`}
    </div>` : null}
  </div>`;
}

const TAB_KEY = 'zd-maint-tab';
export function Maintenance() {
  const [tab, setTab] = useState(() => { try { return localStorage.getItem(TAB_KEY) === 'backup' ? 'backup' : 'update'; } catch { return 'update'; } });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [rev, setRev] = useState(0);
  const load = () => api('/api/admin/maintenance').then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const pick = (t) => { setTab(t); try { localStorage.setItem(TAB_KEY, t); } catch { /* tiện ích */ } };
  return html`<${PageHead} title="Bảo trì" sub="Phiên bản và cập nhật, sao lưu và khôi phục cài đặt của trợ lý. Chỉ Quản trị." />
    <${RestartBanner} version=${rev} />
    <section class="card">
      <div class="chips" role="group" aria-label="Mục">
        <button type="button" class="btn btn-secondary btn-sm chip" aria-pressed=${tab === 'update' ? 'true' : 'false'} onClick=${() => pick('update')}>Cập nhật</button>
        <button type="button" class="btn btn-secondary btn-sm chip" aria-pressed=${tab === 'backup' ? 'true' : 'false'} onClick=${() => pick('backup')}>Sao lưu</button>
      </div>
      <${Live} error=${error} />
      ${!data && !error ? html`<${Spinner} />` : null}
      ${data ? (tab === 'update' ? html`<${Updates} key=${data.update?.startedAt || 0} data=${data} onReload=${load} />` : html`<${Backups} data=${data} onReload=${load} onRestored=${() => setRev((r) => r + 1)} />`) : null}
    </section>`;
}
