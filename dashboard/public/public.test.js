import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)));
const files = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]));

test('mọi import tương đối trong giao diện đều trỏ tới tệp có thật', () => {
  for (const f of files(root).filter((x) => /\.m?js$/.test(x) && !x.endsWith('.test.js'))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/from\s*["'](\.[^"']+)["']/g)) {
      assert.ok(existsSync(resolve(dirname(f), m[1])), `${f} → ${m[1]}`);
    }
  }
});

test('dải trạng thái và thẻ Zalo: listener đứt → vàng "Đang nối lại", mất phiên/chưa đăng nhập → đỏ', async () => {
  const { statusLevel } = await import('./views/shell.js');
  const { zaloCard } = await import('./views/overview.js');
  const st = (zalo) => ({ sidecar: 'up', assistant: 'connected', zalo: { status: 'logged-in', listener: 'connected', needsRelogin: false, ...zalo } });
  assert.equal(statusLevel(st({})).kind, 'ok');
  assert.equal(zaloCard(st({})).kind, 'ok');
  for (const listener of ['reconnecting', 'closed', 'starting']) {
    const lv = statusLevel(st({ listener }));
    assert.equal(lv.kind, 'warn');
    assert.match(lv.text, /Đang nối lại/);
    assert.equal(zaloCard(st({ listener })).kind, 'warn');
  }
  assert.equal(statusLevel(st({ listener: null })).kind, 'ok');
  for (const bad of [{ needsRelogin: true, listener: 'reconnecting' }, { status: 'idle', listener: null }]) {
    assert.equal(statusLevel(st(bad)).kind, 'danger');
    assert.equal(zaloCard(st(bad)).kind, 'danger');
  }
});

test('tin nhắn: ảnh/tệp hiện nhãn + link https; chữ giữ nguyên, không bao giờ thành HTML hay link lạ', async () => {
  const { messageView, mergeMessages, preview } = await import('./views/chats.js');
  assert.deepEqual(messageView({ msgType: 'chat.photo', text: 'https://photo-stal-1.zdn.vn/a.jpg' }),
    { label: 'Ảnh', text: '', link: null, media: { kind: 'photo', url: 'https://photo-stal-1.zdn.vn/a.jpg', caption: '' } });
  // Ảnh không nằm trên máy chủ ảnh Zalo: không tải hộ, giữ cách cũ (nhãn + link ngoài).
  assert.deepEqual(messageView({ msgType: 'chat.photo', text: 'https://example.com/a.jpg' }), { label: 'Ảnh', text: '', link: 'https://example.com/a.jpg', media: null });
  assert.deepEqual(messageView({ msgType: 'chat.sticker', text: '[Nhãn dán]' }), { label: 'Nhãn dán', text: '', link: null, media: null });
  assert.deepEqual(messageView({ msgType: 'webchat', text: '<img src=x onerror=alert(1)>' }), { label: null, text: '<img src=x onerror=alert(1)>', link: null, media: null });
  for (const text of ['javascript:alert(1)', 'http://evil.vn', 'data:text/html,x', 'https://a.vn có chữ']) {
    assert.equal(messageView({ msgType: 'webchat', text }).link, null, text);
  }
  // Zalo gửi link Drive/Docs dưới loại chat.recommended (như danh thiếp): phải hiện là link, đúng tên trang.
  const drive = 'https://drive.google.com/file/d/1cn7ZXYy/view?usp=drivesdk';
  assert.deepEqual(messageView({ msgType: 'chat.recommended', text: drive }), { label: 'Google Drive', text: '', link: drive, media: null });
  assert.equal(messageView({ msgType: 'chat.recommended', text: 'https://forms.gle/abc' }).label, 'Google Forms');
  assert.equal(messageView({ msgType: 'chat.recommended', text: 'https://vi.wikipedia.org/x' }).label, 'Liên kết');
  assert.equal(messageView({ msgType: 'chat.recommended', text: '{"contactUid":"1"}' }).label, 'Danh thiếp');
  const { shortUrl, siteName } = await import('./views/chats.js');
  assert.equal(shortUrl(drive), 'drive.google.com/file/d/1cn7ZXYy/view');
  assert.equal(siteName('https://evil.com/drive.google.com'), null);
  assert.equal(siteName('https://notdrive.google.com.evil.vn/'), null);
  assert.deepEqual(mergeMessages([{ id: 2, ts: 5 }, { id: 1, ts: 5 }], [{ id: 2, ts: 5 }, { id: 3, ts: 4 }]).map((m) => m.id), [3, 1, 2]);
  assert.equal(preview({ lastMsgType: 'chat.photo', lastText: 'https://x.zdn.vn/a.jpg', lastIsSelf: true }), 'Bot: [Ảnh]');
  assert.equal(preview({ lastMsgType: 'webchat', lastText: 'Chào', lastIsSelf: false }), 'Chào');
});

test('tô sáng kết quả tìm: tách chữ thành đoạn, không phân biệt hoa thường, giữ nguyên chữ gốc kể cả thẻ HTML', async () => {
  const { markMatches } = await import('./views/chats.js');
  assert.deepEqual(markMatches('Họp lúc 8h, HỌP lại chiều', 'họp'), [
    { text: 'Họp', hit: true }, { text: ' lúc 8h, ', hit: false }, { text: 'HỌP', hit: true }, { text: ' lại chiều', hit: false },
  ]);
  assert.deepEqual(markMatches('<b>x</b> họp', 'họp'), [{ text: '<b>x</b> ', hit: false }, { text: 'họp', hit: true }]);
  assert.deepEqual(markMatches('không có', 'họp'), [{ text: 'không có', hit: false }]);
  assert.deepEqual(markMatches('abc', ''), [{ text: 'abc', hit: false }]);
  // Từ khoá có ký tự đặc biệt của regex/LIKE được so nguyên văn.
  assert.deepEqual(markMatches('a.b axb', 'a.b'), [{ text: 'a.b', hit: true }, { text: ' axb', hit: false }]);
  assert.deepEqual(markMatches('f(x) = (1)', '('), [
    { text: 'f', hit: false }, { text: '(', hit: true }, { text: 'x) = ', hit: false }, { text: '(', hit: true }, { text: '1)', hit: false },
  ]);
  assert.deepEqual(markMatches('giảm 50% hôm nay', '%'), [{ text: 'giảm 50', hit: false }, { text: '%', hit: true }, { text: ' hôm nay', hit: false }]);
  assert.deepEqual(markMatches('abc', '%'), [{ text: 'abc', hit: false }]);
});

test('gấp chữ: không phân biệt dấu, đ → d; tô sáng đúng chữ gốc có dấu dù độ dài khác nhau', async () => {
  const { fold, markMatches, indexOfFolded } = await import('./fold.js');
  assert.equal(fold('Hòa HOÀ hoà'), 'hoa hoa hoa');
  assert.equal(fold('Đoàn Thanh niên'), 'doan thanh nien');
  assert.equal(fold('Học sinh'), fold('hoc sinh'));
  assert.equal(fold('hòa'), 'hoa'); // dấu rời (NFD)
  assert.deepEqual(markMatches('Lớp học sinh giỏi', 'hoc sinh'), [
    { text: 'Lớp ', hit: false }, { text: 'học sinh', hit: true }, { text: ' giỏi', hit: false },
  ]);
  assert.deepEqual(markMatches('ĐOÀN trường', 'doan'), [{ text: 'ĐOÀN', hit: true }, { text: ' trường', hit: false }]);
  assert.deepEqual(markMatches('hoà và hòa', 'hòa'), [
    { text: 'hoà', hit: true }, { text: ' và ', hit: false }, { text: 'hòa', hit: true },
  ]);
  // Chữ gốc dạng tổ hợp (dài hơn chữ gấp): đoạn tô gồm cả dấu rời, ghép lại đúng chữ gốc.
  const nfd = 'xin chào bạn';
  const parts = markMatches(nfd, 'chao');
  assert.deepEqual(parts, [{ text: 'xin ', hit: false }, { text: 'chào', hit: true }, { text: ' bạn', hit: false }]);
  assert.equal(parts.map((p) => p.text).join(''), nfd);
  assert.equal(indexOfFolded('abc Học sinh', 'hoc'), 4);
  assert.equal(indexOfFolded('abc', 'x'), -1);
});

test('Nhật ký: mã kỹ thuật cho Quản trị gọn một dòng, bỏ trường rỗng', async () => {
  const { codeText } = await import('./views/audit.js');
  assert.equal(codeText({ action: 'send', category: 'send', actorUid: '555', threadId: '', error: null }), 'action=send · category=send · actorUid=555');
  assert.equal(codeText(undefined), '');
});

test('giao diện không dùng innerHTML và không có style nội tuyến (CSP)', () => {
  for (const f of files(root).filter((x) => x.endsWith('.js') && !x.endsWith('.test.js'))) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /innerHTML|dangerouslySetInnerHTML|insertAdjacentHTML/, f);
    assert.doesNotMatch(src, /\sstyle=/, f);
  }
});

test('index.html không tải tài nguyên từ Internet; nạp brand.css sau style.css để màu thương hiệu đè lên', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /(src|href)=["']https?:/);
  assert.ok(html.indexOf('href="brand.css"') > html.indexOf('href="style.css"'));
  assert.match(html, /id="brand-css"/);
});

test('phân quyền: gộp nhóm của bot với tệp, so thay đổi, nhãn trong danh sách', async () => {
  const { mergeGroups, sameSettings, groupBadge } = await import('./views/permissions.js');
  const on = { web: true, kb: true };
  const perms = {
    defaults: { active: true, replyOnlyTagged: true, features: on },
    groups: {
      '300': { name: 'Tổ Hoá', custom: true, active: true, replyOnlyTagged: false, features: { web: false, kb: true } },
      '400': { name: '', custom: true, active: false, replyOnlyTagged: true, features: on },
    },
  };
  const list = mergeGroups([{ id: '200', name: 'Đoàn trường', members: 40 }, { id: '300', name: 'Tổ Hoá mới', members: 12 }], perms);
  assert.deepEqual(list.map((g) => [g.id, g.name, g.members, g.custom]), [
    ['200', 'Đoàn trường', 40, false], ['300', 'Tổ Hoá mới', 12, true], ['400', 'Nhóm …400', null, true],
  ]);
  assert.deepEqual(list[0].features, on);
  assert.equal(list[1].replyOnlyTagged, false);
  list[0].features.web = false;
  assert.equal(perms.defaults.features.web, true, 'không sửa nhầm vào mặc định');
  assert.equal(sameSettings(perms.defaults, { active: true, replyOnlyTagged: true, features: { kb: true, web: true } }), true);
  assert.equal(sameSettings(perms.defaults, { active: true, replyOnlyTagged: true, features: { kb: true, web: false } }), false);
  assert.deepEqual(groupBadge(list[2]), { kind: 'danger', text: 'Đang tắt' });
  assert.deepEqual(groupBadge(list[1]), { kind: 'warn', text: 'Tắt 1 tính năng' });
  assert.equal(groupBadge({ active: true, custom: false, features: on }), null);
  assert.deepEqual(groupBadge({ active: true, custom: true, features: on }), { kind: 'idle', text: 'Chỉnh riêng' });
  const same = mergeGroups([], { defaults: perms.defaults, groups: { '500': { name: 'Tổ Văn', custom: true, ...perms.defaults } } });
  assert.equal(same[0].custom, false, 'mục trong tệp trùng hẳn mặc định thì không hiện "Chỉnh riêng"');
});

