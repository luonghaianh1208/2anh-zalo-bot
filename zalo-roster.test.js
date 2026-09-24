import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGuestGroups, loadRoster, reloadGuestGroupsIfChanged, reloadRosterIfChanged } from './zalo-roster.js';

function source(t, name, body) {
  const dir = mkdtempSync(join(tmpdir(), 'zalo-roster-'));
  const path = join(dir, name);
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path;
}

test('roster accepts only canonical owner and guest arrays', (t) => {
  const roster = loadRoster(source(t, 'roster.json', { version: 1, owners: ['owner-a'], guests: ['guest-a'] }));
  assert.deepEqual(roster, { owners: new Set(['owner-a']), guests: new Set(['guest-a']) });
  for (const value of [
    { version: 1, owners: ['owner'] }, { version: 1, owners: [], guests: [], extra: [] },
    { version: 1, owners: ['owner-b', 'owner-a'], guests: [] },
    { version: 1, owners: ['owner user'], guests: [] }, { version: 1, owners: ['owner\u0001'], guests: [] },
    { version: 1, owners: [], guests: [], guestGroups: [] },
  ]) {
    assert.throws(() => loadRoster(source(t, `bad-roster-${Math.random()}.json`, value)));
  }
});

test('guest group source is strict and preserves prior valid scope on reload failure', (t) => {
  const path = source(t, 'guest-groups.json', { version: 1, guestGroups: ['group-a'] });
  const current = loadGuestGroups(path);
  assert.deepEqual(current, new Set(['group-a']));
  writeFileSync(path, '{');
  const errors = [];
  const malformed = reloadGuestGroupsIfChanged(path, current, null, (message) => errors.push(message));
  assert.deepEqual(malformed.groups, current);
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0], /group-a/);
  const next = join(join(path, '..'), '.next');
  writeFileSync(next, JSON.stringify({ version: 1, guestGroups: ['group-b'] }));
  renameSync(next, path);
  assert.deepEqual(reloadGuestGroupsIfChanged(path, current, malformed.state).groups, new Set(['group-b']));
});

test('guest group source rejects noncanonical shapes and identifiers', (t) => {
  assert.throws(() => loadGuestGroups(), /path/);
  for (const value of [
    "{", { version: 1 }, { version: 1, guestGroups: [], extra: [] },
    { version: 1, guestGroups: ['group-b', 'group-a'] }, { version: 1, guestGroups: ['group-a', 'group-a'] },
    { version: 1, guestGroups: ['group a'] }, { version: 1, guestGroups: ['group\u0001'] },
    { version: 1, guestGroups: [7] },
  ]) {
    assert.throws(() => loadGuestGroups(source(t, `bad-groups-${Math.random()}.json`, value)));
  }
});

test('roster reload retains valid scope after canonical schema rejection', (t) => {
  const path = source(t, 'roster.json', { version: 1, owners: ['owner-a'], guests: ['guest-a'] });
  const current = loadRoster(path);
  const errors = [];
  writeFileSync(path, JSON.stringify({ version: 1, owners: ['owner-a'], guests: [], extra: [] }));
  const rejected = reloadRosterIfChanged(path, current, null, (message) => errors.push(message));
  assert.deepEqual(rejected.roster, current);
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0], /owner-a|guest-a/);
});

test('reload retains prior scope for every noncanonical sidecar source', (t) => {
  const cases = [
    [loadGuestGroups, reloadGuestGroupsIfChanged, 'guest-groups.json', { version: 1, guestGroups: ['group-a'] }, [
      { version: 1 }, { version: 1, guestGroups: [], extra: [] },
      { version: 1, guestGroups: ['group-b', 'group-a'] }, { version: 1, guestGroups: ['group a'] },
      { version: 1, guestGroups: ['group\u0001'] },
    ], 'groups'],
    [loadRoster, reloadRosterIfChanged, 'roster.json', { version: 1, owners: ['owner-a'], guests: ['guest-a'] }, [
      { version: 1, owners: ['owner-a'] }, { version: 1, owners: ['owner-a'], guests: [], extra: [] },
      { version: 1, owners: ['owner-b', 'owner-a'], guests: [] }, { version: 1, owners: ['owner a'], guests: [] },
      { version: 1, owners: ['owner\u0001'], guests: [] },
    ], 'roster'],
  ];
  for (const [load, reload, name, valid, invalids, resultKey] of cases) {
    const path = source(t, name, valid);
    const current = load(path);
    for (const invalid of invalids) {
      writeFileSync(path, JSON.stringify(invalid));
      const result = reload(path, current, null, () => {});
      assert.deepEqual(result[resultKey], current);
    }
  }
});
