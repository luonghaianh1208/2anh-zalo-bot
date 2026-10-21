import { useEffect, useRef, useState } from '../vendor/hooks.mjs';
import { api } from '../api.js';
import { html, Icon, Live, PageHead, Spinner, fmtTime, roleLabel } from '../ui.js';
import { DeviceList } from './devices.js';

const EMPTY = { username: '', role: 'owner', zaloUid: '', password: '' };

function AddUser({ onAdded }) {
  const [f, setF] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({});
  const bind = (k) => ({ value: f[k], onInput: (e) => setF({ ...f, [k]: e.currentTarget.value }) });

  async function submit(e) {
    e.preventDefault();
    if (!f.zaloUid.trim() && !f.password) { setMsg({ error: 'Cần UID Zalo hoặc mật khẩu để người này đăng nhập được — điền ít nhất một ô.' }); return; }
    setBusy(true); setMsg({});
    try {
      const r = await api('/api/admin/users', { method: 'POST', body: { ...f, username: f.username.trim(), zaloUid: f.zaloUid.trim() } });
      setF(EMPTY); setMsg({ ok: `Đã tạo tài khoản ${r.user.username} (${roleLabel(r.user.role)}).` });
      onAdded();
    } catch (err) { setMsg({ error: err.message }); } finally { setBusy(false); }
  }

  return html`<section class="card">
    <h2>Thêm người dùng</h2>
    <form class="form-grid" onSubmit=${submit} novalidate>
      <div class="field">
        <label for="nu-user">Tên đăng nhập</label>
        <input id="nu-user" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="nu-user-help" ...${bind('username')} />
        <small id="nu-user-help">3–32 ký tự: chữ thường, số, dấu . _ -</small>
      </div>
      <div class="field">
        <label for="nu-role">Vai trò</label>
        <select id="nu-role" ...${bind('role')}>
          <option value="owner">Chủ bot</option>
          <option value="admin">Quản trị</option>
        </select>
        <small>Chủ bot không thấy mục Quản trị.</small>
      </div>
      <div class="field">
        <label for="nu-uid">UID Zalo</label>
        <input id="nu-uid" inputmode="numeric" autocomplete="off" aria-describedby="nu-uid-help" ...${bind('zaloUid')} />
        <small id="nu-uid-help">Để đăng nhập bằng mã gửi qua Zalo.</small>
      </div>
      <div class="field">
        <label for="nu-pass">Mật khẩu <span class="muted">(không bắt buộc)</span></label>
        <input id="nu-pass" type="password" autocomplete="new-password" aria-describedby="nu-pass-help" ...${bind('password')} />
        <small id="nu-pass-help">Ít nhất 8 ký tự.</small>
      </div>
      <div class="form-actions">
        <${Live} error=${msg.error} ok=${msg.ok} />
        <button class="btn btn-primary" disabled=${busy}><${Icon} name="plus" size=${16} /> ${busy ? 'Đang tạo…' : 'Thêm người dùng'}</button>
      </div>
    </form>
  </section>`;
}

/** Dòng phụ dưới người dùng: ô mật khẩu mới (che) + Lưu/Huỷ, lỗi hiện ngay tại chỗ. */
function ResetRow({ user, onCancel, onDone }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const id = `reset-${user.username}`;
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  async function save(e) {
    e.preventDefault();
    if (pw.length < 8) { setError('Mật khẩu cần ít nhất 8 ký tự — nhập mật khẩu dài hơn.'); return; }
    setBusy(true); setError('');
    try {
      await api(`/api/admin/users/${encodeURIComponent(user.username)}`, { method: 'PATCH', body: { password: pw } });
      onDone(`Đã đặt mật khẩu mới cho ${user.username}. Người này cần đăng nhập lại.`);
    } catch (err) { setError(err.message); setBusy(false); }
  }
  return html`<tr class="reset-row"><td colspan="7">
    <form class="reset-form" onSubmit=${save} novalidate>
      <div class="field">
        <label for=${id}>Mật khẩu mới cho ${user.username}</label>
        <input id=${id} type="password" autocomplete="new-password" ref=${inputRef} value=${pw}
          aria-describedby=${`${id}-help`} onInput=${(e) => setPw(e.currentTarget.value)} />
        <small id=${`${id}-help`}>Ít nhất 8 ký tự. Người này sẽ bị đăng xuất khỏi mọi nơi.</small>
      </div>
      <div class="row">
        <button class="btn btn-primary btn-sm" disabled=${busy}>${busy ? 'Đang lưu…' : 'Lưu'}</button>
        <button type="button" class="btn btn-secondary btn-sm" disabled=${busy} onClick=${onCancel}>Huỷ</button>
      </div>
      <${Live} error=${error} />
    </form>
  </td></tr>`;
}

