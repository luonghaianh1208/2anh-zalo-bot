#!/usr/bin/env node
/**
 * Dashboard quản trị Zalo — tiến trình riêng. Sống độc lập với sidecar và Hermes
 * để vẫn báo lỗi và cho quét QR đúng lúc các phần kia hỏng.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadRepoEnv, loadHermesEnv } from '../scripts/setup-env.js';
import { createDashboardApp } from './app.js';
import { resolveDashboardPaths } from './lib/paths.js';
import { loadDashboardConfig } from './lib/config.js';
import { createUserStore } from './lib/users.js';
import { createSessionStore } from './lib/sessions.js';
import { createLoginGuard } from './lib/login-guard.js';
import { createSetupToken } from './lib/setup-token.js';
import { createActivityLog } from './lib/activity-log.js';
import { createSidecarClient } from './lib/sidecar-client.js';
import { createTelegramLinker } from './lib/telegram.js';
import { createStoreReader } from './lib/store-reader.js';
import { createThreadNames } from './lib/thread-names.js';
import { createPermissionsStore, makeDmEnv, makeGlobalReplyOnlyTagged } from './lib/permissions.js';
import { createWatchdog } from './lib/watchdog.js';
import { makeRestartSidecar } from './lib/restart.js';
import { makeRestartAssistant } from './lib/restart-assistant.js';
import { createRestartFlags } from './lib/restart-flags.js';
import { createBrandStore } from './lib/brand.js';
import { readEnvKey, SETTINGS_ENV_KEYS } from './lib/env-file.js';
import { createSecondBrain } from './lib/second-brain.js';
import { createLearnedMemory, readProvider } from './lib/learned-memory.js';
import { createPeopleStore } from './lib/people-store.js';
import { createHermesMemory } from './lib/hermes-memory.js';
import { createSchedules, hermesBin } from './lib/schedules.js';
import { createHermesAdmin } from './lib/hermes-admin.js';
import { createMaintenance } from './lib/maintenance.js';
import { createKbStore } from './lib/kb-store.js';
import { createInsightAi } from './lib/insight-ai.js';
import { createAgentConfig, createSoul } from './lib/agent-config.js';
import { createAiKeys } from './lib/ai-keys.js';
import { createAiModels } from './lib/ai-models.js';
import { createAgentTrace } from './lib/agent-trace.js';
import { createMcpServers } from './lib/mcp-servers.js';
import { createSettings } from './lib/settings.js';
import { createOwnersStore } from './lib/owners.js';
import { createServiceChecker } from './lib/services.js';
import { createHealthMonitor } from './lib/health-monitor.js';
import { singleFlight } from './lib/single-flight.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * @param {object} [opts]
 * @param {string} [opts.inheritedReplyOnlyTagged] ZALO_GROUP_REPLY_ONLY_TAGGED trong môi trường dịch vụ, chụp trước khi
 *   nạp .env của sidecar — .env của sidecar không phải nơi bot đọc cờ này.
 * @param {string} [opts.inheritedOwners] ZALO_ALLOWED_USERS trong môi trường dịch vụ, chụp trước khi nạp bất kỳ .env nào.
 */
