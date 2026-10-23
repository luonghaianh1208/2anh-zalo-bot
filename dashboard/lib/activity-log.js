import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileAtomic } from './json-store.js';

export function createActivityLog(path, { maxBytes = 5 * 1024 * 1024, now = Date.now } = {}) {
  function rotate() {
    try { if (statSync(path).size > maxBytes) renameSync(path, `${path}.1`); } catch { /* chưa có tệp */ }
  }
  function readLines(p) {
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }
  return {
    append({ actor, action, detail = '', ok = true }) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      rotate();
      const entry = { at: now(), actor: String(actor).slice(0, 64), action: String(action), detail: String(detail).slice(0, 500), ok: Boolean(ok) };
      appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
      return entry;
    },
    /** Xoá mọi dòng có `at` < before (cả tệp xoay vòng .1); trả số dòng đã xoá. */
    prune(before) {
      const all = [...readLines(`${path}.1`), ...readLines(path)];
      const keep = all.filter((e) => !(Number(e?.at) < before));
      if (keep.length === all.length) return 0;
      writeFileAtomic(path, keep.map((e) => `${JSON.stringify(e)}\n`).join(''));
      rmSync(`${path}.1`, { force: true });
      return all.length - keep.length;
    },
    list({ before = Infinity, limit = 50, failedOnly = false } = {}) {
      const n = Number.parseInt(limit, 10);
      return [...readLines(`${path}.1`), ...readLines(path)]
        .filter((e) => e && typeof e === 'object' && Number.isFinite(e.at) && e.at < before && (!failedOnly || e.ok === false))
        .sort((a, b) => b.at - a.at)
        .slice(0, Number.isInteger(n) ? Math.min(Math.max(n, 1), 200) : 50);
    },
  };
}
