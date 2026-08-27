"use strict";
// Two-tier automatic cost cap: keeps the always-on Fly machine from running away on cost.
// Tier 1 ($4, coldThreshold): revert the Fly machine from always-on to scale-to-zero — cuts the fixed
// compute cost, at the price of a cold start (~1-3s) on the next visit after idle. Requires FLY_API_TOKEN.
// Tier 2 ($4.50, stopThreshold): serve a tiny "paused" page instead of the heavy bundle (the budget gate
// middleware below), capping egress — no Fly API needed, so this tier always works even without a token.
// Both are re-checked every 60s and self-heal when the next billing month begins.

// Fly cost projection — rough estimates; confirm against current Fly pricing.
// Always-on shared-cpu-1x 256MB ≈ $1.94/mo (fixed); NA/EU egress ≈ $0.02/GB (the only real variable).
// coldThreshold = $ line where the guard reverts the machine to scale-to-zero (cuts the fixed compute cost).
// stopThreshold = $ line where the guard also pauses heavy traffic (caps egress, the only variable cost).
// minGB is a floor on ACTUAL egress, not on the projection, and it exists because the projection
// alone is trivially weaponisable. Early in a cycle the extrapolation multiplies whatever has been
// served so far by the whole month: on day 2, `gb / 2 * 31`, so ~8GB of downloads projects past the
// stop threshold and pauses the site until the calendar month rolls over. Every GET is unlimited
// and the tally counts the requester's own traffic, so a stranger with a loop and a decent link
// could take the game down for weeks in minutes.
//
// Requiring real bytes as well means the guard still catches a genuine runaway — by the time 40GB
// has actually gone out, the bill is real whatever the projection says — while a short burst no
// longer decides anything. This is a bound on the damage, not a fix: the fix is a CDN in front,
// so the bundle is edge-cached and rate-limited per IP and never reaches this tally at all.
const FLY_COST = { computePerMo: 1.94, egressPerGB: 0.02, coldThreshold: 4.0, stopThreshold: 4.5, minDays: 2, minColdGB: 25, minStopGB: 40 };

// Extrapolate this cycle's egress to a projected month-end bill. Compute is fixed (always-on VM).
function projectCost(bw, now) {
  const gb = (bw.monthBytes || 0) / 1e9;
  const d = new Date(now);
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const elapsedDays = Math.max(0.5, (now - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)) / 86400000);
  const projGB = gb / elapsedDays * daysInMonth;
  const egressProj = projGB * FLY_COST.egressPerGB;
  const projTotal = FLY_COST.computePerMo + egressProj;            // compute is fixed for an always-on VM
  const soFar = FLY_COST.computePerMo * (elapsedDays / daysInMonth) + gb * FLY_COST.egressPerGB;
  return { gb, projGB, egressProj, projTotal, soFar, elapsedDays, daysInMonth, month: new Date(now).toISOString().slice(0, 7) };
}

