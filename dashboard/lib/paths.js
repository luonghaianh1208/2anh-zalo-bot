import { join, resolve } from 'node:path';

export function resolveDashboardPaths({ env = process.env, sidecarRoot }) {
  const home = String(env.HERMES_HOME || '').trim();
  if (!home) throw new Error('Không tìm thấy HERMES_HOME — chạy lại "npm run install:hermes" để bộ cài ghi vào .env của sidecar.');
  const hermesHome = resolve(home);
  const dataDir = join(hermesHome, 'zalo', 'dashboard');
  return {
    sidecarRoot: resolve(sidecarRoot),
    hermesHome,
    dataDir,
    usersFile: join(dataDir, 'users.json'),
    sessionsFile: join(dataDir, 'sessions.json'),
    setupFile: join(dataDir, 'setup.json'),
    telegramFile: join(dataDir, 'telegram.json'),
    watchdogFile: join(dataDir, 'watchdog.json'),
    activityFile: join(dataDir, 'activity.jsonl'),
    brandFile: join(dataDir, 'brand.json'),
    brandLogoFile: join(dataDir, 'brand', 'logo.png'),
    pendingRestartFile: join(dataDir, 'pending-restart.json'),
    // Mọi UID từng là chủ nhân bot: kho trí nhớ DM của họ vẫn chỉ Quản trị thấy sau khi bị bỏ khỏi danh sách.
    everOwnersFile: join(dataDir, 'ever-owners.json'),
    restartFlagsFile: join(dataDir, 'restart-flags.json'),
    soulHistoryDir: join(dataDir, 'soul-history'),
    // Plugin ghi lúc nạp (zalo_tools/tools.py write_tools_manifest) — dashboard chỉ đọc.
    toolsManifestFile: join(hermesHome, 'zalo', 'tools-manifest.json'),
    healthHistoryFile: join(dataDir, 'health-history.json'),
    aiUsageFile: join(dataDir, 'ai-usage.json'),
    // Sổ lượt Xưởng tạo sản phẩm: plugin ghi, dashboard chỉ đọc (spec §17). studio-policy.json: plugin ghi chính sách video.
    studioUsageFile: join(hermesHome, 'zalo', 'studio-usage.json'),
    studioPolicyFile: join(hermesHome, 'zalo', 'studio-policy.json'),
    // Skill mở cho thành viên: dashboard ghi, plugin đọc (zalo_tools/member_skills.py).
    memberSkillsFile: join(hermesHome, 'zalo', 'member-skills.json'),
    hermesStateDb: join(hermesHome, 'state.db'),
    // Giai đoạn 7 (spec §18): sổ người quen của plugin (ZALO_PEOPLE_FILE trong .env Hermes thắng, xem server.js).
    peopleFile: join(hermesHome, 'zalo', 'people.json'),
    // Hàng đợi tóm tắt nhóm bằng AI giữa dashboard và plugin (zalo_tools/insight_ai.py).
    insightDir: join(hermesHome, 'zalo', 'insight'),
    sidecarEnvFile: join(resolve(sidecarRoot), '.env'),
    permissionsFile: join(hermesHome, 'zalo', 'permissions.json'),
    hermesEnvFile: join(hermesHome, '.env'),
    hermesConfigFile: join(hermesHome, 'config.yaml'),
    sqliteFile: join(resolve(sidecarRoot), 'data', 'zalo.sqlite'),
  };
}
