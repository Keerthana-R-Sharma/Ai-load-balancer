/**
 * traffic-sim.js
 *
 * Automatically generates traffic against the load balancer so you never
 * have to click "Add User" yourself. Simulates a realistic pattern:
 * ramp up -> sustained burst ("huge traffic") -> ramp down, with random
 * removals mixed in. Perfect for training the bandit and for demos.
 *
 * Run (after lb.js and the 3 workers are already running):
 *   node traffic-sim.js
 *
 * Optional flags:
 *   node traffic-sim.js --base http://localhost:3000 --speed 1
 */

const BASE_URL = process.argv.includes("--base")
  ? process.argv[process.argv.indexOf("--base") + 1]
  : "http://localhost:3000";

// speed multiplier: 1 = normal, 2 = twice as fast, 0.5 = half speed
const SPEED = process.argv.includes("--speed")
  ? parseFloat(process.argv[process.argv.indexOf("--speed") + 1])
  : 1;

const NAMES = ["Alice", "Bob", "Chen", "Diya", "Emeka", "Farah", "Gus", "Hana",
  "Ivan", "Jia", "Kofi", "Lena", "Mateo", "Nadia", "Omar", "Priya"];

let activeUsers = []; // { id }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms / SPEED));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

async function addUser() {
  const name = NAMES[rand(0, NAMES.length - 1)] + "-" + rand(100, 999);
  try {
    const res = await fetch(`${BASE_URL}/api/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    activeUsers.push(data.user);
    console.log(`[SIM] + ${data.user.name} -> ${data.server.name}`);
  } catch (err) {
    console.error("[SIM] add failed:", err.message);
  }
}

async function removeRandomUser() {
  if (activeUsers.length === 0) return;
  const idx = rand(0, activeUsers.length - 1);
  const user = activeUsers[idx];
  try {
    await fetch(`${BASE_URL}/api/users/${user.id}`, { method: "DELETE" });
    activeUsers.splice(idx, 1);
    console.log(`[SIM] - removed ${user.name}`);
  } catch (err) {
    console.error("[SIM] remove failed:", err.message);
  }
}

// One phase = a period of time with a target request rate (ms between actions)
// and a probability of "add" vs "remove".
async function runPhase(label, durationMs, intervalMs, addProbability) {
  console.log(`\n[SIM] ===== ${label} (${durationMs / 1000}s, every ~${intervalMs}ms) =====`);
  const end = Date.now() + durationMs / SPEED;
  while (Date.now() < end) {
    if (Math.random() < addProbability) await addUser();
    else await removeRandomUser();
    await sleep(intervalMs);
  }
}

async function main() {
  console.log(`[SIM] Target: ${BASE_URL}  Speed: ${SPEED}x`);

  // 1. Calm baseline traffic
  await runPhase("NORMAL TRAFFIC", 10_000, 800, 0.8);

  // 2. Sudden huge spike — this is what should trigger your backup server
  await runPhase("TRAFFIC SPIKE", 15_000, 150, 0.95);

  // 3. Sustained heavy load
  await runPhase("SUSTAINED HIGH LOAD", 15_000, 250, 0.6);

  // 4. Traffic drains back down — backup server should deactivate
  await runPhase("COOLDOWN", 12_000, 700, 0.25);

  console.log("\n[SIM] Done. Final active users:", activeUsers.length);
}

main();