test('phân quyền: nhóm trong danh sách cũ "chỉ chủ nhân" (Cấu hình) hiện đúng trạng thái; nhóm đã chỉnh riêng thì không', async () => {
  const { mergeGroups, groupBadge } = await import('./views/permissions.js');
  const defaults = { active: true, replyOnlyTagged: true, features: { web: true } };
  const perms = { defaults, legacyOwnerOnly: ['200', '300'], groups: { '300': { name: 'CLB', custom: true, ...defaults } } };
  const [a, b] = mergeGroups([{ id: '200', name: 'Vibe', members: 9 }, { id: '300', name: 'CLB', members: 5 }], perms);
  assert.equal(a.ownerOnly, true);
  assert.deepEqual(groupBadge(a), { kind: 'danger', text: 'Chỉ chủ nhân (Cấu hình)' });
  assert.equal(b.ownerOnly, false, 'đã có mục riêng → phân quyền thắng');
  assert.equal(groupBadge(b), null);
});

test('phân quyền: hỏi trước khi bỏ thay đổi chưa lưu; nhóm chỉ còn trong tệp về mặc định thì rời danh sách', async () => {
  const { mayLeave, staysListed, LEAVE_MSG, DEFAULTS_KEY } = await import('./views/permissions.js');
  const asked = [];
  const ask = (answer) => (m) => { asked.push(m); return answer; };
  assert.equal(mayLeave(false, ask(false)), true);
  assert.deepEqual(asked, [], 'không có thay đổi thì không hỏi');
  assert.equal(mayLeave(true, ask(false)), false);
  assert.equal(mayLeave(true, ask(true)), true);
  assert.deepEqual(asked, [LEAVE_MSG, LEAVE_MSG]);
  assert.equal(LEAVE_MSG, 'Bạn có thay đổi chưa lưu ở nhóm này. Bỏ thay đổi và chuyển nhóm?');
  const perms = { groups: { '300': {} } };
  assert.equal(staysListed(DEFAULTS_KEY, perms, []), true);
  assert.equal(staysListed('dm', perms, []), true, 'mục Nhắn riêng luôn còn');
  assert.equal(staysListed('300', perms, []), true, 'còn mục trong tệp');
  assert.equal(staysListed('200', perms, [{ id: '200' }]), true, 'bot còn thấy nhóm');
  assert.equal(staysListed('400', perms, []), false, 'chỉ có trong tệp, vừa về mặc định');
});

test('thương hiệu: thu nhỏ logo giữ tỉ lệ, kiểm loại tệp, câu tương phản', async () => {
  const { fitSize, checkLogoFile, contrastInfo } = await import('./views/brand.js');
  assert.deepEqual(fitSize(1024, 512), { width: 256, height: 128 });
  assert.deepEqual(fitSize(100, 3000), { width: 9, height: 256 });
  assert.deepEqual(fitSize(64, 64), { width: 64, height: 64 }, 'ảnh nhỏ giữ nguyên');
  assert.deepEqual(fitSize(5000, 1), { width: 256, height: 1 });
  assert.equal(checkLogoFile({ type: 'image/png', size: 1000 }), '');
  assert.equal(checkLogoFile({ type: 'image/webp', size: 5 * 1024 * 1024 }), '');
  assert.match(checkLogoFile({ type: 'image/svg+xml', size: 100 }), /không nhận SVG/);
  assert.match(checkLogoFile({ type: 'image/gif', size: 100 }), /PNG, JPG hoặc WebP/);
  assert.match(checkLogoFile({ type: 'image/png', size: 5 * 1024 * 1024 + 1 }), /5 MB/);
  assert.match(checkLogoFile(undefined), /—/);
  assert.deepEqual(contrastInfo('#0F766E'), { hex: '#0f766e', ok: true, text: 'Chữ trắng trên màu này: 5,47 : 1 — dễ đọc.' });
  assert.equal(contrastInfo('#777777').ok, false);
  assert.match(contrastInfo('#777777').text, /4,48 : 1 — dưới 4,5 : 1/);
  assert.deepEqual(contrastInfo('xanh'), { hex: null, ok: false, text: 'Mã màu chưa đúng — nhập dạng #0f766e hoặc chọn một màu gợi ý.' });
});

test('chủ nhân: kiểm UID trước khi gửi, nhãn tên dễ hiểu', async () => {
  const { uidProblem, ownerLabel } = await import('./views/owners.js');
  const A = '1234567890123456';
  assert.equal(uidProblem('2234567890123456', [A]), '');
  assert.match(uidProblem('0912345678', [A]), /không phải số điện thoại/);
  assert.match(uidProblem(A, [A]), /đã là chủ nhân/);
  assert.match(uidProblem('2234567890123456', Array.from({ length: 20 }, (_, i) => String(i))), /Tối đa 20/);
  assert.equal(ownerLabel({ name: 'Cô Hà', dashboardUsers: ['ha'] }), 'Cô Hà · tài khoản dashboard: ha');
  assert.equal(ownerLabel({ name: '', dashboardUsers: ['anh'] }), 'Tài khoản dashboard: anh');
  assert.equal(ownerLabel({ name: '', dashboardUsers: [] }), 'Chưa rõ tên — người này chưa nhắn cho bot');
});

test('thanh bên: đủ mục spec §9 theo đúng nhóm, mục Quản trị chỉ hiện cho Quản trị', async () => {
  const src = readFileSync(join(root, 'views', 'shell.js'), 'utf8');
  const order = ['Tài khoản Zalo', 'Nhật ký', 'Thương hiệu', 'Người dùng', 'Chủ nhân bot', 'Cảnh báo Telegram'].map((t) => src.indexOf(`'${t}'`));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), order.join(','));
  assert.match(src, /'\/owners': \{ view: Owners, admin: true \}/);
  assert.match(src, /'\/brand': \{ view: Brand \}/);
});

test('Tổng quan: lỗi gần nhất thành câu dễ hiểu có bước tiếp theo; mã kỹ thuật chỉ cho Quản trị', async () => {
  const { errorText } = await import('./views/overview.js');
  const e = { code: 'zalo_listener_closed', message: 'Đã ghi nhận lỗi nội bộ; xem log cục bộ để biết chi tiết.', atMs: 1 };
  assert.deepEqual(errorText(e, 'owner'), {
    text: 'Kết nối nhận tin Zalo bị ngắt.',
    next: 'Bot thường tự nối lại sau ít phút. Nếu thanh trên cùng báo mất kết nối, hãy quét mã đăng nhập lại.',
    code: null,
  });
  assert.equal(errorText(e, 'admin').code, 'zalo_listener_closed');
  const unknown = errorText({ code: 'something_new' }, 'owner');
  assert.equal(unknown.text, 'Bot ghi nhận một lỗi nội bộ.');
  assert.match(unknown.next, /báo người cài đặt/);
  for (const code of ['bridge_command_failed', 'system_notice_failed', 'bridge_server_error', 'history_retention_failed',
    'legacy_history_import_failed', 'automatic_backfill_failed', 'dashboard_server_error']) {
    const r = errorText({ code }, 'owner');
    assert.notEqual(r.text, unknown.text, code);
    assert.doesNotMatch(`${r.text} ${r.next}`, /log|sidecar|bridge|toolset/i, code);
  }
});

test('nhắn riêng: bản nháp, thân gửi đi, thêm người (kiểm UID, trùng), gợi ý từ Phiên chat, nhãn danh sách', async () => {
  const { dmDraft, dmPayload, sameDm, addPerson, suggestions, dmBadge, WHO_OPTIONS } = await import('./views/dm-permissions.js');
  const on = { web: true, files: true, voice: true, reminders: true, kb: true, people: true, academic: true, video: true };
  const dm = { who: 'list', explicit: true, gatewayOpen: true, features: { ...on, video: false },
    people: [{ uid: '1234567890123456', name: 'Cô Lan', custom: true, features: { ...on, voice: false } }] };
  const d = dmDraft(dm);
  d.features.web = false;
  assert.equal(dm.features.web, true, 'không sửa nhầm vào dữ liệu máy chủ');
  assert.equal(sameDm(dmDraft(dm), dm), true);
  assert.equal(sameDm(d, dm), false);
  const added = addPerson(dmDraft(dm), ' 2234567890123456 ', 'Thầy Nam');
  assert.equal(added.error, undefined);
  assert.deepEqual(dmPayload(added.draft).people, [
    { uid: '1234567890123456', name: 'Cô Lan', features: { ...on, voice: false } },
    { uid: '2234567890123456', name: 'Thầy Nam', features: null },
  ]);
  assert.match(addPerson(d, '0912345678').error, /không phải số điện thoại — .*\/sethome/);
  assert.match(addPerson(d, '1234567890123456').error, /đã có trong danh sách/);
  const full = { ...d, people: Array.from({ length: 200 }, (_, i) => ({ uid: String(3234567890123456n + BigInt(i)) })) };
  assert.match(addPerson(full, '2234567890123456').error, /tối đa 200/);
  assert.deepEqual(suggestions([
    { threadId: '1234567890123456', threadType: 0, name: 'Cô Lan' },
    { threadId: '5234567890123456', threadType: 0, name: 'Khách' },
    { threadId: '2054797107487294899', threadType: 1, name: 'Nhóm' },
  ], d), [{ uid: '5234567890123456', name: 'Khách' }]);
  assert.deepEqual(dmBadge(dm), { kind: 'ok', text: '1 người' });
  assert.deepEqual(dmBadge({ ...dm, who: 'owners' }), { kind: 'idle', text: 'Chỉ chủ nhân' });
  assert.deepEqual(WHO_OPTIONS.map((o) => o.value), ['owners', 'list', 'everyone']);
});