// analytics: the stats.js module (persistent Turso/libSQL history — also used for bandwidth + the
// cost-override KV flag). SITE: site-config.js (for the paused-page copy). ownerAction: the write
// gate from lib/owner-auth.js — the key check plus "is this a person clicking a link".
function createCostGuard({ analytics, SITE, ownerAction }) {
  // ---- egress accounting: tally bytes sent per response, for the admin cost projection ----
  // Buffered in memory and flushed to the DB every 60s (single always-on instance → safe, cheap).
  let bwBytes = 0, bwReqs = 0;
  const chunkLen = (c) => { try { return c == null || typeof c === "function" ? 0 : (Buffer.isBuffer(c) ? c.length : Buffer.byteLength(c)); } catch (e) { return 0; } };
  const egressMiddleware = (req, res, next) => {
    const w = res.write, e = res.end; let n = 0;
    res.write = function (c, ...a) { n += chunkLen(c); return w.call(this, c, ...a); };
    res.end = function (c, ...a) { n += chunkLen(c); return e.call(this, c, ...a); };
    res.on("finish", () => { bwBytes += n; bwReqs++; });
    next();
  };
  { const t = setInterval(() => { if ((bwBytes || bwReqs) && analytics.enabled()) { analytics.addBandwidth(bwBytes, bwReqs); bwBytes = 0; bwReqs = 0; } }, 60000); if (t.unref) t.unref(); }

  let coldTripped = false, hardTripped = false, coldError = null, costOverrideMonth = null; // month (YYYY-MM) the owner chose to accept the overage
  if (analytics.enabled()) analytics.kvGet("cost_override_month").then((m) => { costOverrideMonth = m || null; }).catch(() => {});

  // ---- Fly Machines API: flip the app between always-on and scale-to-zero at runtime ----
  // Mirrors the two modes documented in fly.toml's [http_service] block. Note: POSTing a machine's config
  // triggers a stop/start cycle (not a hot reload) — so applying either tier briefly restarts the machine
  // and drops any live game connections (same as a normal deploy; Socket.IO clients reconnect).
  const FLY_API = "https://api.machines.dev/v1";
  const FLY_APP = process.env.FLY_APP_NAME;
  async function flyFetch(path, opts) {
    const token = process.env.FLY_API_TOKEN;
    if (!token) throw new Error("FLY_API_TOKEN not set");
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(`${FLY_API}${path}`, { ...opts, signal: ctrl.signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(opts && opts.headers) } });
      if (!r.ok) throw new Error(`Fly API ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
      return r.status === 204 ? null : r.json();
    } finally { clearTimeout(t); }
  }
  async function setColdStart(cold) {
    if (!FLY_APP) throw new Error("FLY_APP_NAME not set");
    const machines = await flyFetch(`/apps/${FLY_APP}/machines`);
    for (const m of machines) {
      if (m.state === "destroyed") continue;
      const full = await flyFetch(`/apps/${FLY_APP}/machines/${m.id}`);
      const cfg = full.config;
      for (const svc of cfg.services || []) {
        if (!(svc.ports || []).some((p) => (p.handlers || []).includes("http") || (p.handlers || []).includes("tls"))) continue;
        svc.autostop = cold ? "stop" : "off";
        svc.autostart = true;
        svc.min_machines_running = cold ? 0 : 1;
      }
      await flyFetch(`/apps/${FLY_APP}/machines/${m.id}`, { method: "POST", body: JSON.stringify({ config: cfg }) });
    }
  }
  let coldApplying = false;
  async function applyColdStart(cold) {
    if (coldApplying) return; coldApplying = true;
    try { await setColdStart(cold); coldError = null; console.log(`💸 cost guard: machine set to ${cold ? "scale-to-zero (cold starts)" : "always-on"}`); }
    catch (e) { coldError = e.message; console.error(`💸 cost guard: failed to set ${cold ? "cold-start" : "always-on"} mode:`, e.message); }
    finally { coldApplying = false; }
  }

  async function evalCostGuard() {
    if (!analytics.enabled()) return;
    const bw = await analytics.bandwidthStats().catch(() => null);
    if (!bw) return;
    const p = projectCost(bw, Date.now());
    if (p.month === costOverrideMonth) {                                              // owner accepted the cost this cycle
      if (coldTripped) applyColdStart(false);
      coldTripped = false; hardTripped = false;
      return;
    }
    // Both a projected bill AND real bytes on the clock. Either alone is a bad trigger: the
    // projection can be forced by a short burst (see minGB above), and raw bytes without a
    // projection would fire on a legitimately busy month that was going to be fine.
    const hardTrip = p.projTotal >= FLY_COST.stopThreshold && p.gb >= FLY_COST.minStopGB && p.elapsedDays >= FLY_COST.minDays;
    const coldTrip = p.projTotal >= FLY_COST.coldThreshold && p.gb >= FLY_COST.minColdGB && p.elapsedDays >= FLY_COST.minDays;
    if (hardTrip !== hardTripped) { hardTripped = hardTrip; console.log(`💸 cost guard ${hardTrip ? "TRIPPED — heavy traffic paused (proj $" + p.projTotal.toFixed(2) + ")" : "cleared"}`); }
    if (coldTrip !== coldTripped) { coldTripped = coldTrip; applyColdStart(coldTrip); }
  }
  { const t = setInterval(evalCostGuard, 60000); if (t.unref) t.unref(); }
  setTimeout(evalCostGuard, 8000); // first pass shortly after boot

  // When the cost cap is tripped, serve a tiny "paused for the month" page for the heavy HTML/JS bundle
  // instead of the full app — this caps egress (the only cost that can run away). Small API responses and
  // the /admin dashboard keep working. 200 (not 503) so it can't trip any health check into a restart loop.
  const BUDGET_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${SITE.paused.title}</title><body style="margin:0;background:#0e1016;color:#e8ecf4;font:16px/1.6 system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center;padding:24px"><div style="max-width:440px"><div style="font-size:44px">${SITE.paused.emoji}</div><h1 style="font-size:22px;margin:8px 0">${SITE.paused.heading}</h1><p style="color:#8a92a6">${SITE.paused.body}</p></div></body>`;
  const budgetGateMiddleware = (req, res, next) => {
    if (!hardTripped) return next();
    if (req.method === "GET" && /(^\/$|\.html$|\.js$)/.test(req.path) && !req.path.startsWith("/admin")) {
      return res.set("content-type", "text/html").send(BUDGET_PAGE);
    }
    next();
  };

  // Owner override: keep the game live for the rest of THIS billing cycle even past the caps (?on=1), or re-arm it (?on=0).
  function costOverrideRoute(req, res) {
    // ownerAction, not ownerOk: this one flips the budget guard for a whole billing month, and it
    // is reached by the same keyed link as the dashboard's other write actions. See lib/owner-auth.js.
    if (!ownerAction(req, res)) return;
    const month = new Date().toISOString().slice(0, 7);
    if (String(req.query.on) === "1") {
      costOverrideMonth = month; hardTripped = false;
      if (coldTripped) applyColdStart(false);
      coldTripped = false;
      analytics.kvSet("cost_override_month", month);
    } else { costOverrideMonth = null; analytics.kvSet("cost_override_month", ""); evalCostGuard(); }
    res.redirect(`/admin?key=${encodeURIComponent(req.query.key || "")}`);
  }

  return {
    egressMiddleware,
    budgetGateMiddleware,
    costOverrideRoute,
    // live state, read by routes/admin.js's cost panel — a getter so it always reflects current values.
    getState: () => ({ coldTripped, hardTripped, coldError, costOverrideMonth }),
  };
}

module.exports = { createCostGuard, FLY_COST, projectCost };
