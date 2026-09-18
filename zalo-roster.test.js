import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { loadRoster, reloadRosterIfChanged } = await import('./zalo-roster.js');

function rosterFile(t, roster) {
  const dir = mkdtempSync(join(tmpdir(), 'zalo-roster-'));
  const path = join(dir, 'roster.json');
  writeFileSync(path, typeof roster === 'string' ? roster : JSON.stringify(roster));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path;
}

test('loadRoster keeps 19-digit Zalo IDs as strings', (t) => {
  const ownerUid = '9000000000000000001';
  const guestUid = '9000000000000000002';
  const groupId = '9000000000000000003';
  const roster = loadRoster(rosterFile(t, {
    version: 1,
    owners: [ownerUid],
    guests: [guestUid],
    guestGroups: [groupId],
  }));

  assert.deepEqual(roster, {
    owners: new Set([ownerUid]),
    guests: new Set([guestUid]),
    guestGroups: new Set([groupId]),
  });
});

// Một roster rỗng KHÔNG phải fail-closed: nó khoá cả chủ nhân ra ngoài và làm
// activeOwnerUids rỗng, đúng khiếm khuyết đã gặp thật hôm 2026-09-17. Thiếu
// roster phải làm tiến trình chết chứ không được chạy tiếp trong im lặng.
test('loadRoster throws when the roster path is absent or the file is missing', () => {
  assert.throws(() => loadRoster(), /ZALO_ROSTER_FILE/);
  assert.throws(
    () => loadRoster(join(tmpdir(), 'zalo-roster-does-not-exist.json')),
    /Không tìm thấy roster/,
  );
});

test('loadRoster rejects invalid JSON, an unsupported version, and conflicting owners', (t) => {
  assert.throws(() => loadRoster(rosterFile(t, '{')), /JSON/);
  assert.throws(() => loadRoster(rosterFile(t, { version: 2, owners: [], guests: [], guestGroups: [] })), /2/);
  assert.throws(() => loadRoster(rosterFile(t, {
    version: 1,
    owners: ['9000000000000000001'],
    guests: ['9000000000000000001'],
    guestGroups: [],
  })), /owners.*guests/);
});

test('reloadRosterIfChanged sees a renamed roster and keeps old roster on malformed or missing files', (t) => {
  const ownerUid = '9000000000000000001';
  const firstGuestUid = '9000000000000000002';
  const secondGuestUid = '9000000000000000003';
  const path = rosterFile(t, {
    version: 1,
    owners: [ownerUid],
    guests: [firstGuestUid],
    guestGroups: [],
  });
  const first = reloadRosterIfChanged(path, loadRoster(path));
  const replacement = join(dirname(path), 'roster-next.json');
  writeFileSync(replacement, JSON.stringify({
    version: 1,
    owners: [ownerUid],
    guests: [firstGuestUid, secondGuestUid],
    guestGroups: [],
  }));
  renameSync(replacement, path);

  const refreshed = reloadRosterIfChanged(path, first.roster, first.state);
  assert.equal(refreshed.roster.guests.has(secondGuestUid), true);

  const errors = [];
  writeFileSync(replacement, '{');
  renameSync(replacement, path);
  const malformed = reloadRosterIfChanged(path, refreshed.roster, refreshed.state, (message) => errors.push(message));
  assert.equal(malformed.roster.guests.has(secondGuestUid), true);
  assert.match(errors.at(-1), /không nạp lại roster.*JSON/);

  rmSync(path);
  const missing = reloadRosterIfChanged(path, malformed.roster, malformed.state, (message) => errors.push(message));
  assert.equal(missing.roster.guests.has(secondGuestUid), true);
  assert.match(errors.at(-1), /không nạp lại roster.*ENOENT/);
});


// Hàm chạy mỗi tin nhắn, nên một roster thiếu không được sinh một dòng log mỗi
// tin. Nêu một lần, rồi im cho tới khi lỗi đổi hoặc roster quay lại.
test('roster thiếu chỉ báo lỗi một lần, không mỗi lần gọi', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'roster.json');
  writeFileSync(path, JSON.stringify({
    version: 1, owners: ['9000000000000000001'], guests: [], guestGroups: [],
  }));

  const errors = [];
  const report = (message) => errors.push(message);
  let current = loadRoster(path);
  let state = null;

  // Một lần đọc thành công để có state.
  ({ roster: current, state } = reloadRosterIfChanged(path, current, state, report));
  assert.equal(errors.length, 0);

  rmSync(path);
  for (let i = 0; i < 5; i += 1) {
    ({ roster: current, state } = reloadRosterIfChanged(path, current, state, report));
  }
  assert.equal(errors.length, 1, `nen chi co 1 dong log, co ${errors.length}`);
  // statSync ném ENOENT trước khi loadRoster kịp cho câu "Không tìm thấy
  // roster", nên thông điệp ở đây là của tầng fs. Khẳng định đúng cái thật.
  assert.match(errors[0], /không nạp lại roster/);
  assert.match(errors[0], /ENOENT/);
  // Roster cũ vẫn được giữ, không câm với chủ nhân.
  assert.equal(current.owners.has('9000000000000000001'), true);

  // Roster quay lại thì lần lỗi sau phải được nêu lại.
  writeFileSync(path, JSON.stringify({
    version: 1, owners: ['9000000000000000001'], guests: [], guestGroups: [],
  }));
  ({ roster: current, state } = reloadRosterIfChanged(path, current, state, report));
  assert.equal(errors.length, 1);
  rmSync(path);
  ({ roster: current, state } = reloadRosterIfChanged(path, current, state, report));
  assert.equal(errors.length, 2, 'sau khi hoi phuc thi loi moi phai duoc neu lai');
});