/** Dòng phụ: thiết bị đang đăng nhập tài khoản này, Quản trị đăng xuất từ xa từng thiết bị. */
function DevicesRow({ user, sessions, onChanged }) {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState({});
  async function logout(s) {
    if (!confirm(`Đăng xuất ${user.username} trên ${s.device.label}?`)) return;
    setBusy(s.id); setMsg({});
    try { await api(`/api/admin/sessions/${encodeURIComponent(s.id)}/logout`, { method: 'POST' }); setMsg({ ok: `Đã đăng xuất ${user.username} trên ${s.device.label}.` }); await onChanged(); }
    catch (err) { setMsg({ error: err.message }); } finally { setBusy(''); }
  }
  return html`<tr class="reset-row"><td colspan="7">
    <${DeviceList} sessions=${sessions} busy=${busy} onLogout=${logout} />
    <${Live} error=${msg.error} ok=${msg.ok} />
  </td></tr>`;
}

const ZALO_UID = /^[1-9]\d{14,21}$/;

/** Dòng phụ sửa UID Zalo và vai trò ngay trong bảng. Không cho tự hạ quyền chính mình. */
function EditRow({ user, self, onCancel, onDone }) {
  const [uid, setUid] = useState(user.zaloUid || '');
  const [role, setRole] = useState(user.role);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const id = `edit-${user.username}`;
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  async function save(e) {
    e.preventDefault();
    const zaloUid = uid.trim();
    if (zaloUid && !ZALO_UID.test(zaloUid)) { setError('UID Zalo là dãy 15–22 chữ số, không bắt đầu bằng 0 — kiểm tra lại rồi lưu.'); return; }
    const body = { zaloUid };
    if (!self && role !== user.role) body.role = role;
    setBusy(true); setError('');
    try {
      await api(`/api/admin/users/${encodeURIComponent(user.username)}`, { method: 'PATCH', body });
      onDone(`Đã cập nhật ${user.username}.`);
    } catch (err) { setError(err.message); setBusy(false); }
  }
  return html`<tr class="reset-row"><td colspan="7">
    <form class="reset-form" onSubmit=${save} novalidate>
      <div class="field">
        <label for=${`${id}-uid`}>UID Zalo của ${user.username}</label>
        <input id=${`${id}-uid`} inputmode="numeric" autocomplete="off" spellcheck="false" ref=${inputRef} value=${uid}
          aria-describedby=${`${id}-uid-help`} onInput=${(e) => setUid(e.currentTarget.value.replace(/\D/g, ''))} />
        <small id=${`${id}-uid-help`}>Dãy 15–22 chữ số, để trống nếu chỉ dùng mật khẩu.</small>
      </div>
      <div class="field">
        <label for=${`${id}-role`}>Vai trò</label>
        <select id=${`${id}-role`} value=${role} disabled=${self} aria-describedby=${self ? `${id}-role-help` : undefined}
          onChange=${(e) => setRole(e.currentTarget.value)}>
          <option value="owner">Chủ bot</option>
          <option value="admin">Quản trị</option>
        </select>
        ${self ? html`<small id=${`${id}-role-help`}>Không tự hạ quyền tài khoản đang dùng.</small>` : null}
      </div>
      <div class="row">
        <button class="btn btn-primary btn-sm" disabled=${busy}>${busy ? 'Đang lưu…' : 'Lưu'}</button>
        <button type="button" class="btn btn-secondary btn-sm" disabled=${busy} onClick=${onCancel}>Huỷ</button>
      </div>
      <${Live} error=${error} />
    </form>
  </td></tr>`;
}

