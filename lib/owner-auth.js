"use strict";
// Two secrets, because they were one and that one was kept in a browser.
//
// OWNER_KEY gates every /admin* route: the dashboard, every visitor's IP and geography, all chat,
// the session log, and the write tools that rename, merge and delete leaderboard entries. It must
// never leave the server except into the owner's own address bar.
//
// The 👑 crown is a cosmetic badge on the owner's own scores. To render it, the browser has to hold
// the secret that validates it — lib/browser/storage.js keeps it in localStorage and every result
// POST and setCrown socket emit carries it. That is fine for a badge and completely unacceptable for
// the admin key, and until now they were THE SAME VALUE. Enabling the crown once on any shared or
// borrowed device, or a single XSS anywhere in the app, handed over the whole dashboard.
//
// So: CROWN_KEY is the browser-resident one, OWNER_KEY stays server-side. If CROWN_KEY is unset the
// crown falls back to OWNER_KEY, because that is what every already-installed browser is holding —
// setting CROWN_KEY to a fresh value is what completes the split, and until then nothing breaks.
// Once it is set, an old browser's stored key stops crowning, which is the intended outcome: the
// value that leaked is no longer good for anything.
const crypto = require("node:crypto");
const { callerIp } = require("./caller-ip.js");

// Constant-time compare that can't throw or leak length. Both keys are compared this way — a
// timing oracle on the admin key is worth more to an attacker than one on the crown.
//
// The early length check is deliberate and is NOT the leak it looks like. timingSafeEqual throws on
// mismatched buffer lengths, so something has to compare them first; what it reveals is the length
// of the key, which an attacker who can read this file already knows how to look for, and which does
// not narrow a random secret enough to matter. What it must not do is compare CONTENT in variable
// time, and it doesn't.
function secretEq(want, got) {
  if (!want || typeof got !== "string" || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

// ── Failed-attempt throttle for the admin gate ───────────────────────────────────────────────────
// Until now there was nothing here at all: twenty-three routes called ownerOk() and a wrong key cost
// the caller one 404 and nothing else. This repo is public, so an attacker reads exactly how the
// check works and can then guess as fast as the network allows, forever, silently.
//
// The throttle lives INSIDE ownerOk rather than as middleware on purpose. Every gated route — the
// Express ones, the Next ones through app/admin/guard.js, and cost-override which is registered
// outside the admin router in server/index.js — already funnels through this one function. A route
// added tomorrow gets the protection without anyone remembering to wire it up, which is the failure
// mode a separate middleware would have.
//
// Per IP, never global: a global lockout would let anyone lock the owner out of their own dashboard
// by guessing wrong a few times, turning a nuisance into a denial of service. A blocked caller still
// gets the same 404 as a wrong key, so nothing in the response says "you are being throttled" or
// confirms the path exists.
const FAIL_WINDOW_MS = 15 * 60_000;
const FAIL_MAX = 8; // the owner opening a bookmark with a stale key has a few tries; a script does not
const ATTACK_LOG_MAX = 200;
// Hard ceiling on tracked addresses. Well above any real number of people mistyping a key at once,
// and low enough that the map can't become the memory problem it was meant to prevent.
const FAILS_MAX_KEYS = 5000;

// The counters hang off globalThis, and that is not paranoia about module caching — it is required.
//
// This file is required as CommonJS by the Express server AND compiled into Next's own module graph
// by the /admin pages that import it. Those are two separate instances of this module in one
// process, so a plain `const fails = new Map()` gives each surface its own budget: eight wrong
// guesses at an Express route and eight more at a Next route, and adminAuthFailures() — which the
// Express-rendered dashboard calls — could not see the Next-side attempts at all. Same trick, same
// reason, as server/live-state.js.
const STORE = Symbol.for("proveit.ownerAuthThrottle");
const store = (globalThis[STORE] ||= {
  fails: new Map(),   // ip → { count, resetAt }
  // Read by the dashboard so an attempt is visible rather than only being blocked. A quiet block is
  // still an incident nobody hears about.
  attackLog: [],      // [{ at, ip, blocked }] — newest last, bounded
});
const fails = store.fails;
const attackLog = store.attackLog;

function throttleState(ip, now = Date.now()) {
  const e = fails.get(ip);
  if (!e || now > e.resetAt) return null;
  return e;
}

function noteFailure(ip, now = Date.now()) {
  const e = throttleState(ip, now);
  if (e) e.count += 1;
  else fails.set(ip, { count: 1, resetAt: now + FAIL_WINDOW_MS });
  // Opportunistic sweep so a long-running process doesn't hold every address it has ever seen.
  //
  // The sweep alone was not a bound: it only drops EXPIRED entries, so with more live addresses
  // than the threshold the map grows without limit and every failure pays an O(size) walk. The
  // window here is fifteen minutes, which is fifteen times more live entries than the write
  // limiter holds for the same request rate, and an IPv6 client has a whole /64 of free addresses.
  // So after the sweep, if it is still over, evict the entries closest to expiring.
  if (fails.size > FAILS_MAX_KEYS) {
    for (const [k, v] of fails) if (now > v.resetAt) fails.delete(k);
    if (fails.size > FAILS_MAX_KEYS) {
      const byExpiry = [...fails.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
      for (const [k] of byExpiry.slice(0, fails.size - FAILS_MAX_KEYS)) fails.delete(k);
    }
  }
  attackLog.push({ at: now, ip, blocked: (fails.get(ip)?.count || 0) > FAIL_MAX });
  if (attackLog.length > ATTACK_LOG_MAX) attackLog.splice(0, attackLog.length - ATTACK_LOG_MAX);
}

// THE comparison. Every check of either secret goes through here, so there is exactly one place
// that can be throttled, counted and got wrong — and no way to add a caller that quietly isn't.
//
// That mattered: the public rename endpoint used to call a request-less variant of this, which meant
// an unauthenticated caller could ask "is this the admin key?" as often as it liked while the gate
// next door was carefully counting. A side door with no lock on it is the whole lock.
//
// `bucket` is whatever identifies the caller — an address for HTTP, a socket's address for the
// realtime side. It is attacker-controlled either way, so this raises the cost of guessing rather
// than preventing it. The thing that actually prevents it is the key having enough entropy that
// guessing is hopeless, which is a property of the value, not of this file.
function verifyKey(want, given, bucket) {
  const now = Date.now();
  const id = bucket || "unknown";
  // Refuse without comparing once the budget is spent — checking first would keep the timing signal
  // alive and let an attacker keep learning from responses.
  const e = throttleState(id, now);
  if (e && e.count > FAIL_MAX) return false;
  const ok = secretEq(want, typeof given === "string" ? given : "");
  if (ok) fails.delete(id); // the real owner mistyping once shouldn't leave them near a block
  else noteFailure(id, now);
  return ok;
}

// Gate for every /admin* route — OWNER_KEY only, never the crown key.
function ownerOk(req) {
  return verifyKey(process.env.OWNER_KEY, req.query.key || req.get("x-owner-key"), callerIp(req));
}

// ── The extra gate for routes that CHANGE something ──────────────────────────────────────────────
// The dashboard drives its write actions with plain links, so they are GET routes — and Express
// answers HEAD on every GET route, running the handler and throwing the body away. A bare
// `curl -I /admin/killall?key=…` therefore ended every live game before the redirect it discarded.
//
// The wider problem is that the owner key travels in these URLs, so any software that merely
// TOUCHES one fires it: a link unfurler when the owner pastes a dashboard URL into a chat app, a
// browser prefetching a link it thinks you are about to click, a scanner following a redirect.
// None of those is a person deciding to end every game or delete a leaderboard row.
//
// So a mutating route now also has to look like someone actually navigating to it. Browsers have
// sent the Sec-Fetch-* headers for years and unfurlers send none of them — and every check below is
// "reject when this header is PRESENT and says something else", so a client that omits them all is
// still served, and an old browser doesn't break. That deliberately leaves an attacker who sets no
// headers: they would need the owner key first, and this is about accidents, not about the key.
//
// The complete fix is POST forms with a token. This is the version that ships without rewriting
// every link on eleven pages, and it closes the paths that go off on their own.
function navigationLike(req) {
  const h = (n) => String((req.get?.(n)) || "").toLowerCase();
  if (req.method === "HEAD") return "HEAD";
  if (h("sec-purpose").includes("prefetch") || h("purpose") === "prefetch" || h("x-purpose") === "preview") return "prefetch";
  const mode = h("sec-fetch-mode");
  if (mode && mode !== "navigate") return "not a navigation";
  if (h("sec-fetch-site") === "cross-site") return "cross-site";
  return null;
}
// What every write route opens with: the key, then "is this a person clicking a link". Answers the
// route itself on refusal and returns false, so a handler is one line — and a handler that forgets
// it is a handler that still has the old behaviour, which is why the read routes keep calling
// ownerOk directly rather than this being folded into it.
function ownerAction(req, res) {
  if (!ownerOk(req)) { res.status(404).send("Not found"); return false; }
  const why = navigationLike(req);
  if (!why) return true;
  console.log(`🚫 refused ${req.method} ${req.path} (${why})`);
  res.status(405).send("Not found");
  return false;
}

// What the dashboard shows: recent failed attempts, so a guessing run is something the owner can
// SEE. Copies rather than handing out the array, and truncates the address — the panel only has to
// answer "is someone trying", not identify them.
function adminAuthFailures(limit = 50) {
  const now = Date.now();
  const recent = attackLog.slice(-Math.max(1, Math.min(ATTACK_LOG_MAX, limit)));
  const blockedNow = [...fails.entries()].filter(([, v]) => now <= v.resetAt && v.count > FAIL_MAX).length;
  return {
    total: attackLog.length,
    blockedNow,
    windowMinutes: FAIL_WINDOW_MS / 60_000,
    max: FAIL_MAX,
    recent: recent.map((r) => ({ at: r.at, ip: String(r.ip).slice(0, 20), blocked: r.blocked })),
  };
}

// Tests need to start from a known place; nothing in the app calls this.
function resetAdminThrottle() {
  fails.clear();
  attackLog.length = 0;
}

// Does this client-supplied key earn the cosmetic 👑? CROWN_KEY when set, otherwise OWNER_KEY.
// Throttled like everything else: while CROWN_KEY is unset this compares against OWNER_KEY, so an
// unthrottled version would be an oracle for the admin secret rather than for a badge.
function crownOk(key, bucket) {
  return verifyKey(process.env.CROWN_KEY || process.env.OWNER_KEY, key, bucket);
}

// OWNER_KEY where the caller has a bare key rather than a request — the ghostWatch socket emit,
// which joins a room's feed invisibly. `bucket` should be the socket's address; without one every
// such caller shares a single budget, which is safe (stricter) but noisier.
function ownerKeyOk(key, bucket) {
  return verifyKey(process.env.OWNER_KEY, key, bucket);
}

module.exports = { ownerOk, ownerAction, crownOk, ownerKeyOk, adminAuthFailures, resetAdminThrottle, FAIL_MAX, FAIL_WINDOW_MS };