export function buildDeps({ env = process.env, sidecarRoot = join(here, '..'), inheritedReplyOnlyTagged, inheritedOwners, inheritedDm = {}, inheritedSettings = {} } = {}) {
  if (!env.ZALO_BRIDGE_TOKEN) throw new Error('Thiếu ZALO_BRIDGE_TOKEN trong .env của sidecar — chạy lại "npm run install:hermes".');
  const paths = resolveDashboardPaths({ env, sidecarRoot });
  const config = loadDashboardConfig(env);
  const sidecarPort = Number(env.ZCA_PORT) || 3872;
  const sidecar = createSidecarClient({ token: env.ZALO_BRIDGE_TOKEN, baseUrl: `http://127.0.0.1:${sidecarPort}` });
  const users = createUserStore(paths.usersFile);
  const linker = createTelegramLinker({
    file: paths.telegramFile, hermesTelegramToken: String(env.TELEGRAM_BOT_TOKEN || '').trim(),
    isActive: (username) => { const u = users.get(username); return Boolean(u && !u.disabled); },
  });
  // Cầu nối mã Hermes (Skill, MCP, sao lưu): chạy lib/hermes-admin.py bằng Python của Hermes.
  const hermesAdmin = createHermesAdmin({ hermesHome: paths.hermesHome, env, configFile: paths.hermesConfigFile, backupDir: join(paths.dataDir, 'config-backups') });
  const restartSidecar = makeRestartSidecar({ cmd: config.restartCmd, sidecarRoot: paths.sidecarRoot, port: sidecarPort });
  let botName = 'Bot Zalo';
  const watchedSidecar = { health: async () => { const h = await sidecar.health(); if (h?.zalo?.displayName) botName = h.zalo.displayName; return h; } };
  const watchdog = createWatchdog({
    sidecar: watchedSidecar, notify: (text) => linker.broadcast(text),
    restartSidecar,
    stateFile: paths.watchdogFile, publicUrl: config.publicUrl, botName: () => botName,
  });
  const threadNames = createThreadNames({ loadGroups: () => sidecar.groups() });
  const owners = createOwnersStore({ envFile: paths.hermesEnvFile, sidecarEnvFile: paths.sidecarEnvFile, pendingFile: paths.pendingRestartFile, inheritedValue: inheritedOwners });
  const people = createPeopleStore({ file: readEnvKey(paths.hermesEnvFile, 'ZALO_PEOPLE_FILE') || paths.peopleFile });
  return {
    paths, config, sidecar, linker,
    store: createStoreReader({ path: paths.sqliteFile }),
    threadNames,
    users,
    sessions: createSessionStore(paths.sessionsFile),
    guard: createLoginGuard(),
    setupToken: createSetupToken(paths.setupFile),
    activity: createActivityLog(paths.activityFile),
    // Cờ tag chung đọc đúng nguồn adapter đọc (.env và config.yaml của Hermes), đọc lại khi tệp đổi.
    permissions: createPermissionsStore({
      file: paths.permissionsFile,
      globalReplyOnlyTagged: makeGlobalReplyOnlyTagged({
        envFile: paths.hermesEnvFile, configFile: paths.hermesConfigFile, inherited: inheritedReplyOnlyTagged,
      }),
      dmEnv: makeDmEnv({ envFile: paths.hermesEnvFile, configFile: paths.hermesConfigFile, inherited: inheritedDm }),
    }),
    watchdog,
    // Sức khoẻ máy chủ: đo ổ đĩa chứa dữ liệu bot (HERMES_HOME); lượt gọi AI từ state.db của Hermes (chỉ đọc).
    health: createHealthMonitor({
      diskPath: paths.hermesHome, historyFile: paths.healthHistoryFile, usageFile: paths.aiUsageFile, stateDb: paths.hermesStateDb,
      services: createServiceChecker({ hermesHome: paths.hermesHome, sidecarPort, dashboardPort: config.port }), watchdog,
    }),
    restartAssistant: makeRestartAssistant({ cmd: config.assistantRestartCmd, hermesHome: paths.hermesHome }),
    restartSidecar,
    restartFlags: createRestartFlags({ file: paths.restartFlagsFile }),
    owners,
    brand: createBrandStore({ file: paths.brandFile, logoFile: paths.brandLogoFile }),
    // Cùng tệp plugin đọc: ZALO_PEOPLE_FILE trong .env của Hermes (nếu đặt) thắng đường mặc định.
    people,
    agentMemory: createHermesMemory({ hermesHome: paths.hermesHome, configFile: paths.hermesConfigFile }),
    schedules: createSchedules({ hermesHome: paths.hermesHome, bin: hermesBin({ hermesHome: paths.hermesHome, env }) }),
    // Đọc lại .env mỗi lần: người cài đặt đổi ZALO_KB_DIR thì không cần khởi động lại dashboard.
    kb: createKbStore({ kbDir: () => readEnvKey(paths.hermesEnvFile, 'ZALO_KB_DIR'), publicDirs: () => readEnvKey(paths.hermesEnvFile, 'ZALO_KB_PUBLIC_DIRS'),
      allowedRoots: () => readEnvKey(paths.hermesEnvFile, 'ZALO_KB_ALLOWED_ROOTS'), envFile: paths.hermesEnvFile }),
    insightAi: createInsightAi({ dir: paths.insightDir }),
    agentConfig: createAgentConfig({ configFile: paths.hermesConfigFile, envValue: (k) => readEnvKey(paths.hermesEnvFile, k) }),
    aiKeys: createAiKeys({ envFile: paths.hermesEnvFile, configFile: paths.hermesConfigFile, poolFile: join(paths.hermesHome, 'zalo', 'key-pool.json') }),
    aiModels: createAiModels({ configFile: paths.hermesConfigFile, envValue: (k) => readEnvKey(paths.hermesEnvFile, k) }),
    soul: createSoul({ hermesHome: paths.hermesHome, historyDir: paths.soulHistoryDir }),
    toolsManifestFile: paths.toolsManifestFile,
    agentTrace: createAgentTrace({ dbPath: paths.hermesStateDb }),
    mcpServers: createMcpServers({ configFile: paths.hermesConfigFile, publicMcp: () => readEnvKey(paths.hermesEnvFile, 'ZALO_PUBLIC_MCP') }),
    hermesAdmin,
    maintenance: createMaintenance({ hermesBin: hermesBin({ hermesHome: paths.hermesHome, env }), dataDir: paths.dataDir, sidecarRoot: paths.sidecarRoot,
      pluginYaml: () => { try { return readFileSync(join(hermesAdmin.root(), 'plugins', 'zalo_tools', 'plugin.yaml'), 'utf8'); } catch { return ''; } } }),
    settings: createSettings({ envFile: paths.hermesEnvFile, configFile: paths.hermesConfigFile, inherited: inheritedSettings }),
    // Lời chào thành viên mới: cùng tệp kết nối Zalo đọc (zalo-welcome.js); ZALO_WELCOME_FILE của kết nối Zalo thắng.
    welcomeFile: env.ZALO_WELCOME_FILE || join(paths.sidecarRoot, 'data', 'welcome.json'),
    publicMcp: () => readEnvKey(paths.hermesEnvFile, 'ZALO_PUBLIC_MCP'),
    // Second brain: chỉ bật khi .env Hermes có ZALO_SECOND_BRAIN_URL (loopback), luôn tắt trên Windows; đọc lại .env mỗi lần.
    secondBrain: createSecondBrain({ settings: () => ({
      url: readEnvKey(paths.hermesEnvFile, 'ZALO_SECOND_BRAIN_URL'), account: readEnvKey(paths.hermesEnvFile, 'OPENVIKING_ACCOUNT'),
      user: readEnvKey(paths.hermesEnvFile, 'OPENVIKING_USER'), apiKey: readEnvKey(paths.hermesEnvFile, 'OPENVIKING_API_KEY'),
    }) }),
    // Kho tri thức tự học (spec §19.6, Quản trị + Chủ bot; kho DM chủ nhân chỉ Quản trị): bật khi Hermes dùng memory.provider zalo_memory, OpenViking loopback, không phải Windows.
    learnedMemory: createLearnedMemory({
      settings: () => ({ provider: readProvider(paths.hermesConfigFile), endpoint: readEnvKey(paths.hermesEnvFile, 'OPENVIKING_ENDPOINT') }),
      names: (kind, id) => (kind === 'group' ? threadNames.cached().get(id) : people.list().find((p) => p.uid === id)?.name) || '',
      owners: () => owners.list(),
      ownerOverrides: () => owners.overrideUids(),
      everOwnersFile: paths.everOwnersFile,
      // Chu kỳ rút trí nhớ: cùng tệp provider zalo_memory đọc nóng.
      settingsFile: join(paths.hermesHome, 'zalo', 'memory.json'),
    }),
    studioUsageFile: paths.studioUsageFile,
    studioPolicyFile: paths.studioPolicyFile,
    publicDir: join(here, 'public'),
  };
}