test('nhắn riêng: tên người lấy từ Phiên chat và người dùng dashboard có UID Zalo', async () => {
  const { knownNames, suggestions, dmDraft } = await import('./views/dm-permissions.js');
  const on = { web: true, files: true, voice: true, reminders: true, kb: true, people: true, academic: true, video: true };
  const d = dmDraft({ who: 'list', features: on, people: [{ uid: '1234567890123456', name: '', custom: false, features: on }] });
  const chats = [{ threadId: '5234567890123456', threadType: 0, name: 'Khách' }];
  const users = [{ username: 'lan', zaloUid: '1234567890123456' }, { username: 'nam', zaloUid: '6234567890123456' },
    { username: 'khach', zaloUid: '5234567890123456' }, { username: 'admin', zaloUid: '' }];
  const names = knownNames(chats, users);
  assert.equal(names.get('1234567890123456'), 'lan');
  assert.equal(names.get('5234567890123456'), 'Khách', 'Phiên chat đứng trước tên đăng nhập');
  assert.deepEqual(suggestions(chats, d, users), [{ uid: '5234567890123456', name: 'Khách' }, { uid: '6234567890123456', name: 'nam' }]);
});

test('sức khoẻ máy chủ: đoạn biểu đồ ngắt ở chỗ thiếu số đo, thời gian chạy dễ đọc, mức màu, nhãn dịch vụ', async () => {
  const { chartSegments, peak, fmtUptime, fmtPct, level, serviceBadge, usageRows } = await import('./views/health.js');
  const to = 24 * 3600_000;
  const pts = [[0, 0, 50, 100], [60_000, 100, 50, null], [120_000, 50, 50, 100], [10 * 60_000, 20, 50, 100], [to + 1, 5, 5, 5]];
  assert.deepEqual(chartSegments(pts, 1, { to }), ['0.0,120.0 0.4,0.0 0.8,60.0', '4.2,96.0 4.2,96.0']);
  assert.deepEqual(chartSegments(pts, 3, { to }), ['0.0,0.0 0.0,0.0', '0.8,0.0 0.8,0.0', '4.2,0.0 4.2,0.0'], 'null ngắt đoạn; điểm lẻ thành chấm');
  assert.deepEqual(chartSegments([], 1, { to }), []);
  assert.equal(peak(pts, 3), 100);
  assert.equal(peak([[0, null, null, null]], 1), null);
  assert.equal(fmtUptime(45 * 60), '45 phút');
  assert.equal(fmtUptime(5 * 3600 + 12 * 60), '5 giờ 12 phút');
  assert.equal(fmtUptime(2 * 86400 + 3 * 3600), '2 ngày 3 giờ');
  assert.equal(fmtUptime(24 * 86400), '3 tuần 3 ngày');
  assert.equal(fmtPct(null), 'Chưa đo được');
  assert.deepEqual([level(10), level(80), level(90), level(90.1), level(null)], ['ok', 'warn', 'warn', 'danger', 'idle']);
  assert.deepEqual(serviceBadge('missing'), { kind: 'idle', text: 'Không có trên máy này' });
  assert.equal(serviceBadge('lạ').text, 'Không rõ');
  const days = Array.from({ length: 20 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, calls: i }));
  assert.deepEqual(usageRows({ days }).map((d) => d.calls).slice(0, 2), [19, 18]);
  assert.equal(usageRows({ days }).length, 14);
  assert.deepEqual(usageRows(undefined), []);
});

test('Nhắn riêng: nút Lưu bật khi chưa từng lưu dù chưa sửa gì', async () => {
  const { canSaveDm } = await import('./views/dm-permissions.js');
  assert.equal(canSaveDm({ explicit: false }, false), true);
  assert.equal(canSaveDm({ explicit: true }, false), false);
  assert.equal(canSaveDm({ explicit: true }, true), true);
});

test('sức khoẻ máy chủ: gợi ý theo loại cảnh báo; ghi chú dùng AI chỉ báo thiếu khi chưa có số nào', async () => {
  const { alertHint, alertBanner, usageNote, Health } = await import('./views/health.js');
  const warn = alertBanner({ kind: 'cpu', since: Date.now(), alerted: false }, 'admin');
  assert.equal(warn.kind, 'warn');
  assert.match(warn.text, /^Đang theo dõi: CPU cao \(≥ 90 %\) từ .*hết cảnh báo khi xuống dưới 85 %/);
  const red = alertBanner({ kind: 'ram', since: Date.now(), alerted: true }, 'owner');
  assert.equal(red.kind, 'danger');
  assert.match(red.text, /RAM cao \(≥ 90 %\).*đã báo Telegram.*dưới 85 %.*Báo người cài đặt/);
  assert.doesNotMatch(red.text + warn.text, /trên 90 %/);
  assert.match(alertHint('disk', 'admin'), /dọn bớt tệp.*tăng dung lượng ổ/i);
  assert.match(alertHint('ram', 'admin'), /khởi động lại dịch vụ ngốn bộ nhớ hoặc nâng RAM/i);
  assert.match(alertHint('cpu', 'admin'), /kiểm tra tiến trình đang chạy nặng/i);
  assert.equal(alertHint('ram', 'owner'), 'Báo người cài đặt nếu kéo dài.');
  const row = [{ date: '2026-10-07', calls: 1 }];
  assert.equal(usageNote({ error: null }, row), null);
  assert.equal(usageNote({ error: 'missing' }, []).kind, 'warn');
  assert.equal(usageNote({ error: 'unreadable' }, []).kind, 'warn');
  const at = Date.UTC(2026, 9, 7, 2, 5); // 09:05 giờ Việt Nam
  const n = usageNote({ error: 'unreadable', errorAt: at }, row);
  assert.equal(n.kind, 'muted');
  assert.match(n.text, /^Không đọc được số mới lúc \d{2}:\d{2} — đang hiện số đã lưu/);
  assert.equal(usageNote({ error: 'missing', errorAt: at }, row).kind, 'muted', 'có số đã lưu thì không báo thiếu');
  const src = readFileSync(join(root, 'views', 'health.js'), 'utf8');
  assert.match(src, /gồm cả khoảng dashboard tắt/);
  assert.match(src, /Chỉ đếm lượt gọi và token, chưa tính tiền — /);
  assert.doesNotMatch(src, /<text/, 'nhãn trục là chữ HTML, không co giãn theo SVG');
  assert.equal(typeof Health, 'function');
});

test('thanh bên: Sức khoẻ máy chủ nằm trong nhóm Hệ thống, cả hai vai trò đều thấy', () => {
  const src = readFileSync(join(root, 'views', 'shell.js'), 'utf8');
  assert.match(src, /'\/health': \{ view: Health \}/);
  assert.ok(src.indexOf("'Sức khoẻ máy chủ'") > src.indexOf("'Thương hiệu'") && src.indexOf("'Sức khoẻ máy chủ'") < src.indexOf("label: 'Quản trị'"));
});

const DM_F = [
  { key: 'web', label: 'Tra cứu web' }, { key: 'files', label: 'Gửi và tạo tệp' }, { key: 'voice', label: 'Tin nhắn thoại' },
  { key: 'reminders', label: 'Nhắc hẹn' }, { key: 'kb', label: 'Kho tài liệu' }, { key: 'people', label: 'Sổ người quen' },
  { key: 'academic', label: 'Tra cứu học thuật' }, { key: 'video', label: 'Video' },
];
const ALL_ON = Object.fromEntries(DM_F.map((f) => [f.key, true]));

test('nhắn riêng: tóm tắt từng người trên hàng gập', async () => {
  const { personSummary, shortUid } = await import('./views/dm-permissions.js');
  assert.deepEqual(personSummary({ custom: false, features: { ...ALL_ON, web: false } }, DM_F), { kind: 'idle', text: 'Theo cài đặt chung', detail: '' });
  assert.deepEqual(personSummary({ custom: true, features: ALL_ON }, DM_F), { kind: 'ok', text: 'Riêng · bật tất cả', detail: '' });
  assert.deepEqual(personSummary({ custom: true, features: { ...ALL_ON, voice: false, video: false } }, DM_F),
    { kind: 'warn', text: 'Riêng · 2 tính năng tắt', detail: 'Đang tắt: Tin nhắn thoại, Video' });
  assert.equal(shortUid('1234567890123456'), '…0123456');
  assert.equal(shortUid('12345'), '12345');
});

test('nhắn riêng: lọc người theo tên không dấu, UID, "có chỉnh riêng"; đếm thay đổi', async () => {
  const { filterPeople, dmChangeCount, dmDraft, addPerson } = await import('./views/dm-permissions.js');
  const people = [
    { uid: '1234567890123456', name: 'Cô Lan', custom: true, features: ALL_ON },
    { uid: '2234567890123456', name: '', custom: false, features: ALL_ON },
    { uid: '3234567890123456', name: 'Thầy Nam', custom: false, features: ALL_ON },
  ];
  const names = new Map([['2234567890123456', 'Hoà']]);
  assert.deepEqual(filterPeople(people, { q: 'co lan' }).map((p) => p.name), ['Cô Lan']);
  assert.deepEqual(filterPeople(people, { q: 'hoa', names }).map((p) => p.uid), ['2234567890123456'], 'tên đã biết theo UID');
  assert.deepEqual(filterPeople(people, { q: '323456' }).map((p) => p.name), ['Thầy Nam']);
  assert.deepEqual(filterPeople(people, { customOnly: true }).map((p) => p.name), ['Cô Lan']);
  assert.equal(filterPeople(people, {}).length, 3);
  const dm = { who: 'list', explicit: true, features: ALL_ON, people };
  const d = dmDraft(dm);
  assert.equal(dmChangeCount(d, dm), 0);
  d.who = 'everyone'; d.features.web = false; d.features.kb = false;
  d.people = d.people.filter((p) => p.uid !== '3234567890123456');
  d.people[0] = { ...d.people[0], features: { ...ALL_ON, voice: false } };
  assert.equal(dmChangeCount(d, dm), 5, 'ai + 2 nút chung + 1 người sửa + 1 người bỏ');
  assert.equal(dmChangeCount(addPerson(dmDraft(dm), '4234567890123456').draft, dm), 1);
  // Bật "tính năng riêng" nhưng giữ đúng nút chung vẫn là một thay đổi (thân gửi đi khác).
  const c = dmDraft(dm); c.people[1] = { ...c.people[1], custom: true };
  assert.equal(dmChangeCount(c, dm), 1);
});

