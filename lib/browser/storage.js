// Every bit of persisted client state, in one place. All of it is best-effort: private
// modes and disabled storage must never break the game, so every read/write is guarded.

const ls = (fn, fallback = null) => {
  try {
    return fn(window.localStorage);
  } catch {
    return fallback;
  }
};
const ss = (fn, fallback = null) => {
  try {
    return fn(window.sessionStorage);
  } catch {
    return fallback;
  }
};

/* ---------- names ---------- */
// The multiplayer lobby and the solo builder have always remembered names separately
// ("pi_name" vs "ch_name"), so a shared device keeps each flow's last-used name.
export const getMpName = () => ls((s) => s.getItem("pi_name") || "", "");
export const setMpName = (n) => { if (n) ls((s) => s.setItem("pi_name", n)); };
export const getSoloName = () => ls((s) => s.getItem("ch_name") || "", "");
export const setSoloName = (n) => ls((s) => s.setItem("ch_name", n));

/* ---------- identity ---------- */
// Persistent anonymous visitor id: ties a player's leaderboard rows together across visits.
export function visitorId() {
  return ls((s) => {
    let v = s.getItem("pi_visitor");
    if (!v) {
      v = "v-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      s.setItem("pi_visitor", v);
    }
    return v;
  });
}

const genPid = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
export const wasReload = () => {
  const nav = typeof performance !== "undefined" ? performance.getEntriesByType("navigation")[0] : null;
  return !!nav && nav.type === "reload";
};
// Identity survives a REFRESH (so we can reconnect into the same seat), but a fresh or
// duplicated tab gets a brand-new one — otherwise two tabs would fight over one slot.
export function sessionPlayerId(isReload) {
  const existing = isReload ? ss((s) => s.getItem("pid")) : null;
  const pid = existing || genPid();
  ss((s) => s.setItem("pid", pid));
  return pid;
}
export const getSessionRoom = () => ss((s) => s.getItem("room"));
export const setSessionRoom = (code) => ss((s) => (code ? s.setItem("room", code) : s.removeItem("room")));
export const getSessionSpectator = () => ss((s) => s.getItem("spectator") === "1", false);
export const setSessionSpectator = (on) => ss((s) => (on ? s.setItem("spectator", "1") : s.removeItem("spectator")));

/* ---------- owner crown 👑 (secret, key-gated server-side) ---------- */
export const getOwnerKey = () => ls((s) => s.getItem("ownerKey"));
export const setOwnerKey = (k) => ls((s) => (k ? s.setItem("ownerKey", k) : s.removeItem("ownerKey")));
export const getCrownOn = () => ls((s) => s.getItem("crownOn") === "1", false);
export const setCrownOn = (on) => ls((s) => (on ? s.setItem("crownOn", "1") : s.removeItem("crownOn")));

/* ---------- preferences ---------- */
export const getMutedPref = () => ls((s) => s.getItem("muted") === "1", false);
export const setMutedPref = (m) => ls((s) => s.setItem("muted", m ? "1" : "0"));

/* ---------- daily challenge ---------- */
export const getDailyLast = () => ls((s) => s.getItem("daily_last") || "", "");
export const getDailyScore = () => ls((s) => s.getItem("daily_score"));
export const getDailyRun = () => ls((s) => JSON.parse(s.getItem("daily_run") || "null"));
export function saveDailyRun(score, run) {
  ls((s) => {
    s.setItem("daily_score", String(score));
    s.setItem("daily_run", JSON.stringify(run));
  });
}
// Local-only streak (there are no accounts): +1 if you played yesterday, reset to 1 after a gap.
export function bumpDailyStreak(date, prevDate) {
  const last = getDailyLast();
  let streak = parseInt(ls((s) => s.getItem("daily_streak") || "0", "0"), 10) || 0;
  if (last !== date) {
    streak = last === prevDate(date) ? streak + 1 : 1;
    ls((s) => {
      s.setItem("daily_last", date);
      s.setItem("daily_streak", String(streak));
    });
  }
  return streak;
}

/* ---------- resume an in-progress run ---------- */
// A reload, a crashed tab, or the server restarting mid-round (a deploy) shouldn't cost a run
// in progress — this is a snapshot of exactly enough to pick back up: which round, what's
// already been named, and a real deadline (a timestamp, not a countdown) so time away is
// deducted correctly instead of handing back a fresh clock. localStorage, not a cookie — this
// never needs to leave the browser, and cookies would just add size to every request for
// nothing gained.
export const getResumeRun = () => ls((s) => JSON.parse(s.getItem("resume_run") || "null"));
export const saveResumeRun = (snap) => ls((s) => s.setItem("resume_run", JSON.stringify(snap)));
export const clearResumeRun = () => ls((s) => s.removeItem("resume_run"));

/* ---------- pending result save ---------- */
// A finished run's /challenge/:id/result POST can fail (a deploy restarting the server, a flaky
// connection) with nothing telling the player — they still see "Your run is in!" client-side.
// Stashing the payload here means it survives a reload/closed tab, so it can be retried later
// instead of just being lost. One slot is enough — a tab only ever has one run finishing at a time.
export const getPendingResult = () => ls((s) => JSON.parse(s.getItem("pending_result") || "null"));
export const savePendingResult = (challengeId, payload) => ls((s) => s.setItem("pending_result", JSON.stringify({ challengeId, payload })));
export const clearPendingResult = () => ls((s) => s.removeItem("pending_result"));

/* ---------------- geography board progress ---------------- */
// Per-board best score, so the Geography screen can say how much of it you've actually cleared.
// Local-only on purpose: the per-category leaderboards already hold the competitive record
// server-side, and this only has to answer "have I done this one yet" for the person sitting here.
// Shape: { [categoryName]: { best, total, at } }
export const getGeoProgress = () => ls((s) => JSON.parse(s.getItem("geo_boards") || "{}"), {});
export function recordGeoBoard(name, best, total) {
  if (!name || !total) return;
  ls((s) => {
    const all = JSON.parse(s.getItem("geo_boards") || "{}");
    const prev = all[name];
    // Only ever improves: replaying a board and doing worse shouldn't take a clear away from you.
    if (prev && prev.best >= best) {
      if (prev.total === total) return;
      all[name] = { best: prev.best, total, at: prev.at }; // the board itself changed size
    } else {
      all[name] = { best, total, at: Date.now() };
    }
    s.setItem("geo_boards", JSON.stringify(all));
  });
}