export function Users({ me }) {
  const [list, setList] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState({});

  const [sessions, setSessions] = useState([]);
  const load = () => api('/api/admin/users').then((r) => { setList(r.users); setLoadError(''); }).catch((err) => setLoadError(err.message));
  const loadSessions = () => api('/api/admin/sessions').then((r) => setSessions(r.sessions)).catch(() => {});
  useEffect(() => { loadSessions(); }, []);
  useEffect(() => { load(); }, []);

  async function patch(u, body, okText) {
    setBusy(u.username); setMsg({});
    try { await api(`/api/admin/users/${encodeURIComponent(u.username)}`, { method: 'PATCH', body }); setMsg({ ok: okText }); await load(); } catch (err) { setMsg({ error: err.message }); } finally { setBusy(''); }
  }
  const toggle = (u) => {
    if (!u.disabled && !confirm(`Khoá tài khoản ${u.username}? Người này sẽ bị đăng xuất ngay.`)) return;
    patch(u, { disabled: !u.disabled }, u.disabled ? `Đã mở khoá ${u.username}.` : `Đã khoá ${u.username}.`);
  };
  const [resetFor, setResetFor] = useState('');
  const [editFor, setEditFor] = useState('');
  const [devicesFor, setDevicesFor] = useState('');
  const openReset = (u) => { setResetFor(resetFor === u.username ? '' : u.username); setEditFor(''); setDevicesFor(''); setMsg({}); };
  const openEdit = (u) => { setEditFor(editFor === u.username ? '' : u.username); setResetFor(''); setDevicesFor(''); setMsg({}); };
  const openDevices = (u) => { setDevicesFor(devicesFor === u.username ? '' : u.username); setResetFor(''); setEditFor(''); setMsg({}); loadSessions(); };
  const sessionsOf = (u) => sessions.filter((s) => s.username === u.username);

  return html`
    <${PageHead} title="Người dùng" sub="Ai được vào dashboard và với vai trò gì." />
    <section class="card">
      <h2>Danh sách</h2>
      ${loadError ? html`<${Live} error=${loadError} />` : !list ? html`<${Spinner} />` : html`
        <div class="table-wrap">
          <table class="table table-cards users-table">
            <thead><tr><th scope="col">Tên đăng nhập</th><th scope="col">Vai trò</th><th scope="col">Zalo</th>
              <th scope="col">Trạng thái</th><th scope="col" class="th-wrap">Đăng nhập gần nhất</th><th scope="col">Tạo lúc</th>
              <th scope="col"><span class="sr-only">Thao tác</span></th></tr></thead>
            <tbody>
              ${list.map((u) => html`<tr key=${u.username}>
                <td data-label="Tên đăng nhập"><strong>${u.username}</strong>${u.username === me.username ? html` <span class="tag">bạn</span>` : null}</td>
                <td data-label="Vai trò">${roleLabel(u.role)}</td>
                <td data-label="Zalo">${u.zaloUid ? 'Đã liên kết' : html`<span class="muted">Chưa liên kết</span>`}</td>
                <td data-label="Trạng thái">${u.disabled ? html`<span class="badge badge-danger"><${Icon} name="lock" size=${14} /> Đã khoá</span>`
                  : html`<span class="badge badge-ok"><${Icon} name="check" size=${14} /> Đang dùng</span>`}</td>
                <td data-label="Đăng nhập gần nhất">${u.lastLoginAt ? fmtTime(u.lastLoginAt) : html`<span class="muted">Chưa đăng nhập</span>`}</td>
                <td data-label="Tạo lúc">${fmtTime(u.createdAt)}</td>
                <td data-label="Thao tác"><div class="actions">
                  <button class="btn btn-secondary btn-sm" disabled=${busy === u.username || u.username === me.username}
                    title=${u.username === me.username ? 'Không thể tự khoá tài khoản đang dùng' : undefined} onClick=${() => toggle(u)}>
                    <${Icon} name=${u.disabled ? 'unlock' : 'lock'} size=${14} /> ${u.disabled ? 'Mở khoá' : 'Khoá'}</button>
                  <button class="btn btn-secondary btn-sm" disabled=${busy === u.username} aria-expanded=${resetFor === u.username}
                    onClick=${() => openReset(u)}><${Icon} name="key" size=${14} /> Đặt lại mật khẩu</button>
                  <button class="btn btn-secondary btn-sm" disabled=${busy === u.username} aria-expanded=${editFor === u.username}
                    onClick=${() => openEdit(u)}><${Icon} name="user" size=${14} /> Sửa UID / vai trò</button>
                  <button class="btn btn-secondary btn-sm" aria-expanded=${devicesFor === u.username}
                    onClick=${() => openDevices(u)}><${Icon} name="monitor" size=${14} /> Thiết bị (${sessionsOf(u).length})</button>
                </div></td>
              </tr>
              ${editFor === u.username ? html`<${EditRow} key=${`edit-${u.username}`} user=${u} self=${u.username === me.username}
                onCancel=${() => setEditFor('')} onDone=${(text) => { setEditFor(''); setMsg({ ok: text }); load(); }} />` : null}
              ${devicesFor === u.username ? html`<${DevicesRow} key=${`dev-${u.username}`} user=${u} sessions=${sessionsOf(u)}
                onChanged=${loadSessions} />` : null}
              ${resetFor === u.username ? html`<${ResetRow} key=${`reset-${u.username}`} user=${u}
                onCancel=${() => setResetFor('')} onDone=${(text) => { setResetFor(''); setMsg({ ok: text }); }} />` : null}`)}
            </tbody>
          </table>
        </div>`}
      <${Live} error=${msg.error} ok=${msg.ok} />
    </section>
    <${AddUser} onAdded=${load} />`;
}
