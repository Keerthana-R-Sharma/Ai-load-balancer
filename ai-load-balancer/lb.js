/**
 * lb.js — the AI-Driven Load Balancer.
 *
 * - Serves the UI (public/index.html)
 * - Routes every new user through ai-engine.js, which:
 *     1. picks the best server using a self-learning bandit model
 *     2. forecasts traffic and auto-activates/deactivates a backup server
 * - Exposes /api/ai-stats so the UI can show WHY each decision was made
 * - Exposes /api/mode so you can toggle AI vs plain Round-Robin for
 *   a live side-by-side comparison (useful for your results section)
 *
 * Run this AFTER starting the 4 workers (see worker.js):
 *   node lb.js
 * Then open http://localhost:3000
 */

const express = require("express");
const cors = require("cors");
const path = require("path");
const createAIEngine = require("./ai-engine");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Server topology --------------------------------------------------------
const PRIMARY_SERVERS = [
  { id: 1, name: "Server-4001", port: 4001, url: "http://localhost:4001" },
  { id: 2, name: "Server-4002", port: 4002, url: "http://localhost:4002" },
  { id: 3, name: "Server-4003", port: 4003, url: "http://localhost:4003" },
];
const BACKUP_SERVER = {
  id: 4, name: "Server-4004 (Backup)", port: 4004, url: "http://localhost:4004", isBackup: true,
};
const ALL_SERVERS = [...PRIMARY_SERVERS, BACKUP_SERVER];

const ai = createAIEngine(PRIMARY_SERVERS, BACKUP_SERVER);

let users = []; // { id, name, serverId }
let nextUserId = 1;

async function notifyServer(server, path, payload) {
  const start = Date.now();
  try {
    const res = await fetch(`${server.url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  } catch (err) {
    console.error(`[LB] could not reach ${server.name} (${server.url}) — is it running? ${err.message}`);
    return { ok: false, latencyMs: Date.now() - start };
  }
}

// --- API ------------------------------------------------------------------

// Full current state: every server (incl. backup) + which users sit on it
app.get("/api/state", (req, res) => {
  const state = ALL_SERVERS.map((s) => ({
    id: s.id,
    name: s.name,
    port: s.port,
    isBackup: !!s.isBackup,
    active: !s.isBackup || ai.isBackupActive(),
    users: users.filter((u) => u.serverId === s.id),
  }));
  res.json({ servers: state, totalUsers: users.length });
});

// AI reasoning/telemetry — what the model is thinking right now
app.get("/api/ai-stats", (req, res) => {
  res.json(ai.getStats());
});

// Switch between AI routing and plain Round-Robin (for comparison/demo)
app.post("/api/mode", (req, res) => {
  const { mode } = req.body || {};
  const ok = ai.setMode(mode);
  if (!ok) return res.status(400).json({ error: "mode must be 'ai' or 'roundrobin'" });
  console.log(`[LB] mode switched -> ${mode.toUpperCase()}`);
  res.json({ ok: true, mode });
});

// Add a user -> routed by the AI engine
app.post("/api/users", async (req, res) => {
  const name = (req.body && req.body.name && req.body.name.trim()) || `User-${nextUserId}`;
  const server = ai.pickServer(users);

  const user = { id: nextUserId++, name, serverId: server.id };
  users.push(user);

  const { ok: reached, latencyMs } = await notifyServer(server, "/assign", { id: user.id, name: user.name });
  ai.recordOutcome(server, latencyMs, reached);

  if (!reached) {
    // roll back the assignment if the server actually failed
    users = users.filter((u) => u.id !== user.id);
  }

  console.log(`[LB] "${user.name}" (#${user.id}) -> ${server.name}  [${latencyMs}ms, ${reached ? "ok" : "FAILED"}]`);

  res.json({ user, server: { id: server.id, name: server.name, port: server.port }, reached, latencyMs });
});

// Remove a user -> frees up capacity on whichever server had them
app.delete("/api/users/:id", async (req, res) => {
  const id = Number(req.params.id);
  const user = users.find((u) => u.id === id);
  if (!user) return res.status(404).json({ error: "user not found" });

  const server = ALL_SERVERS.find((s) => s.id === user.serverId);
  users = users.filter((u) => u.id !== id);

  const { ok: reached } = await notifyServer(server, "/remove", { id });

  console.log(`[LB] removed "${user.name}" (#${user.id}) from ${server.name}`);

  res.json({ ok: true, reached });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log("==================================================");
  console.log(`  AI Load Balancer UI running at http://localhost:${PORT}`);
  console.log("  Make sure workers are running on ports");
  console.log("  4001, 4002, 4003 (primary) and 4004 (backup).");
  console.log("==================================================");
});
