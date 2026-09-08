export function createRuntimeHealth({ store, now = Date.now, staleAfterMs = 45_000 } = {}) {
  if (!store) throw new Error('Runtime health requires a store');
  const startedAtMs = Number(now());
  const clients = new Map();
  const backfill = new Map();
  let zalo = { status: 'idle', userId: null, displayName: null };
  let lastInboundAtMs = null;
  let lastOutboundAtMs = null;
  let lastError = null;

  function setZaloState(status, profile = {}) {
    zalo = {
      status: String(status || 'idle'),
      userId: profile.userId == null ? null : String(profile.userId),
      displayName: profile.displayName == null ? null : String(profile.displayName),
    };
  }

  function bridgeConnected(clientId) {
    const timestamp = Number(now());
    clients.set(String(clientId), { connectedAtMs: timestamp, lastHeartbeatAtMs: timestamp });
  }

  function bridgeHeartbeat(clientId) {
    const key = String(clientId);
    const prior = clients.get(key) || { connectedAtMs: Number(now()) };
    clients.set(key, { ...prior, lastHeartbeatAtMs: Number(now()) });
  }

  function bridgeDisconnected(clientId) {
    clients.delete(String(clientId));
  }

  function staleClientIds() {
    const current = Number(now());
    return [...clients.entries()]
      .filter(([, state]) => current - state.lastHeartbeatAtMs > staleAfterMs)
      .map(([clientId]) => clientId)
      .sort();
  }

  function setBackfill(state) {
    if (!state || state.threadType == null) return;
    backfill.set(Number(state.threadType), {
      threadType: Number(state.threadType),
      status: String(state.status || 'idle'),
      pagesFetched: Number(state.pagesFetched) || 0,
      messagesInserted: Number(state.messagesInserted) || 0,
      updatedAtMs: Number(now()),
    });
  }

  function recordError(code, _sensitiveMessage = '') {
    lastError = {
      code: String(code || 'runtime_error'),
      message: 'Đã ghi nhận lỗi nội bộ; xem log cục bộ để biết chi tiết.',
      atMs: Number(now()),
    };
  }

  function snapshot() {
    let database;
    try {
      database = store.getHealth();
    } catch {
      database = { ready: false, databaseSizeBytes: 0, messageCount: 0, auditCount: 0 };
    }
    const stale = staleClientIds();
    const heartbeatTimes = [...clients.values()].map((state) => state.lastHeartbeatAtMs);
    const latestHeartbeat = heartbeatTimes.length ? Math.max(...heartbeatTimes) : null;
    let status = 'healthy';
    if (!database.ready) status = 'unhealthy';
    else if (zalo.status !== 'logged-in' || clients.size === 0 || stale.length) status = 'degraded';

    return {
      status,
      uptimeMs: Math.max(0, Number(now()) - startedAtMs),
      zalo: { ...zalo },
      bridge: {
        attachedClients: clients.size,
        heartbeatAgeMs: latestHeartbeat == null ? null : Math.max(0, Number(now()) - latestHeartbeat),
        staleClients: stale.length,
      },
      database,
      backfill: [...backfill.values()].sort((left, right) => left.threadType - right.threadType),
      traffic: { lastInboundAtMs, lastOutboundAtMs },
      lastError,
    };
  }

  return {
    setZaloState,
    bridgeConnected,
    bridgeHeartbeat,
    bridgeDisconnected,
    staleClientIds,
    markInbound: () => { lastInboundAtMs = Number(now()); },
    markOutbound: () => { lastOutboundAtMs = Number(now()); },
    setBackfill,
    recordError,
    snapshot,
  };
}
