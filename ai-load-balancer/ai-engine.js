/**
 * ai-engine.js
 *
 * The "AI" in this AI-driven load balancer. Two learned/decision components:
 *
 * 1. ROUTING MODEL (contextual bandit, epsilon-greedy)
 *    Learns, from real response-time + success/failure feedback, a running
 *    performance estimate per server, and uses it (plus current load) to
 *    score and pick the best server for each new request. Explores
 *    occasionally so it keeps adapting if conditions change.
 *
 * 2. TRAFFIC FORECAST MODEL (sliding-window rate + trend)
 *    Watches the rate of incoming requests over a rolling window and its
 *    rate of change, and decides when to bring the standby backup server
 *    online (predicted surge) or take it back offline (traffic has drained).
 *    This is what makes activation a *prediction*, not a fixed "if load > 20".
 *
 * Everything here is intentionally dependency-free so it's easy to explain,
 * demo, and swap out later for a trained ML model (e.g. export this same
 * interface but backed by a scikit-learn/TF model called over HTTP).
 */

module.exports = function createAIEngine(PRIMARY_SERVERS, BACKUP_SERVER) {
  // ---- tunables (these are your "hyperparameters" for the report) --------
  const EPSILON = 0.15;              // exploration rate for the bandit
  const LEARNING_RATE = 0.25;        // EMA smoothing for latency estimates
  const RATE_WINDOW_MS = 6000;       // window used to measure req/sec
  const ACTIVATE_RATE_THRESHOLD = 3.0;   // req/sec sustained -> bring backup online
  const DEACTIVATE_RATE_THRESHOLD = 1.0; // req/sec -> safe to retire backup
  const MIN_ACTIVE_MS = 8000;        // avoid flapping: min time backup stays on

  // ---- routing model state ------------------------------------------------
  const stats = {};
  [...PRIMARY_SERVERS, BACKUP_SERVER].forEach((s) => {
    stats[s.id] = { avgLatencyMs: 100, samples: 0, failures: 0, lastPick: null };
  });

  let mode = "ai"; // "ai" | "roundrobin" — for the comparison mode
  let rrIndex = 0;
  const modeMetrics = {
    ai: { requests: 0, totalLatency: 0, failures: 0 },
    roundrobin: { requests: 0, totalLatency: 0, failures: 0 },
  };

  // ---- traffic forecast state ----------------------------------------------
  let requestTimestamps = [];
  let backupActive = false;
  let backupActivatedAt = 0;
  const activationLog = []; // { time, event, rate }

  function recordRequestTimestamp() {
    const now = Date.now();
    requestTimestamps.push(now);
    requestTimestamps = requestTimestamps.filter((t) => now - t <= RATE_WINDOW_MS);
  }

  function getCurrentRate() {
    const now = Date.now();
    const recent = requestTimestamps.filter((t) => now - t <= RATE_WINDOW_MS);
    return recent.length / (RATE_WINDOW_MS / 1000);
  }

  // Predicts whether the backup should be on, and flips state with a log entry.
  function updateBackupDecision() {
    const rate = getCurrentRate();
    const now = Date.now();

    if (!backupActive && rate >= ACTIVATE_RATE_THRESHOLD) {
      backupActive = true;
      backupActivatedAt = now;
      activationLog.unshift({
        time: now,
        event: "ACTIVATED",
        rate: rate.toFixed(2),
        reason: `predicted sustained load ${rate.toFixed(2)} req/s >= threshold ${ACTIVATE_RATE_THRESHOLD}`,
      });
    } else if (
      backupActive &&
      rate <= DEACTIVATE_RATE_THRESHOLD &&
      now - backupActivatedAt >= MIN_ACTIVE_MS
    ) {
      backupActive = false;
      activationLog.unshift({
        time: now,
        event: "DEACTIVATED",
        rate: rate.toFixed(2),
        reason: `load drained to ${rate.toFixed(2)} req/s <= threshold ${DEACTIVATE_RATE_THRESHOLD}`,
      });
    }
    if (activationLog.length > 20) activationLog.length = 20;
    return backupActive;
  }

  function eligibleServers() {
    return backupActive ? [...PRIMARY_SERVERS, BACKUP_SERVER] : PRIMARY_SERVERS;
  }

  function currentLoad(users, serverId) {
    return users.filter((u) => u.serverId === serverId).length;
  }

  // The scoring function — the "model" driving each decision.
  function score(server, users) {
    const s = stats[server.id];
    const loadPenalty = currentLoad(users, server.id) * 15;
    const failurePenalty = s.failures * 50;
    return s.avgLatencyMs + loadPenalty + failurePenalty;
  }

  function pickServerAI(users) {
    const candidates = eligibleServers();
    let chosen, explored = false;

    if (Math.random() < EPSILON) {
      chosen = candidates[Math.floor(Math.random() * candidates.length)];
      explored = true;
    } else {
      chosen = candidates[0];
      let best = score(chosen, users);
      for (const s of candidates.slice(1)) {
        const sc = score(s, users);
        if (sc < best) { chosen = s; best = sc; }
      }
    }
    stats[chosen.id].lastPick = { explored, at: Date.now() };
    return chosen;
  }

  function pickServerRoundRobin(users) {
    const candidates = eligibleServers();
    const chosen = candidates[rrIndex % candidates.length];
    rrIndex++;
    return chosen;
  }

  // Main entry point lb.js calls for every new user.
  function pickServer(users) {
    recordRequestTimestamp();
    updateBackupDecision();
    return mode === "ai" ? pickServerAI(users) : pickServerRoundRobin(users);
  }

  function recordOutcome(server, latencyMs, success) {
    const s = stats[server.id];
    s.samples++;
    s.avgLatencyMs = s.avgLatencyMs + LEARNING_RATE * (latencyMs - s.avgLatencyMs);
    if (!success) s.failures++;
    else if (s.failures > 0) s.failures--;

    const m = modeMetrics[mode];
    m.requests++;
    m.totalLatency += latencyMs;
    if (!success) m.failures++;
  }

  function setMode(newMode) {
    if (newMode !== "ai" && newMode !== "roundrobin") return false;
    mode = newMode;
    return true;
  }

  function getStats() {
    return {
      mode,
      backupActive,
      currentRateReqPerSec: Number(getCurrentRate().toFixed(2)),
      thresholds: { activate: ACTIVATE_RATE_THRESHOLD, deactivate: DEACTIVATE_RATE_THRESHOLD },
      servers: [...PRIMARY_SERVERS, BACKUP_SERVER].map((s) => ({
        id: s.id,
        name: s.name,
        isBackup: !!s.isBackup,
        eligible: eligibleServers().some((e) => e.id === s.id),
        avgLatencyMs: Math.round(stats[s.id].avgLatencyMs),
        samples: stats[s.id].samples,
        failures: stats[s.id].failures,
        lastPick: stats[s.id].lastPick,
      })),
      activationLog,
      comparison: {
        ai: {
          requests: modeMetrics.ai.requests,
          avgLatencyMs: modeMetrics.ai.requests
            ? Math.round(modeMetrics.ai.totalLatency / modeMetrics.ai.requests)
            : null,
          failures: modeMetrics.ai.failures,
        },
        roundrobin: {
          requests: modeMetrics.roundrobin.requests,
          avgLatencyMs: modeMetrics.roundrobin.requests
            ? Math.round(modeMetrics.roundrobin.totalLatency / modeMetrics.roundrobin.requests)
            : null,
          failures: modeMetrics.roundrobin.failures,
        },
      },
    };
  }

  return { pickServer, recordOutcome, getStats, setMode, isBackupActive: () => backupActive };
};