async function main() {
  const sidecarRoot = join(here, '..');
  const inheritedReplyOnlyTagged = process.env.ZALO_GROUP_REPLY_ONLY_TAGGED;
  const inheritedOwners = process.env.ZALO_ALLOWED_USERS; // trước khi nạp .env nào
  const inheritedDm = Object.fromEntries(['ZALO_DM_POLICY', 'ZALO_ALLOW_ALL_USERS', 'GATEWAY_ALLOW_ALL_USERS'].map((k) => [k, process.env[k]]));
  const inheritedSettings = Object.fromEntries(SETTINGS_ENV_KEYS.map((k) => [k, process.env[k]]));
  if (existsSync(join(sidecarRoot, '.env'))) loadRepoEnv(join(sidecarRoot, '.env'));
  loadHermesEnv();
  const deps = buildDeps({ sidecarRoot, inheritedReplyOnlyTagged, inheritedOwners, inheritedDm, inheritedSettings });
  // Chủ nhân đọc từ tệp .env, không từ môi trường: tiến trình con khởi động lại sẽ thừa hưởng bản cũ và không bao giờ áp dụng danh sách mới.
  delete process.env.ZALO_ALLOWED_USERS;
  const app = createDashboardApp(deps);
  app.listen(deps.config.port, '127.0.0.1', () => console.log(`[dashboard] đang chạy tại ${deps.config.publicUrl} (127.0.0.1:${deps.config.port})`));
  const tick = singleFlight(async () => { try { await deps.watchdog.tick(); } catch (e) { console.warn('[watchdog]', e.message); } });
  setInterval(tick, 30_000); tick();
  // Đo máy chủ mỗi phút; lần đầu sau 5 giây để CPU có một khoảng đo thật.
  const healthTick = async () => { try { await deps.health.tick(); } catch (e) { console.warn('[health]', e.message); } }; // tick tự bỏ qua khi nhịp trước còn chạy
  setTimeout(healthTick, 5_000); setInterval(healthTick, 60_000);
  // Tắt dịch vụ (systemd gửi SIGTERM) thì ghi nốt biểu đồ chưa lưu.
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { try { deps.health.flush(); } catch { /* bỏ qua */ } process.exit(0); });
  (async function poll() {
    for (;;) {
      if (!deps.linker.configured()) { await new Promise((r) => setTimeout(r, 15_000)); continue; }
      try { await deps.linker.pollOnce(25); } catch (e) { console.warn('[telegram]', e.message); await new Promise((r) => setTimeout(r, 10_000)); }
    }
  })();
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch((e) => { console.error('[dashboard]', e.message); process.exitCode = 1; });
