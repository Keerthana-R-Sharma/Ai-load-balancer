# AI-Driven Load Balancer

A self-learning load balancer: a contextual-bandit routing model picks the
best backend server from live latency/failure feedback, and a traffic
forecast model auto-activates a standby backup server when it predicts a
surge — no manual thresholds hardcoded, no manual traffic generation needed.

## Project structure

```
ai-load-balancer/
├── lb.js              # load balancer: API, serves UI, calls the AI engine
├── ai-engine.js        # the AI: bandit routing model + traffic forecaster
├── worker.js            # one backend server (run 4x: 3 primary + 1 backup)
├── traffic-sim.js       # auto-generates realistic traffic (no manual clicks)
├── public/
│   └── index.html      # dashboard: server grid + live AI reasoning panel
├── package.json
└── README.md
```

## 1. Install

```
npm install
```

## 2. Start the 4 backend servers (4 terminals)

```
node worker.js 4001    # fast
node worker.js 4002    # medium
node worker.js 4003    # intentionally slower/flakier — the AI should learn to avoid it
node worker.js 4004    # backup — the AI brings this online under load
```

## 3. Start the load balancer (5th terminal)

```
node lb.js
```

Open **http://localhost:3000**

## 4. Generate traffic automatically (6th terminal)

```
node traffic-sim.js
```

This ramps traffic up, spikes it hard enough to trigger the backup server,
sustains it, then drains it back down — entirely on its own. Watch the
dashboard's **AI Decision Insights** panel and the surge banner update live.

No manual "Add User" clicking is required to see the whole system work.

---

## Proposed Methodology

### 1. Problem framing
Traditional load balancers route by a fixed static rule (round-robin, least
connections) that has no notion of server health, historical performance, or
future load. This project replaces that fixed rule with two learned
components that adapt from real traffic.

### 2. System architecture
- **Load Balancer (`lb.js`)** — single entry point; receives each new
  request, delegates the routing decision to the AI engine, and forwards the
  request to the chosen backend.
- **Backend servers (`worker.js` × 3 primary + 1 backup)** — simulate
  realistic, *heterogeneous* performance (different base latency and failure
  rates per server, latency that increases under the server's own load) so
  the AI has a genuine signal to learn from — not just a synthetic demo.
- **AI Engine (`ai-engine.js`)** — the decision-making core, described below.
- **Dashboard (`public/index.html`)** — renders backend state and, critically,
  the AI's *reasoning* (predicted latency per server, explore vs. exploit,
  activation log) so the decision process is observable, not a black box.

### 3. Routing model — contextual multi-armed bandit
- Each backend server is treated as an "arm."
- For every request, the model computes a score per server:
  `score = predicted_latency + (current_load × load_penalty) + (failure_count × failure_penalty)`
- **Exploitation:** with probability `1 − ε`, the lowest-scoring server is chosen.
- **Exploration:** with probability `ε` (15%), a random server is chosen, so
  the model keeps re-testing servers instead of permanently trusting early
  estimates (classic epsilon-greedy strategy, standard in reinforcement
  learning literature for the explore/exploit tradeoff).
- **Online learning:** after each request completes, the server's predicted
  latency is updated via an exponential moving average using the real
  observed round-trip time — the model literally gets more accurate with
  every request, with no offline training phase required.
- This is a lightweight, interpretable RL approach — appropriate for a
  small, dynamic server pool, and easy to explain/defend in a viva since
  every score is directly traceable to real observed data.

### 4. Traffic forecasting & auto-scaling model
- A sliding time window (6s) tracks the rate of incoming requests.
- If the sustained rate crosses an **activation threshold**, the model
  predicts an incoming surge and brings the backup server online *before*
  the primary servers are overwhelmed.
- If the rate later falls under a **deactivation threshold** (with a minimum
  active duration to prevent flapping), the backup is retired.
- Every activation/deactivation is logged with the measured rate and reason,
  giving a clear, timestamped audit trail for evaluation.

### 5. Evaluation methodology (for your report/results section)
- **Comparison mode:** the system can run in `AI Routing` or plain
  `Round-Robin` mode against identical simulated traffic (`traffic-sim.js`),
  with per-mode metrics (average latency, failure count) tracked separately
  via `/api/ai-stats`.
- **Metric to report:** average response latency and failure rate under
  each mode, under the same traffic pattern — this quantifies the AI's
  improvement over a non-learning baseline.
- **Scalability demonstration:** the backup-activation log demonstrates
  the system responding to demand changes without manual intervention.

### 6. Limitations & future work (worth stating explicitly in a report)
- The current model is a lightweight online bandit, not a deep learned
  model — appropriate for a small server pool, but for large-scale
  production use this would be extended to a trained regression/RL model
  using richer features (CPU, memory, queue depth, geography).
- Traffic forecasting currently uses a simple rate/threshold rule; a
  time-series model (e.g. exponential smoothing, LSTM) could forecast
  further ahead for earlier pre-scaling.
- Only one backup server is modeled; a production system would scale
  elastically to N backups based on predicted demand magnitude.

## API reference

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/state` | GET | Current servers + assigned users |
| `/api/ai-stats` | GET | AI reasoning: per-server predictions, backup status, activation log, mode comparison |
| `/api/mode` | POST `{mode:"ai"\|"roundrobin"}` | Switch routing strategy for comparison |
| `/api/users` | POST `{name}` | Add a user (routed by current mode) |
| `/api/users/:id` | DELETE | Remove a user |
