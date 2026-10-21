import { useEffect, useState } from '../vendor/hooks.mjs';
import { api } from '../api.js';
import { html, Icon, Live, PageHead, roleLabel } from '../ui.js';
import { DonateButton } from './donate.js';
import { DeviceList } from './devices.js';

export function Profile({ me, status }) {
  const [busy, setBusy] = useState('');
  const [tg, setTg] = useState({});
  const [linkUrl, setLinkUrl] = useState('');
  const [sessionMsg, setSessionMsg] = useState({});

  async function run(key, fn, setMsg) {
    setBusy(key); setMsg({});
    try { await fn(); } catch (err) { setMsg({ error: err.message }); } finally { setBusy(''); }
  }
  const link = () => run('link', async () => {
    const r = await api('/api/telegram/link', { method: 'POST' });
    setLinkUrl(r.url);
    try { window.open(r.url, '_blank', 'noopener'); } catch { /* trình duyệt chặn cửa sổ mới — đã có link bên dưới */ }
    setTg({ ok: 'Đã tạo link nối — mở Telegram, bấm "Start" (Bắt đầu) trong cuộc trò chuyện với bot để hoàn tất. Link dùng được trong 10 phút.' });
  }, setTg);
  const test = () => run('test', async () => {
    await api('/api/telegram/test', { method: 'POST' });
    setTg({ ok: 'Đã gửi tin thử — mở Telegram để kiểm tra.' });
  }, setTg);
  const logout = (all) => {
    if (all && !confirm('Đăng xuất khỏi mọi thiết bị đang đăng nhập tài khoản này?')) return;
    run(all ? 'all' : 'one', async () => {
      await api(all ? '/api/auth/logout-all' : '/api/auth/logout', { method: 'POST' });
      window.dispatchEvent(new Event('zd:logout'));
    }, setSessionMsg);
  };

  const [devices, setDevices] = useState(null);
  const [devBusy, setDevBusy] = useState('');
  const [devMsg, setDevMsg] = useState({});
  const loadDevices = () => api('/api/auth/sessions').then((r) => setDevices(r.sessions)).catch((err) => setDevMsg({ error: err.message }));
  useEffect(() => { loadDevices(); }, []);
  async function logoutDevice(s) {
    if (!confirm(`Đăng xuất ${s.device.label} khỏi tài khoản này?`)) return;
    setDevBusy(s.id); setDevMsg({});
    try { await api(`/api/auth/sessions/${encodeURIComponent(s.id)}/logout`, { method: 'POST' }); setDevMsg({ ok: `Đã đăng xuất ${s.device.label}.` }); await loadDevices(); }
    catch (err) { setDevMsg({ error: err.message }); } finally { setDevBusy(''); }
  }

  const linked = Boolean(status?.telegramLinked);
  return html`
    <${PageHead} title="Tài khoản của tôi" />
    <div class="grid grid-2">
      <section class="card account">
        <span class="avatar avatar-lg" aria-hidden="true">${me.username.slice(0, 1).toUpperCase()}</span>
        <div class="account-info">
          <h2>${me.username}</h2>
          <p class="muted">${roleLabel(me.role)}${me.zaloUid ? ' · Đã liên kết Zalo' : ' · Chưa liên kết Zalo'}</p>
        </div>
        <div class="row">
          <button class="btn btn-secondary" disabled=${!!busy} onClick=${() => logout(false)}><${Icon} name="logout" size=${16} /> Đăng xuất</button>
          <button class="btn btn-danger-outline" disabled=${!!busy} onClick=${() => logout(true)}>Đăng xuất mọi nơi</button>
        </div>
        <${Live} error=${sessionMsg.error} />
      </section>
      <section class="card">
        <h2>Thiết bị đang đăng nhập</h2>
        <p class="small muted">Thấy thiết bị lạ thì đăng xuất nó, rồi đổi mật khẩu.</p>
        ${devices ? html`<${DeviceList} sessions=${devices} busy=${devBusy} onLogout=${logoutDevice} />` : devMsg.error ? null : html`<p class="muted">Đang tải…</p>`}
        <${Live} error=${devMsg.error} ok=${devMsg.ok} />
      </section>
      <section class="card">
        <h2>Cảnh báo qua Telegram</h2>
        ${!status ? html`<p class="muted">Đang kiểm tra…</p>`
          : linked ? html`<p class="badge badge-ok"><${Icon} name="check" size=${16} /> Đã nối — bạn sẽ nhận tin khi bot gặp sự cố</p>`
            : html`<p class="badge badge-warn"><${Icon} name="warn" size=${16} /> Chưa nối — bạn chưa nhận được cảnh báo</p>`}
        <div class="row">
          <button class="btn btn-primary" disabled=${!!busy} onClick=${link}><${Icon} name="external" size=${16} />
            ${linked ? 'Nối lại Telegram' : 'Nối Telegram của tôi'}</button>
          <button class="btn btn-secondary" disabled=${!!busy || !linked} onClick=${test}><${Icon} name="send" size=${16} /> Gửi thử</button>
        </div>
        ${linkUrl ? html`<p class="link-out"><a class="btn btn-secondary btn-sm" href=${linkUrl} target="_blank" rel="noopener">
          <${Icon} name="external" size=${16} /> Mở Telegram để nối</a> <span class="small muted">nếu Telegram chưa tự mở.</span></p>` : null}
        <${Live} error=${tg.error} ok=${tg.ok} />
      </section>
      <section class="card"><h2>Ủng hộ tác giả</h2>
        <p class="small muted">Thấy bot hay và hữu ích? Ủng hộ 2Anh AI một ly cà phê qua chuyển khoản MB Bank.</p>
        <${DonateButton} className="btn btn-secondary" />
      </section>
    </div>`;
}
