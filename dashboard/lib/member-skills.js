// Skill mở cho thành viên (không phải chủ nhân): $HERMES_HOME/zalo/member-skills.json — dashboard ghi, plugin đọc lại
// mỗi lượt (zalo_tools/member_skills.py), không cần khởi động lại trợ lý.
import { readJson, writeJsonAtomic } from './json-store.js';

// Đồng bộ với hermes-plugin/zalo_tools/member_skills.py: skill riêng tư/vận hành không bao giờ mở cho thành viên.
export const BLOCKED_PREFIXES = ['zalo-', 'hermes-', 'github', 'software-development/', 'mlops'];
export const BLOCKED_NAMES = new Set([
  'tin-nhan-zalo', 'google-workspace', 'himalaya', 'email-inbox-triage', 'firebase-gcp-ops', 'claude-code', 'codex',
  'opencode', 'computer-use', 'browser-skill', 'apify', 'xurl', 'discord-community-management', 'airtable', 'box',
  'notion', 'obsidian', 'teams-meeting-pipeline', 'session-librarian', 'merge-reconciler', 'touchdesigner-mcp',
]);

export function isBlocked(name) {
  const n = String(name || '').trim().toLowerCase();
  return !n || BLOCKED_NAMES.has(n) || BLOCKED_PREFIXES.some((p) => n.startsWith(p));
}

export function createMemberSkills(file) {
  const load = () => {
    const data = readJson(file, { skills: [] });
    return [...new Set((Array.isArray(data.skills) ? data.skills : []).filter((n) => typeof n === 'string' && !isBlocked(n)))];
  };
  return {
    list: load,
    /** Mở/đóng một skill cho thành viên; skill bị cấm → lỗi 400. */
    set(name, allowed) {
      const n = String(name || '').trim();
      if (allowed && isBlocked(n)) {
        throw Object.assign(new Error('Skill này chứa việc riêng của chủ bot hoặc thao tác hệ thống — không mở cho thành viên được.'), { statusCode: 400 });
      }
      const cur = load().filter((x) => x !== n);
      writeJsonAtomic(file, { skills: allowed ? [...cur, n] : cur });
      return { name: n, member: Boolean(allowed) };
    },
  };
}