test('phân quyền nhóm: đếm thay đổi, câu "a/b đang bật", chữ thanh Lưu', async () => {
  const { changeCount } = await import('./views/permissions.js');
  const { onText, changesText } = await import('./ui.js');
  const a = { active: true, replyOnlyTagged: true, features: { web: true, kb: true } };
  assert.equal(changeCount(a, a), 0);
  assert.equal(changeCount({ active: false, replyOnlyTagged: false, features: { web: false, kb: true } }, a), 3);
  assert.equal(onText({ web: true, kb: false }, [{ key: 'web' }, { key: 'kb' }]), '1/2 đang bật');
  assert.equal(onText(ALL_ON, DM_F), '8/8 đang bật');
  assert.equal(changesText(3), '3 thay đổi chưa lưu');
  assert.equal(changesText(0), 'Chưa có thay đổi.');
  assert.equal(changesText(0, 'Chưa từng lưu'), 'Chưa từng lưu');
});

test('Nhật ký: câu tự nhiên từ what/who/where, nhóm theo ngày, lọc theo loại', async () => {
  const { auditSentence, groupByDay, auditTabs, matches } = await import('./views/audit.js');
  assert.equal(auditSentence({ source: 'zalo', what: 'Bot trả lời tin nhắn', who: 'Chủ nhân Cô Lan', where: 'Tổ Hoá' }),
    'Bot trả lời tin nhắn ở Tổ Hoá, theo yêu cầu của Chủ nhân Cô Lan.');
  assert.equal(auditSentence({ source: 'zalo', what: 'Bot trả lời tin nhắn', who: 'Thành viên Cô Lan', where: 'Cô Lan' }),
    'Bot trả lời tin nhắn (nhắn riêng), theo yêu cầu của Thành viên Cô Lan.');
  assert.equal(auditSentence({ source: 'zalo', what: 'Bot gửi thông báo hệ thống', who: 'Bot (tự động)', where: '—' }),
    'Bot gửi thông báo hệ thống (bot tự làm).');
  assert.equal(auditSentence({ source: 'zalo', what: 'Nhắn tay từ dashboard', who: 'khach (dashboard)', where: 'Lan' }),
    'Nhắn tay từ dashboard ở Lan, do khach gửi từ dashboard.');
  assert.equal(auditSentence({ source: 'zalo', what: 'typing_x', who: 'Thành viên', where: '—' }), 'Thao tác typing_x, theo yêu cầu của Thành viên.');
  assert.equal(auditSentence({ source: 'dashboard', what: 'Đăng nhập dashboard', who: 'anh (dashboard)', where: 'Dashboard' }), 'anh đăng nhập dashboard.');
  assert.equal(auditSentence({ source: 'dashboard', what: 'Đổi phân quyền nhóm', who: 'anh (dashboard)', where: 'Dashboard' }), 'anh đổi phân quyền nhóm trên dashboard.');
  assert.equal(auditSentence({ source: 'dashboard', what: 'Đăng nhập dashboard', who: 'Người lạ', where: 'Dashboard' }), 'Người lạ đăng nhập dashboard.');
  assert.equal(auditSentence({ source: 'dashboard', what: 'brand_new', who: 'anh (dashboard)', where: 'Dashboard' }), 'anh làm thao tác brand_new trên dashboard.');
  const now = Date.UTC(2026, 9, 7, 5); // 12:00 giờ Việt Nam
  const items = [{ at: now - 3600_000 }, { at: now - 2 * 3600_000 }, { at: now - 86_400_000 }, { at: now - 3 * 86_400_000 }];
  const g = groupByDay(items, { now, tz: 'Asia/Ho_Chi_Minh' });
  assert.deepEqual(g.map((x) => [x.label, x.items.length]), [['Hôm nay', 2], ['Hôm qua', 1], [g[2].label, 1]]);
  assert.match(g[2].label, /04\/10\/2026$/);
  assert.equal(g[2].label[0], g[2].label[0].toLocaleUpperCase('vi'), 'viết hoa chữ đầu');
  assert.deepEqual(groupByDay([], { now }), []);
  // Nhật ký gộp Theo dõi agent: mở ra là "Có lỗi"; "Hoạt động AI" chỉ Quản trị; ô tìm chung.
  assert.deepEqual(auditTabs(true).map((t) => t.value), ['errors', 'dashboard', 'zalo', 'ai']);
  assert.deepEqual(auditTabs(false).map((t) => t.value), ['errors', 'dashboard', 'zalo']);
  assert.equal(matches({ source: 'zalo', what: 'Bot gửi tệp', who: 'Lan', where: 'CLB BOT ZALO' }, 'clb bot'), true);
  assert.equal(matches({ source: 'zalo', what: 'Bot gửi tệp', who: 'Lan', where: 'CLB' }, 'đoàn'), false);
  assert.equal(matches({ kind: 'ai', chatName: 'AI Y Tế', who: 'Trung', user: 'dầu gội', tools: ['zalo_web_search'] }, 'web_search'), true);
  assert.equal(matches({ kind: 'ai', chatName: 'AI Y Tế' }, ''), true);
});

test('thanh điều hướng điện thoại: 4 mục chính + "Thêm" theo vai trò', async () => {
  const { navSplit } = await import('./views/shell.js');
  const admin = navSplit('admin', '/audit', { secondBrain: true });
  assert.deepEqual(admin.primary.map((i) => [i.path, i.short]), [['/', 'Tổng quan'], ['/chats', 'Phiên chat'], ['/zalo', 'Zalo'], ['/permissions', 'Phân quyền']]);
  assert.deepEqual(admin.more.map((i) => i.path), ['/contacts', '/schedules', '/memory', '/kb', '/insight', '/second-brain', '/mcp',
    '/agent', '/ai', '/tools', '/skills', '/audit', '/brand', '/health', '/maintenance', '/settings', '/users', '/owners', '/alerts', '/profile']);
  assert.equal(admin.activeMore.text, 'Nhật ký');
  const owner = navSplit('owner', '/', { secondBrain: true });
  assert.equal(owner.primary.length, 4);
  assert.deepEqual(owner.more.map((i) => i.path), ['/contacts', '/schedules', '/memory', '/kb', '/insight', '/audit', '/brand', '/health', '/profile'],
    'Chủ bot không thấy mục Quản trị (kể cả Second brain)');
  assert.equal(owner.activeMore, null);
  assert.equal(navSplit('owner', '/users').activeMore, null);
});

test('sức khoẻ máy chủ: ghi chú "Mới có dữ liệu N giờ", ngưỡng 4 ngày cho biểu đồ dùng AI', async () => {
  const { historyHours, historyNote, USAGE_CHART_MIN } = await import('./views/health.js');
  const to = 100 * 3600_000;
  assert.equal(historyHours([], to), null);
  assert.equal(historyNote([], to), null);
  assert.equal(historyHours([[to - 5.5 * 3600_000, 1], [to, 1]], to), 5);
  assert.equal(historyNote([[to - 5.5 * 3600_000, 1]], to), 'Mới có dữ liệu 5 giờ — biểu đồ đầy dần trong 24 giờ.');
  assert.match(historyNote([[to - 60_000, 1]], to), /chưa tới 1 giờ/);
  assert.equal(historyNote([[to - 30 * 3600_000, 1], [to - 23.5 * 3600_000, 1]], to), null, 'đủ 24 giờ');
  assert.equal(USAGE_CHART_MIN, 4);
});

