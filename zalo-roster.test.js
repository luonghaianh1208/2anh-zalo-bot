import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { loadRoster } = await import('./zalo-roster.js');

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
