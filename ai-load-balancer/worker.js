/**
 * worker.js — represents ONE backend server.
 *
 * Run four copies of this, each on a different port, each in its own
 * terminal/cmd window:
 *
 *   node worker.js 4001     (fast server)
 *   node worker.js 4002     (medium server)
 *   node worker.js 4003     (slow server — intentionally, so the AI has
 *                             something real to learn to avoid)
 *   node worker.js 4004     (backup server — fast, brought online by the AI)
 *
 * Each process simulates realistic behavior: variable response latency
 * that increases with its own current load, and a small chance of failure
 * (higher for the intentionally "weaker" server). This is what gives the
 * AI routing model real signal to learn from — a plain least-connections
 * strategy has no idea 4003 is slower; the bandit does, after a few requests.
 */

const express = require("express");

const PORT = process.argv[2] || 4001;
const SERVER_NAME = `SERVER-${PORT}`;

// [minLatencyMs, maxLatencyMs, failureRate]
const PROFILES = {
  4001: [40, 90, 0.02],   // fast, reliable
  4002: [70, 130, 0.03],  // medium
  4003: [150, 320, 0.09], // slow, flakier — the one the AI should learn to avoid
  4004: [30, 80, 0.02],   // backup — fast, kept fresh since it's rarely used
};
const [MIN_LAT, MAX_LAT, FAIL_RATE] = PROFILES[PORT] || [50, 100, 0.03];

const app = express();
app.use(express.json());

let users = []; // { id, name }

function printBanner() {
  console.log("========================================================");
  console.log(`   ${SERVER_NAME}  |  http://localhost:${PORT}`);
  console.log(`   simulated latency: ${MIN_LAT}-${MAX_LAT}ms  |  failure rate: ${(FAIL_RATE * 100).toFixed(0)}%`);
  console.log("   status: ONLINE — waiting for traffic from load balancer");
  console.log("========================================================\n");
}

function printLoad() {
  const list = users.length ? users.map((u) => `${u.name}(#${u.id})`).join(", ") : "— empty —";
  console.log(`[${SERVER_NAME}] current load: ${users.length} user(s) -> ${list}\n`);
}

function simulatedDelay() {
  // base latency + extra strain from its own current load
  const base = MIN_LAT + Math.random() * (MAX_LAT - MIN_LAT);
  const loadStrain = users.length * 8;
  return Math.round(base + loadStrain);
}

app.post("/assign", (req, res) => {
  const { id, name } = req.body;
  const delay = simulatedDelay();
  const willFail = Math.random() < FAIL_RATE;

  setTimeout(() => {
    if (willFail) {
      console.log(`[${SERVER_NAME}] ⚠️  FAILED to assign ${name} (id #${id}) — simulated overload`);
      return res.status(500).json({ ok: false, server: SERVER_NAME });
    }
    users.push({ id, name });
    console.log(`[${SERVER_NAME}] ✅ ASSIGNED  ->  ${name} (id #${id})  [${delay}ms]`);
    printLoad();
    res.json({ ok: true, server: SERVER_NAME, load: users.length });
  }, delay);
});

app.post("/remove", (req, res) => {
  const { id } = req.body;
  const found = users.find((u) => u.id === id);
  users = users.filter((u) => u.id !== id);
  if (found) {
    console.log(`[${SERVER_NAME}] ❌ REMOVED   ->  ${found.name} (id #${id})`);
  } else {
    console.log(`[${SERVER_NAME}] (remove requested for unknown id #${id})`);
  }
  printLoad();
  res.json({ ok: true, server: SERVER_NAME, load: users.length });
});

app.get("/status", (req, res) => {
  res.json({ server: SERVER_NAME, port: Number(PORT), users });
});

app.listen(PORT, () => {
  printBanner();
});