test('Phân quyền: thanh Lưu dính, hộp gập, không còn làm mờ cả hộp bị tắt', () => {
  const css = readFileSync(join(root, 'style.css'), 'utf8');
  assert.match(css, /\.save-bar \{[^}]*position: sticky; bottom: 0;/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.doesNotMatch(css, /:disabled \{ opacity: \.6/);
  assert.match(css, /\.perm-row \.check \{ min-height: 44px; \}/);
  const dm = readFileSync(join(root, 'views', 'dm-permissions.js'), 'utf8');
  assert.match(dm, /aria-expanded=/);
  assert.match(dm, /aria-controls=/);
  assert.match(dm, /<details class="dm-add-box">/, '"+ Thêm người" gập sẵn');
});

// --- Xưởng tạo sản phẩm (spec §17) ---
const SF = [{ key: 'studioSlides' }, { key: 'studioDocs' }, { key: 'studioExams' }, { key: 'studioVideo' }];
const S_OFF = { studioSlides: false, studioDocs: false, studioExams: false, studioVideo: false };

test('xưởng: ô số lượt, gửi nút xưởng chỉ khi đủ khoá, đếm thay đổi gồm nút xưởng và số lượt', async () => {
  const { parseQuota, studioComplete } = await import('./views/studio-box.js');
  const { settingsPayload, changeCount, sameSettings } = await import('./views/permissions.js');
  assert.deepEqual(parseQuota(''), { value: null });
  assert.deepEqual(parseQuota(' 7 '), { value: 7 });
  assert.deepEqual(parseQuota('0'), { value: 0 });
  for (const bad of ['51', '-1', '2.5', 'ba', '100']) assert.match(parseQuota(bad).error, /0 đến 50/, bad);
  assert.match(parseQuota('', { allowEmpty: false }).error, /Nhập số lượt/);
  assert.equal(studioComplete(S_OFF, SF), true);
  assert.equal(studioComplete({ studioSlides: true }, SF), false);
  assert.equal(studioComplete(undefined, SF), false);
  const base = { active: true, replyOnlyTagged: true, features: { web: true }, studio: S_OFF, studioQuota: null };
  const d = { ...base, studio: { ...S_OFF, studioVideo: true }, studioQuota: 5 };
  assert.deepEqual(settingsPayload(d, { isGroup: true, studioFeatures: SF }),
    { active: true, replyOnlyTagged: true, features: { web: true }, studio: { ...S_OFF, studioVideo: true }, studioQuota: 5 });
  assert.deepEqual(settingsPayload({ ...d, studio: {} }, { isGroup: false, studioFeatures: SF }),
    { active: true, replyOnlyTagged: true, features: { web: true } }, 'mặc định không gửi số lượt; dữ liệu cũ không gửi nút xưởng');
  assert.equal(changeCount(d, base), 2);
  assert.equal(sameSettings(d, base), false);
  assert.equal(sameSettings({ ...base, studioQuota: undefined }, base), true, 'thiếu số lượt = theo mặc định');
});

test('xưởng: máy Windows khoá nút video (chính sách cài đặt), máy khác không', async () => {
  const { lockedByPolicy, quotaSummary } = await import('./views/studio-box.js');
  assert.equal(quotaSummary('', 3), '3 lượt/người/ngày (mặc định)');
  assert.equal(quotaSummary('0', 3), '0 lượt/người/ngày');
  assert.equal(quotaSummary('77', 3), 'số lượt chưa đúng');
  const win ={ videoBlocked: true, note: 'Máy chủ Windows không có hộp cát — video tắt' };
  assert.equal(lockedByPolicy('studioVideo', win), true);
  assert.equal(lockedByPolicy('studioSlides', win), false);
  assert.equal(lockedByPolicy('studioVideo', { videoBlocked: false }), false);
  assert.equal(lockedByPolicy('studioVideo', undefined), false);
});

test('xưởng: nút video bị khoá thì bản nháp gửi studioVideo: false (giao diện và giá trị lưu khớp)', async () => {
  const { applyPolicy } = await import('./views/studio-box.js');
  const { settingsPayload } = await import('./views/permissions.js');
  const { dmDraft, dmPayload } = await import('./views/dm-permissions.js');
  const win = { videoBlocked: true, note: 'x' };
  const on = { studioSlides: true, studioDocs: false, studioExams: false, studioVideo: true };
  assert.deepEqual(applyPolicy(on, win), { ...on, studioVideo: false });
  assert.deepEqual(applyPolicy(on, { videoBlocked: false }), on, 'không khoá thì giữ nguyên');
  assert.deepEqual(applyPolicy(on, undefined), on);
  assert.equal(on.studioVideo, true, 'không sửa bản nháp tại chỗ');
  const d = { active: true, replyOnlyTagged: true, features: { web: true }, studio: on, studioQuota: null };
  assert.equal(settingsPayload(d, { isGroup: true, studioFeatures: SF, policy: win }).studio.studioVideo, false);
  assert.equal(settingsPayload(d, { isGroup: true, studioFeatures: SF }).studio.studioVideo, true);
  const dm = { who: 'everyone', explicit: true, gatewayOpen: true, features: ALL_ON, studio: on,
    people: [{ uid: '1234567890123456', name: 'Cô Lan', custom: true, features: ALL_ON, studio: on }] };
  const body = dmPayload(dmDraft(dm), win);
  assert.equal(body.studio.studioVideo, false);
  assert.equal(body.people[0].studio.studioVideo, false);
  assert.equal(body.studio.studioSlides, true);
});

test('xưởng: hạn mức theo người — bản nháp, kiểm số, thêm người (UID, trùng), đếm thay đổi', async () => {
  const { quotaDraft, quotaPayload, quotaChangeCount, addQuotaPerson, quotaBadge } = await import('./views/studio-quota.js');
  const saved = quotaDraft({ quota: 3, people: [{ uid: '1234567890123456', name: 'Cô Lan', quota: 10 }] });
  assert.deepEqual(saved, { quota: '3', people: [{ uid: '1234567890123456', name: 'Cô Lan', quota: '10' }] });
  assert.deepEqual(quotaPayload(saved), { body: { quota: 3, people: [{ uid: '1234567890123456', name: 'Cô Lan', quota: 10 }] } });
  assert.match(quotaPayload({ ...saved, quota: '' }).error, /Số lượt mặc định: Nhập số lượt/);
  assert.match(quotaPayload({ ...saved, people: [{ ...saved.people[0], quota: '99' }] }).error, /^Cô Lan: /);
  const added = addQuotaPerson(saved, ' 2234567890123456 ', 'Thầy Nam');
  assert.deepEqual(added.draft.people[1], { uid: '2234567890123456', name: 'Thầy Nam', quota: '3' }, 'mặc định lấy số lượt chung');
  assert.match(addQuotaPerson(saved, '0912345678').error, /không phải số điện thoại — .*\/sethome/);
  assert.match(addQuotaPerson(saved, '1234567890123456').error, /đã có hạn mức riêng/);
  assert.equal(quotaChangeCount(saved, saved), 0);
  assert.equal(quotaChangeCount({ ...added.draft, quota: '4' }, saved), 2);
  assert.equal(quotaBadge({ quota: 5 }), '5 lượt/ngày');
  assert.equal(quotaBadge(undefined), '3 lượt/ngày');
});

test('xưởng: nhắn riêng gửi nút xưởng chung và của người có tính năng riêng; người theo chung không gửi', async () => {
  const { dmDraft, dmPayload, dmChangeCount, addPerson } = await import('./views/dm-permissions.js');
  const dm = { who: 'everyone', explicit: true, gatewayOpen: true, features: ALL_ON, studio: { ...S_OFF, studioDocs: true },
    people: [{ uid: '1234567890123456', name: 'Cô Lan', custom: true, features: ALL_ON, studio: { ...S_OFF, studioVideo: true } },
      { uid: '2234567890123456', name: '', custom: false, features: ALL_ON, studio: { ...S_OFF, studioDocs: true } }] };
  const body = dmPayload(dmDraft(dm));
  assert.deepEqual(body.studio, { ...S_OFF, studioDocs: true });
  assert.deepEqual(body.people[0].studio, { ...S_OFF, studioVideo: true });
  assert.equal('studio' in body.people[1], false);
  const d = dmDraft(dm);
  d.studio.studioSlides = true;
  assert.equal(dmChangeCount(d, dm), 1);
  assert.deepEqual(addPerson(dmDraft(dm), '3234567890123456').draft.people[2].studio, { ...S_OFF, studioDocs: true });
});

test('xưởng: hàng gập của một người nhắn riêng tóm tắt cả nút xưởng (nút bị máy chủ khoá tính là tắt)', async () => {
  const { personSummary } = await import('./views/dm-permissions.js');
  const SFL = [{ key: 'studioSlides', label: 'Slide PowerPoint' }, { key: 'studioDocs', label: 'Văn bản và giáo án' },
    { key: 'studioExams', label: 'Đề thi' }, { key: 'studioVideo', label: 'Video' }];
  const win = { videoBlocked: true };
  assert.deepEqual(personSummary({ custom: true, features: ALL_ON, studio: { ...S_OFF, studioSlides: true, studioVideo: true } }, DM_F, SFL, win),
    { kind: 'ok', text: 'Riêng · bật tất cả · xưởng 1/4', detail: 'Xưởng bật: Slide PowerPoint' });
  assert.deepEqual(personSummary({ custom: true, features: { ...ALL_ON, voice: false }, studio: S_OFF }, DM_F, SFL),
    { kind: 'warn', text: 'Riêng · 1 tính năng tắt · xưởng 0/4', detail: 'Đang tắt: Tin nhắn thoại. Xưởng tắt hết' });
  assert.equal(personSummary({ custom: false, features: ALL_ON, studio: S_OFF }, DM_F, SFL).text, 'Theo cài đặt chung');
});

test('xưởng: lượt đã dùng hôm nay và lượt còn (giờ Việt Nam), chỉ khi sổ có số của hôm nay', async () => {
  const { vnToday } = await import('./views/studio-box.js');
  const { usedToday, remainText } = await import('./views/studio-quota.js');
  assert.equal(vnToday(Date.UTC(2026, 9, 7, 17, 30)), '2026-10-08', '00:30 sáng giờ Việt Nam đã sang ngày mới');
  const usage = { days: [{ date: '2026-10-08', people: [{ uid: '1234567890123456', jobs: 3, refunded: 1 }] }] };
  assert.equal(usedToday(usage, '1234567890123456', '2026-10-08'), 2, 'việc được trả lượt không tính');
  assert.equal(usedToday(usage, '2234567890123456', '2026-10-08'), 0);
  assert.equal(usedToday(usage, '1234567890123456', '2026-10-09'), 0, 'số của hôm qua không tính cho hôm nay');
  assert.equal(usedToday(null, '1234567890123456', '2026-10-08'), null, 'chưa đọc được sổ → không hiện');
  assert.equal(usedToday({ error: 'unreadable', days: [] }, '1234567890123456', '2026-10-08'), null);
  assert.equal(remainText(2, '5'), 'Hôm nay đã dùng 2 · còn 3');
  assert.equal(remainText(7, '5'), 'Hôm nay đã dùng 7 · hết lượt');
  assert.equal(remainText(0, '0'), 'Hôm nay đã dùng 0 · hết lượt');
  assert.equal(remainText(1, '9x'), 'Hôm nay đã dùng 1');
  assert.equal(remainText(null, '5'), '');
});

test('xưởng: Sức khoẻ máy chủ gộp lượt theo người, nhãn trạng thái dễ hiểu', async () => {
  const { studioPeople, studioStatus, STUDIO_KINDS } = await import('./views/health.js');
  const p = (uid, name, jobs, tokens, images = 0) => ({ uid, name, jobs, ok: jobs, failed: 0, refunded: 0, inputTokens: tokens, outputTokens: 0, images });
  const rows = studioPeople([{ people: [p('1', 'Lan', 1, 10, 4), p('2', 'Nam', 1, 5)] }, { people: [p('2', '', 3, 1, 2)] }]);
  assert.deepEqual(rows.map((r) => [r.name, r.jobs, r.tokens, r.images]), [['Nam', 4, 6, 2], ['Lan', 1, 10, 4]]);
  assert.deepEqual(studioStatus('refunded'), ['idle', 'Trả lượt']);
  assert.deepEqual(studioStatus('lạ'), ['danger', 'Không làm được']);
  assert.deepEqual(Object.keys(STUDIO_KINDS), ['slide', 'giao_an', 'van_ban', 'van_ban_doan', 'van_ban_dang', 'de_kiem_tra', 'de_tieng_anh', 'skkn', 'tro_choi', 'thi_nghiem', 'video', 'video_bai_giang']);
});

test('xưởng: việc hỏng mà không được trả lượt (đã trả đủ hạn mức trong ngày) ghi rõ "lượt bị tính dù lỗi"', async () => {
  const { jobBadge } = await import('./views/health.js');
  assert.deepEqual(jobBadge({ status: 'failed', refundDenied: true }), { kind: 'danger', text: 'Không làm được', note: 'lượt bị tính dù lỗi' });
  assert.deepEqual(jobBadge({ status: 'failed' }), { kind: 'danger', text: 'Không làm được', note: '' });
  assert.deepEqual(jobBadge({ status: 'ok', refundDenied: true }), { kind: 'ok', text: 'Đã gửi', note: '' });
});

test('media: rút link https, bỏ dấu câu dính cuối, giữ ngoặc cân, không trùng, không nhận http/javascript', async () => {
  const { extractUrls } = await import('./media.js');
  assert.deepEqual(extractUrls('Xem https://docs.google.com/d/1/edit?usp=sharing, rồi https://forms.gle/abc.'), [
    'https://docs.google.com/d/1/edit?usp=sharing', 'https://forms.gle/abc',
  ]);
  assert.deepEqual(extractUrls('(https://vi.wikipedia.org/wiki/A_(B))'), ['https://vi.wikipedia.org/wiki/A_(B)']);
  assert.deepEqual(extractUrls('“https://facebook.com/x” và https://facebook.com/x'), ['https://facebook.com/x']);
  assert.deepEqual(extractUrls('http://a.vn javascript:alert(1) https://user:pw@a.vn/ https://a.vn:8443/x data:x'), []);
  // Danh thiếp: link trong JSON có "\/" không phải link thật.
  assert.deepEqual(extractUrls('Mai\n{"qrCodeUrl":"https:\\/\\/qr-talk.zdn.vn\\/0\\/a.jpg"}\nhttps://zalo.me'), ['https://zalo.me']);
});

test('media: máy chủ Zalo — chỉ tên miền con thật, không giả đuôi, không IP', async () => {
  const { isImageUrl, isFileUrl, isZaloCdn } = await import('./media.js');
  for (const ok of ['https://photo-stal-27.zdn.vn/gr/jpg/a/b.jpg', 'https://b-f64-zpg-r.zdn.vn/1/2.jpg', 'https://f64-zpg-r.zdn.vn/x.jpg', 'https://res-zalo.zadn.vn/a.png']) {
    assert.equal(isImageUrl(ok), true, ok);
  }
  for (const bad of ['https://zdn.vn/a.jpg', 'https://evilzdn.vn/a.jpg', 'https://zdn.vn.evil.com/a.jpg', 'http://photo-stal-1.zdn.vn/a.jpg',
    'https://photo-stal-1.zdn.vn:444/a.jpg', 'https://u:p@photo-stal-1.zdn.vn/a.jpg', 'https://127.0.0.1/a.jpg', 'https://file-stal-1.dlfl.vn/a', 'javascript:alert(1)']) {
    assert.equal(isImageUrl(bad), false, bad);
  }
  assert.equal(isFileUrl('https://file-stal-18.dlfl.vn/gr/x/y'), true);
  assert.equal(isFileUrl('https://video-stal-46.dlmd.me/gr/x'), true);
  assert.equal(isFileUrl('https://dlfl.vn.evil.com/x'), false);
  assert.equal(isZaloCdn('https://docs.google.com/x'), false);
});

test('media: phân loại tin ảnh (có/không chú thích), video, tệp đúng dạng bot lưu', async () => {
  const { classifyMedia, fileExt } = await import('./media.js');
  const photo = 'https://photo-stal-27.zdn.vn/gr/jpg/4465fc927e4faf11f65e/2aOboR44.jpg';
  assert.deepEqual(classifyMedia('chat.photo', photo), { kind: 'photo', url: photo, caption: '' });
  assert.deepEqual(classifyMedia('chat.photo', `Cô ơi file gộp thế nào ạ\n${photo}`), { kind: 'photo', url: photo, caption: 'Cô ơi file gộp thế nào ạ' });
  assert.equal(classifyMedia('chat.photo', 'https://evil.vn/a.jpg'), null);
  const video = 'https://video-stal-46.dlmd.me/gr/1f78a5bfe81c36426f0d/2aOboR36';
  assert.deepEqual(classifyMedia('chat.video.msg', video), { kind: 'video', url: video, caption: '' });
  const file = 'https://file-stal-18.dlfl.vn/gr/4e7412403493e5cdbc82/2aOboR448c';
  assert.deepEqual(classifyMedia('share.file', `30.TrT HS Mua 5.pdf\n${file}`), { kind: 'file', name: '30.TrT HS Mua 5.pdf', url: file, ext: 'pdf' });
  assert.equal(classifyMedia('share.file', 'KH.docx\nhttps://evil.vn/x'), null);
  assert.equal(classifyMedia('webchat', photo), null);
  assert.equal(fileExt('Danh sách.XLSX'), 'xlsx');
  assert.equal(fileExt('khong-duoi'), '');
});

test('media: link — thẻ link có tiêu đề, link trong chữ, bỏ link ảnh/tệp Zalo, không trùng trong một tin', async () => {
  const { linksOf } = await import('./media.js');
  assert.deepEqual(linksOf('chat.recommended', 'https://docs.google.com/document/d/1/edit\n- BÁO CÁO THÀNH TÍCH'), [
    { url: 'https://docs.google.com/document/d/1/edit', host: 'docs.google.com', title: '- BÁO CÁO THÀNH TÍCH' },
  ]);
  assert.deepEqual(linksOf('chat.recommended', 'https://www.facebook.com/share/v/1cWZ4Dj7by/'), [{ url: 'https://www.facebook.com/share/v/1cWZ4Dj7by/', host: 'www.facebook.com' }]);
  assert.deepEqual(linksOf('webchat', 'Nộp ở https://forms.gle/x và https://forms.gle/x, ảnh https://photo-stal-1.zdn.vn/a.jpg'), [{ url: 'https://forms.gle/x', host: 'forms.gle' }]);
  assert.deepEqual(linksOf('legacy-hermes', 'cnay đi đc k\nhttps://photo-stal-15.zdn.vn/gr/jpg/b/c.jpg'), []);
  assert.deepEqual(linksOf('chat.photo', 'https://drive.google.com/x'), []);
  assert.deepEqual(linksOf('share.file', 'a.pdf\nhttps://file-stal-1.dlfl.vn/x'), []);
});

test('Phiên chat: ảnh lỗi — 404 là Zalo đã xoá; bận/lỗi tạm thì tự thử lại một lần rồi mới báo "bấm để thử lại"', async () => {
  const { imageFailure, IMAGE_TEXT } = await import('./views/chat-media.js');
  assert.equal(imageFailure(404, false), 'gone');
  assert.equal(imageFailure(404, true), 'gone');
  for (const s of [429, 503, 502, 504, 0, 200]) {
    assert.equal(imageFailure(s, false), 'retry', String(s));
    assert.equal(imageFailure(s, true), 'busy', String(s));
  }
  for (const s of [400, 401, 403, 500]) assert.equal(imageFailure(s, false), 'failed', String(s));
  assert.equal(IMAGE_TEXT.busy, 'Đang tải nhiều ảnh — bấm để thử lại');
  // "Zalo đã xoá" chỉ dùng cho 404.
  for (const [k, v] of Object.entries(IMAGE_TEXT)) {
    if (k.startsWith('gone')) assert.match(v, /Zalo đã xoá/, k); else assert.doesNotMatch(v, /xoá/, k);
  }
});

test('Phiên chat: hàng chờ ảnh — tối đa 3 ảnh cùng lúc (dưới mức 4 ảnh/người của máy chủ), nhả chỗ thì người chờ tiếp theo vào', async () => {
  const { acquireSlot, releaseSlot, IMAGE_SLOTS } = await import('./views/chat-media.js');
  assert.equal(IMAGE_SLOTS, 3);
  const got = [];
  const all = Array.from({ length: 5 }, (_, i) => acquireSlot().then(() => got.push(i)));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(got, [0, 1, 2]);
  releaseSlot(); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(got, [0, 1, 2, 3]);
  releaseSlot(); await Promise.all(all);
  assert.deepEqual(got, [0, 1, 2, 3, 4]);
  for (let i = 0; i < 3; i += 1) releaseSlot();
  // Trả hết chỗ: lại vào ngay được 3.
  const again = []; for (let i = 0; i < 3; i += 1) acquireSlot().then(() => again.push(i));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(again.length, 3);
  for (let i = 0; i < 3; i += 1) releaseSlot();
});

test('Phiên chat: khung xem ảnh giữ Tab bên trong, khoá cuộn trang; bảng bên trả tiêu điểm về nút mở', async () => {
  const { trapTab } = await import('./views/chat-media.js');
  const a = { focus() { globalThis.document.activeElement = a; } };
  const b = { focus() { globalThis.document.activeElement = b; } };
  const box = { querySelectorAll: () => [a, b] };
  const prevDoc = globalThis.document;
  globalThis.document = { activeElement: b };
  try {
    let prevented = false;
    trapTab({ key: 'Tab', shiftKey: false, preventDefault: () => { prevented = true; } }, box);
    assert.equal(globalThis.document.activeElement, a); assert.equal(prevented, true);
    trapTab({ key: 'Tab', shiftKey: true, preventDefault: () => {} }, box);
    assert.equal(globalThis.document.activeElement, b);
    prevented = false;
    trapTab({ key: 'Tab', shiftKey: true, preventDefault: () => { prevented = true; } }, box); // b → a: để trình duyệt tự đi
    assert.equal(prevented, false);
  } finally { globalThis.document = prevDoc; }
  const media = readFileSync(join(root, 'views/chat-media.js'), 'utf8');
  assert.match(media, /classList\.add\('no-scroll'\)/);
  assert.match(media, /classList\.remove\('no-scroll'\)/);
  assert.match(readFileSync(join(root, 'style.css'), 'utf8'), /body\.no-scroll \{ overflow: hidden; \}/);
  const chats = readFileSync(join(root, 'views/chats.js'), 'utf8');
  assert.match(chats, /onClose=\$\{\(\) => closeSide\('search'\)\}/);
  assert.match(chats, /onClose=\$\{\(\) => closeSide\('media'\)\}/);
});

test('Phiên chat: biểu tượng tệp theo đuôi, đoạn chữ quanh chỗ trùng, đường ảnh đi qua dashboard', async () => {
  const { fileBadge } = await import('./views/chat-media.js');
  const { snippet } = await import('./views/chats.js');
  const { proxied } = await import('./media.js');
  assert.deepEqual(fileBadge('pdf'), { label: 'PDF', tone: 'pdf' });
  assert.deepEqual(fileBadge('DOCX'), { label: 'DOC', tone: 'doc' });
  assert.deepEqual(fileBadge('xlsx'), { label: 'XLS', tone: 'xls' });
  assert.deepEqual(fileBadge('heic'), { label: 'HEIC', tone: 'other' });
  assert.deepEqual(fileBadge(''), { label: 'TỆP', tone: 'other' });
  assert.equal(snippet('ngắn học sinh', 'hoc sinh'), 'ngắn học sinh');
  assert.equal(snippet(`${'x'.repeat(100)} học sinh`, 'hoc sinh'), `…${'x'.repeat(29)} học sinh`);
  assert.equal(proxied('https://photo-stal-1.zdn.vn/a b.jpg?x=1&y=2'), '/api/media/img?u=https%3A%2F%2Fphoto-stal-1.zdn.vn%2Fa%20b.jpg%3Fx%3D1%26y%3D2');
});

test('Phiên chat: link ngoài (tệp, video, ảnh gốc, link) luôn mở thẻ mới với rel="noopener noreferrer"', () => {
  for (const f of ['views/chat-media.js', 'views/chats.js']) {
    const src = readFileSync(join(root, f), 'utf8');
    const anchors = [...src.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(anchors.length > 0, f);
    for (const a of anchors) {
      assert.match(a, /target="_blank"/, `${f}: ${a}`);
      assert.match(a, /rel="noopener noreferrer"/, `${f}: ${a}`);
    }
  }
});

// --- Giai đoạn 7 (spec §18): thanh bên theo dashboard mẫu, đường dẫn vị trí, dòng phụ thương hiệu ---
test('thanh bên: 5 nhóm theo mẫu; Second brain chỉ Quản trị và chỉ khi máy chủ bật; nhóm rỗng ẩn', async () => {
  const { visibleGroups } = await import('./views/shell.js');
  const admin = visibleGroups('admin', { secondBrain: true });
  assert.deepEqual(admin.map((g) => g.label), ['Tổng quan', 'Hội thoại', 'Dữ liệu', 'Hệ thống', 'Quản trị']);
  assert.deepEqual(admin[1].items.map((i) => i.text), ['Phiên chat', 'Liên hệ', 'Phân quyền Bot', 'Lịch hẹn']);
  assert.deepEqual(admin[2].items.map((i) => i.text), ['Trí nhớ', 'Kho tri thức', 'Insight nhóm', 'Second brain', 'Kết nối MCP']);
  assert.deepEqual(admin[3].items.map((i) => i.text), ['Tài khoản Zalo', 'Agent', 'Khoá API & Model', 'Công cụ', 'Skill', 'Nhật ký', 'Thương hiệu', 'Sức khoẻ máy chủ', 'Bảo trì', 'Cấu hình']);
  const owner = visibleGroups('owner', { secondBrain: true });
  assert.deepEqual(owner.map((g) => g.label), ['Tổng quan', 'Hội thoại', 'Dữ liệu', 'Hệ thống']);
  assert.ok(!owner.flatMap((g) => g.items).some((i) => i.admin), 'Chủ bot không thấy mục admin nào');
  assert.ok(!visibleGroups('admin', {}).flatMap((g) => g.items).some((i) => i.path === '/second-brain'), 'tính năng tắt (Windows / chưa đặt ZALO_SECOND_BRAIN_URL) → ẩn');
});

test('đường dẫn vị trí: "Nhóm / Trang"; Tổng quan và trang lạ không có; Tài khoản của tôi một cấp', async () => {
  const { crumbsFor } = await import('./views/shell.js');
  assert.deepEqual(crumbsFor('/brand'), ['Hệ thống', 'Thương hiệu']);
  assert.deepEqual(crumbsFor('/kb'), ['Dữ liệu', 'Kho tri thức']);
  assert.deepEqual(crumbsFor('/users'), ['Quản trị', 'Người dùng']);
  assert.deepEqual(crumbsFor('/'), []);
  assert.deepEqual(crumbsFor('/khong-co'), []);
  assert.deepEqual(crumbsFor('/profile'), ['Tài khoản của tôi']);
});

test('menu "Thêm" trên điện thoại chia theo nhóm, giữ thứ tự thanh bên', async () => {
  const { navSplit, moreSections } = await import('./views/shell.js');
  const secs = moreSections(navSplit('owner', '/').more);
  assert.deepEqual(secs.map((s) => s.label), ['Hội thoại', 'Dữ liệu', 'Hệ thống', 'Tài khoản']);
  assert.deepEqual(secs[0].items.map((i) => i.path), ['/contacts', '/schedules']);
});

test('mọi trang trong thanh bên đều có route; mục/nhóm Quản trị thì route cũng chỉ Quản trị', async () => {
  const { GROUPS } = await import('./views/shell.js');
  const src = readFileSync(join(root, 'views', 'shell.js'), 'utf8');
  const routes = new Map([...src.matchAll(/'(\/[^']*)': \{ view: \w+(, admin: true)? \}/g)].map((m) => [m[1], Boolean(m[2])]));
  for (const g of GROUPS) {
    for (const it of g.items) {
      assert.ok(routes.has(it.path), it.path);
      assert.equal(routes.get(it.path), Boolean(g.admin || it.admin), it.path);
    }
  }
});

test('Liên hệ: nhãn nguồn theo thứ tự chủ nhân → bạn bè → nhắn riêng → hồ sơ; bộ lọc dùng nút chip', async () => {
  const { contactBadges, KINDS } = await import('./views/contacts.js');
  assert.deepEqual(contactBadges({ owner: true, friend: true, lastDmAt: 5, profile: { name: 'x' } }), ['Chủ nhân', 'Bạn bè', 'Đã nhắn riêng', 'Có hồ sơ']);
  assert.deepEqual(contactBadges({ owner: false, friend: false, lastDmAt: null, profile: null }), []);
  assert.deepEqual(KINDS.map((k) => k.value), ['all', 'friend', 'dm', 'profile']);
  assert.match(readFileSync(join(root, 'views', 'contacts.js'), 'utf8'), /class="btn btn-secondary btn-sm chip"/);
});

test('Trí nhớ: bản nháp hồ sơ giữ nơi dùng, thân gửi bỏ dòng trống và nơi dùng; chữ dung lượng bộ nhớ', async () => {
  const { personDraft, personPayload, usageText, placesText, FIELD_PRESETS } = await import('./views/memory.js');
  const d = personDraft({ name: 'Lan', note: '', fields: [{ key: 'môn', value: 'Hoá', places: ['Nhóm Đoàn'] }] });
  assert.deepEqual(d.fields, [{ key: 'môn', value: 'Hoá', places: ['Nhóm Đoàn'] }]);
  d.fields.push({ key: '', value: '', places: [] });
  assert.deepEqual(personPayload(d), { name: 'Lan', note: '', fields: [{ key: 'môn', value: 'Hoá' }] });
  assert.equal(placesText([]), 'Chỉ khi nhắn riêng');
  assert.equal(placesText(['Nhóm Đoàn', 'Nhắn riêng']), 'Nhóm Đoàn, Nhắn riêng');
  assert.ok(FIELD_PRESETS.includes('Chức vụ'));
  assert.equal(personPayload(d, 1234).updatedAt, 1234, 'gửi mốc sửa khách đã thấy');
  assert.equal(personPayload(d, null).updatedAt, null);
  assert.equal(usageText(1100, 2200), '1.100/2.200 ký tự (50 %)');
  assert.equal(usageText(3000, 2200), '3.000/2.200 ký tự (100 %)');
  const src = readFileSync(join(root, 'views', 'memory.js'), 'utf8');
  assert.match(src, /me\?\.role === 'admin' \? html`<\$\{AgentMemory\}/, 'bộ nhớ trợ lý chỉ hiện cho Quản trị');
  assert.match(src, /err\.status === 409\) onStale/, 'gặp 409 thì tải lại danh sách');
});

test('Lịch hẹn: trạng thái việc hẹn giờ, lọc không dấu, nhãn lặp lại của lời nhắc', async () => {
  const { jobState, filterJobs, REPEAT_LABELS } = await import('./views/schedules.js');
  assert.deepEqual(jobState({ enabled: true, paused: false, lastStatus: 'ok' }), { kind: 'ok', text: 'Đang chạy' });
  assert.deepEqual(jobState({ enabled: true, paused: true, lastStatus: 'ok' }), { kind: 'warn', text: 'Tạm dừng' });
  assert.deepEqual(jobState({ enabled: true, paused: false, lastStatus: 'error' }), { kind: 'danger', text: 'Lần trước lỗi' });
  assert.deepEqual(jobState({ enabled: false }), { kind: 'idle', text: 'Đã tắt' });
  const jobs = [{ name: 'Nhắc nộp bài', prompt: '', targetName: 'Tổ Hoá', creatorName: 'Lan' }, { name: 'Tin sáng', prompt: '', targetName: 'Anh', creatorName: '' }];
  assert.deepEqual(filterJobs(jobs, 'to hoa').map((j) => j.name), ['Nhắc nộp bài']);
  assert.equal(filterJobs(jobs, '').length, 2);
  assert.equal(REPEAT_LABELS[2], 'Hằng tuần');
});

test('Kho tri thức: cỡ tệp dễ đọc; kiểm đuôi/cỡ trước khi gửi', async () => {
  const { fmtSize, uploadProblem } = await import('./views/kb.js');
  assert.equal(fmtSize(512), '512 B');
  assert.equal(fmtSize(1536), '1,5 KB');
  assert.equal(fmtSize(3.4 * 1024 * 1024), '3,4 MB');
  const types = ['.docx', '.pdf', '.md', '.txt'];
  assert.equal(uploadProblem({ name: 'a.PDF', size: 10 }, types, 100), '');
  assert.match(uploadProblem({ name: 'a.exe', size: 10 }, types, 100), /Chỉ nhận/);
  assert.match(uploadProblem({ name: 'a.pdf', size: 101 }, types, 100), /quá/);
  assert.match(uploadProblem({ name: 'a.pdf', size: 0 }, types, 100), /rỗng/);
});

test('Insight nhóm: mức màu bản đồ giờ 0–4, nhãn ngày, thứ bắt đầu từ T2', async () => {
  const { heatLevel, dayLabel, WEEKDAYS, KIND_LABELS } = await import('./views/insight.js');
  assert.equal(heatLevel(0, 10), 0);
  assert.equal(heatLevel(1, 10), 1);
  assert.equal(heatLevel(5, 10), 2);
  assert.equal(heatLevel(10, 10), 4);
  assert.equal(heatLevel(3, 0), 0);
  assert.equal(dayLabel('2026-10-07'), '07/10');
  assert.equal(WEEKDAYS[0], 'T2');
  assert.equal(WEEKDAYS[6], 'CN');
  assert.deepEqual(Object.keys(KIND_LABELS), ['text', 'photo', 'file', 'link', 'sticker', 'voice', 'other']);
});

test('Insight: câu trạng thái tóm tắt AI — đang chờ, quá hạn, lỗi của plugin, thành công thì không có câu', async () => {
  const { summaryStatusText, POLL_MS } = await import('./views/insight-ai.js');
  assert.match(summaryStatusText({ status: 'pending' }), /Đang nhờ trợ lý/);
  assert.match(summaryStatusText({ status: 'timeout' }), /3 phút/);
  assert.equal(summaryStatusText({ status: 'done', result: { ok: false, error: 'Đã hết lượt tóm tắt hôm nay' } }), 'Đã hết lượt tóm tắt hôm nay');
  assert.equal(summaryStatusText({ status: 'done', result: { ok: true, summary: {} } }), '');
  assert.equal(POLL_MS, 3000);
});

test('Second brain: tên ngắn của mục, lên một cấp không vượt khỏi gốc', async () => {
  const { entryName, parentUri } = await import('./views/second-brain.js');
  assert.equal(entryName('viking://user/default/memories/knowledge/zalo%20bot.md'), 'zalo bot');
  assert.equal(entryName('viking://resources/'), 'resources');
  const root = 'viking://user/default/memories';
  assert.equal(parentUri(root, root), null);
  assert.equal(parentUri(`${root}/knowledge/a`, root), `${root}/knowledge`);
  assert.equal(parentUri(`${root}/knowledge`, root), root);
});

// --- Giai đoạn 7B (spec §18.6): trang Hệ thống của Quản trị ---

test('dải chờ khởi động lại: gộp lý do; có cờ kết nối Zalo thì nói cả hai; không có gì thì rỗng', async () => {
  const { restartText } = await import('./views/restart-banner.js');
  assert.equal(restartText({ assistant: null, sidecar: null }), '');
  assert.equal(restartText({ assistant: { reasons: ['Đổi model'] }, sidecar: null }), 'Đã đổi: Đổi model. Cần khởi động lại trợ lý để áp dụng (bot im khoảng 1–3 phút).');
  assert.match(restartText({ assistant: null, sidecar: { reasons: ['Cấu hình: kết bạn'] } }), /trợ lý và kết nối Zalo/);
});

test('Agent: danh sách model — đang dùng đầu, chọn nhanh, phần còn lại lọc theo chữ, không trùng', async () => {
  const { modelOptions, REASONING_LABELS } = await import('./views/agent.js');
  assert.deepEqual(modelOptions({ current: 'hermes', choices: ['hermes', 'b'], all: ['a', 'b', 'gemini-x'], q: 'gem' }), ['hermes', 'b', 'gemini-x']);
  assert.deepEqual(modelOptions({ current: '', choices: [], all: ['a'], q: '' }), ['a']);
  assert.equal(REASONING_LABELS.medium, 'Vừa (mặc định)');
});

test('Công cụ: nhóm theo mức quyền giữ thứ tự; đếm thay đổi hai chiều', async () => {
  const { groupTools, offDiff } = await import('./views/tools.js');
  assert.deepEqual(groupTools([{ level: 'Mọi người', name: 'a' }, { level: 'Chỉ chủ nhân', name: 'b' }, { level: 'Mọi người', name: 'c' }]).map((g) => [g.level, g.list.length]),
    [['Mọi người', 2], ['Chỉ chủ nhân', 1]]);
  assert.equal(offDiff(new Set(['a', 'b']), new Set(['b', 'c'])), 2);
  assert.equal(offDiff(new Set(), new Set()), 0);
});

test('Theo dõi agent: thời gian dễ đọc', async () => {
  const { fmtMs } = await import('./views/trace.js');
  assert.equal(fmtMs(null), '—');
  assert.equal(fmtMs(850), '850 ms');
  assert.equal(fmtMs(2500), '2,5 giây');
  assert.equal(fmtMs(65_000), '1 phút 5 giây');
});

test('trang gọn: Theo dõi agent tóm tắt phiên một dòng; Kho tri thức chỉ đếm tệp của nguồn', async () => {
  const { chatSummary, chatLabel } = await import('./views/trace.js');
  assert.equal(chatSummary({ turns: 64, toolCalls: 5, sessions: 18 }), '64 lượt · 5 công cụ · 18 phiên');
  assert.equal(chatSummary({ turns: 3, toolCalls: 0, sessions: 1 }), '3 lượt');
  assert.equal(chatSummary({ turns: 0, toolCalls: 0, sessions: 1 }), 'Chưa có lượt nào');
  assert.equal(chatLabel({ chatName: 'AI Y Tế', title: 'x' }), 'AI Y Tế');
  assert.equal(chatLabel({ chatName: '', title: 'Báo cáo sáng', source: 'cron' }), 'Báo cáo sáng');
  const { sourceCount } = await import('./views/kb.js');
  assert.equal(sourceCount({ files: 1214, links: 3 }), '1.214 tệp · 3 link');
  assert.equal(sourceCount({ files: 0, links: 2 }), '2 link');
  assert.equal(sourceCount({ files: 0, links: 0 }), 'Chưa có tệp');
});

test('Kết nối MCP: màu trạng thái', async () => {
  const { mcpKind } = await import('./views/mcp.js');
  assert.deepEqual(['Đang mở', 'Không phản hồi', 'Đã tắt', 'Máy ngoài — không kiểm'].map(mcpKind), ['ok', 'danger', 'idle', 'warn']);
  assert.equal(mcpKind('Chạy cùng trợ lý — không kiểm được từ dashboard'), 'idle');
});

test('Cấu hình: chữ nhập thành giá trị đúng kiểu; chỉ gửi mục đã đổi', async () => {
  const { parseInput, changedValues } = await import('./views/settings.js');
  assert.equal(parseInput({ type: 'int' }, ' 12 '), 12);
  assert.ok(Number.isNaN(parseInput({ type: 'int' }, '12a')));
  assert.deepEqual(parseInput({ type: 'ids' }, '111, 222,,'), ['111', '222']);
  const list = [{ id: 'a', value: 6 }, { id: 'b', value: ['1'] }, { id: 'c', value: true }];
  assert.deepEqual(changedValues(list, { a: 6, b: ['1', '2'], c: false }), { b: ['1', '2'], c: false });
});

test('Kho tri thức tự học: nhãn nhóm/người (có chủ nhân), tên mục dịch sang tiếng Việt', async () => {
  const { scopeLabel, entryLabel } = await import('./views/learned-memory.js');
  assert.equal(scopeLabel({ kind: 'group', id: '2054797107487294899', name: 'Tổ Hoá', owner: false }), 'Tổ Hoá');
  assert.equal(scopeLabel({ kind: 'dm', id: '1234567890123456789', name: '', owner: true }), 'Người …6789 (chủ nhân)');
  assert.equal(entryLabel('viking://user/zalo-g-1/memories/preferences'), 'Sở thích, cách xưng hô');
  assert.equal(entryLabel('viking://user/zalo-g-1/memories/events/mem_ab12.md'), 'mem_ab12');
  const { intervalText } = await import('./views/learned-memory.js');
  assert.deepEqual([intervalText(120), intervalText(45), intervalText(1440)], ['120 phút (2 giờ)', '45 phút', '1440 phút (24 giờ)']);
});

test('Lịch hẹn: thêm giờ cùng số phút không trùng; việc một lần đã qua bị chặn', async () => {
  const { nextTime, pastProblem } = await import('./views/schedules.js');
  assert.equal(nextTime(['08:30']), '09:30');
  assert.equal(nextTime(['08:00', '09:00']), '10:00');
  assert.equal(nextTime(['23:15']), '00:15');
  const now = Date.parse('2026-10-09T15:00:00+07:00');
  assert.match(pastProblem({ repeat: 'once', date: '2026-10-09', times: ['14:59'] }, now), /đã qua/);
  assert.equal(pastProblem({ repeat: 'once', date: '2026-10-09', times: ['15:01'] }, now), '');
  assert.equal(pastProblem({ repeat: 'daily', times: ['01:00'] }, now), '');
});

test('Lịch hẹn › Luồng: thêm/bỏ nơi gửi — không trùng, tối đa 10, luôn còn ít nhất một nơi', async () => {
  const { flowTargetsChange } = await import('./views/schedules.js');
  const job = { targets: ['1', '2'] };
  assert.deepEqual(flowTargetsChange(job, 'add', '3'), ['1', '2', '3']);
  assert.equal(flowTargetsChange(job, 'add', '2'), null);
  assert.equal(flowTargetsChange({ targets: Array.from({ length: 10 }, (_, i) => String(i)) }, 'add', '99'), null);
  assert.deepEqual(flowTargetsChange(job, 'remove', '1'), ['2']);
  assert.equal(flowTargetsChange({ targets: ['1'] }, 'remove', '1'), null, 'không bỏ nơi gửi cuối cùng');
});

test('Skill: câu kết quả quét an toàn, lọc skill không dấu', async () => {
  const { scanText, matchSkill } = await import('./views/skills.js');
  assert.equal(scanText({ policy: 'allow', counts: { low: 0 } }), 'Đạt kiểm tra an toàn.');
  assert.equal(scanText({ policy: 'allow', counts: { low: 2 } }), 'Đạt kiểm tra an toàn — 2 điểm cần chú ý.');
  assert.match(scanText({ policy: 'block', verdict: 'dangerous', trust: 'community', counts: { critical: 1 } }), /^Không cài được: .*“Nguy hiểm”.*Cộng đồng — 1 điểm/);
  assert.equal(matchSkill({ name: 'soan-van-ban', description: 'Soạn công văn hành chính' }, 'cong van'), true);
  assert.equal(matchSkill({ name: 'pdf', description: 'Đọc PDF' }, 'excel'), false);
});

test('MCP: câu kết quả kiểm tra kết nối', async () => {
  const { testText } = await import('./views/mcp.js');
  assert.equal(testText({ needsLogin: true }), 'Chưa đăng nhập — bấm Đăng nhập.');
  assert.equal(testText({ connected: false, error: 'timeout' }), 'Không kết nối được: timeout');
  assert.equal(testText({ connected: true, tools: [{ enabled: true }, { enabled: true }] }), 'Kết nối được — 2 công cụ.');
  assert.equal(testText({ connected: true, tools: [{ enabled: true }, { enabled: false }] }), 'Kết nối được — dùng 1/2 công cụ.');
});

test('Bảo trì: định dạng dung lượng và giờ điểm khôi phục', async () => {
  const { fmtSize, snapshotTime } = await import('./views/maintenance.js');
  assert.equal(fmtSize(512), '512 B');
  assert.equal(fmtSize(37275530), '35,5 MB');
  assert.equal(snapshotTime('20261010-134504-dashboard'), '10/10/2026 13:45');
  assert.equal(snapshotTime('la'), 'la');
});

test('Ủng hộ tác giả: thông tin chuyển khoản và ảnh QR có sẵn trong giao diện', async () => {
  const { DONATE } = await import('./views/donate.js');
  assert.deepEqual(DONATE, { bank: 'MB Bank', account: '0328186264', name: 'LUONG HAI ANH' });
  const { existsSync } = await import('node:fs');
  assert.ok(existsSync(new URL('./donate-qr.jpg', import.meta.url)));
});

test('thanh trạng thái: nhãn bản mới / đang cập nhật', async () => {
  const { noticeText } = await import('./views/shell.js');
  assert.equal(noticeText(null), '');
  assert.equal(noticeText({ newer: false }), '');
  assert.equal(noticeText({ newer: true, latest: 'v2.9.0' }), 'Có bản mới v2.9.0');
  assert.equal(noticeText({ newer: true, latest: 'v2.9.0', updating: true }), 'Đang cập nhật bot…');
});
