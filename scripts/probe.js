#!/usr/bin/env node
"use strict";
// Asks, from outside the app, whether the app is up — and writes the answer to Turso.
//
// Why this can't live in the server: the admin dashboard reads the game's own memory, so it can
// report anything except that the game was gone. A process cannot record its own downtime. Run
// this somewhere else (see .github/workflows/uptime.yml) and the gap in the record becomes a row
// in the record instead.
//
// The one outage it cannot capture is Turso being unreachable, since that is what it writes to.
// A run that reaches the site but can't record the result says so and fails loudly rather than
// looking like a clean probe.
const analytics = require("../server/stats.js");

// Read per call rather than once at load. A CLI wouldn't care, but it means the verdict logic can
// be pointed at a throwaway local server by a test — and reading it at load meant the tests
// silently probed production instead, which one of them passed by coincidence.
//
// The timeout is generous next to a Fly cold start (~1-3s) but bounded, which is the whole point:
// the pre-deploy announce step this repo used to have was an unbounded curl, and one stalled
// connection hung the deploy forever because `|| echo` cannot rescue a process that never exits.
const cfg = () => ({
  base: (process.env.PROBE_URL || "https://proveit.fly.dev").replace(/\/+$/, ""),
  key: process.env.OWNER_KEY || "",
  timeoutMs: Number(process.env.PROBE_TIMEOUT_MS) || 15000,
});
// A single dropped packet shouldn't enter the record as an outage, so a failure is confirmed once
// before it's believed. This makes a recorded outage mean "unreachable twice, ~5s apart".
const RETRY_DELAY_MS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// /admin/ping over the public page on purpose: it's a few bytes rather than the whole document
// (this app bills its own egress — see lib/cost-guard.js), and it returns {ok:true}, so the body
// can be checked. A 200 carrying an edge-server error page would pass a status-only check.
async function attempt() {
  const { base, key, timeoutMs } = cfg();
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/admin/ping?key=${encodeURIComponent(key)}`, {
      signal: ctl.signal,
      redirect: "manual",
      headers: { "user-agent": "proveit-uptime-probe" },
    });
    const ms = Date.now() - started;
    const text = await res.text().catch(() => "");
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON — treat as unhealthy below */ }
    if (res.status !== 200) return { ok: false, status: res.status, ms, err: `HTTP ${res.status}` };
    if (!body || body.ok !== true) return { ok: false, status: res.status, ms, err: "200 but not the ping payload" };
    return { ok: true, status: 200, ms };
  } catch (e) {
    const ms = Date.now() - started;
    // An abort is the timeout firing, which is a real outage signal, not a script bug.
    const err = e.name === "AbortError" ? `timeout after ${timeoutMs}ms` : e.message || String(e);
    return { ok: false, status: 0, ms, err };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (!analytics.enabled()) {
    console.error("probe: TURSO_URL/TURSO_TOKEN not set — there is nowhere to record this.");
    process.exit(1); // a misconfigured prober is a real failure, unlike a site that's down
  }
  if (!cfg().key) {
    console.error("probe: OWNER_KEY not set — /admin/ping is owner-gated and would answer 404.");
    process.exit(1);
  }

  let r = await attempt();
  if (!r.ok) {
    console.log(`probe: first attempt failed (${r.err}) — confirming in ${RETRY_DELAY_MS}ms`);
    await sleep(RETRY_DELAY_MS);
    const again = await attempt();
    // Believe the recovery: if the retry succeeds it was a blip, and recording it as an outage
    // would make the history noisier than the thing it's measuring.
    if (again.ok) console.log("probe: recovered on retry — recording the success");
    r = again;
  }

  const wrote = await analytics.recordProbe(r);
  if (!wrote) {
    console.error("probe: could not write the result to Turso");
    process.exit(1);
  }
  await analytics.pruneProbes(Number(process.env.PROBE_RETAIN_DAYS) || 30);

  console.log(r.ok ? `probe: up (${r.ms}ms)` : `probe: DOWN — ${r.err} (${r.ms}ms)`);
  if (!r.ok) {
    // A GitHub annotation either way; set PROBE_FAIL_ON_OUTAGE=1 to make the run go red as well,
    // which turns a confirmed outage into an email without any extra service.
    console.log(`::warning::Prove It! looked down: ${r.err}`);
    if (process.env.PROBE_FAIL_ON_OUTAGE === "1") process.exit(2);
  }
  process.exit(0);
}

// Exported so the health decision can be tested against a real server without the process exiting
// out from under the test. Only runs the probe when invoked as a command.
module.exports = { attempt };
if (require.main === module) main();
