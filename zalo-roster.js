import { readFileSync, statSync } from 'node:fs';

function idsOf(value, field) {
  if (!Array.isArray(value) || !value.every((item) => (
    typeof item === 'string' && item && !/[\s\x00-\x1f]/u.test(item)
  ))) {
    throw new Error(`${field} has an invalid shape`);
  }
  const sorted = [...value].sort();
  if (value.length !== new Set(value).size || value.some((item, index) => item !== sorted[index])) {
    throw new Error(`${field} must be sorted and deduplicated`);
  }
  return new Set(value);
}

function readJson(path, label) {
  if (!path) throw new Error(`${label} path is not configured`);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing`, { cause: error });
    throw new Error(`${label} cannot be read`, { cause: error });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} JSON is invalid`, { cause: error });
  }
}

export function emptyRoster() {
  return { owners: new Set(), guests: new Set() };
}

export function emptyGuestGroups() {
  return new Set();
}

export function loadRoster(path) {
  const parsed = readJson(path, 'roster');
  if (!parsed || parsed.version !== 1 || Object.keys(parsed).length !== 3
      || !Object.hasOwn(parsed, 'version') || !Object.hasOwn(parsed, 'owners')
      || !Object.hasOwn(parsed, 'guests')) {
    throw new Error('roster has an unsupported shape');
  }
  const owners = idsOf(parsed.owners, 'roster owners');
  const guests = idsOf(parsed.guests, 'roster guests');
  for (const uid of owners) {
    if (guests.has(uid)) throw new Error('roster owners and guests overlap');
  }
  return { owners, guests };
}

export function loadGuestGroups(path) {
  const parsed = readJson(path, 'guest group store');
  if (!parsed || parsed.version !== 1 || Object.keys(parsed).length !== 2
      || !Object.hasOwn(parsed, 'version') || !Object.hasOwn(parsed, 'guestGroups')) {
    throw new Error('guest group store has an unsupported shape');
  }
  return idsOf(parsed.guestGroups, 'guest group store');
}

function reloadIfChanged(path, current, previousState, load, label, reportError) {
  try {
    const stat = statSync(path);
    const state = { mtimeMs: stat.mtimeMs, size: stat.size, lastError: null };
    if (previousState?.mtimeMs === state.mtimeMs && previousState?.size === state.size) return { value: current, state };
    return { value: load(path), state };
  } catch (error) {
    const reason = String(error?.message || error);
    if (reason !== previousState?.lastError) reportError(`[bot] ${label} reload failed; retaining last valid state`);
    return { value: current, state: { ...(previousState || {}), lastError: reason } };
  }
}

export function reloadRosterIfChanged(path, roster, previousState = null, reportError = console.error) {
  const result = reloadIfChanged(path, roster, previousState, loadRoster, 'roster', reportError);
  return { roster: result.value, state: result.state };
}

export function reloadGuestGroupsIfChanged(path, groups, previousState = null, reportError = console.error) {
  const result = reloadIfChanged(path, groups, previousState, loadGuestGroups, 'guest group store', reportError);
  return { groups: result.value, state: result.state };
}
