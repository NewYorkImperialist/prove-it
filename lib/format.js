"use strict";
// Small display formatters shared across the game screens.

// mm:ss once a clock reaches a minute, bare seconds below that.
const fmtClock = (s) => (s >= 60 ? Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") : String(s));

// A duration that has to carry its unit: "45s", "1:23". Used for seconds-to-clear on a
// leaderboard ("—" when the player never cleared the board) and for the in-game clock pill and
// its cap, where a bare "45" sitting next to a row of scores reads as another score. fmtClock is
// the one for a clock that has room for a label; this one is for a clock that doesn't.
const fmtTime = (t) => (t == null ? "—" : t >= 60 ? Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0") : t + "s");

// The daily challenge id (d-20260624) rendered back as a date.
const dayFromChallengeId = (id) => String(id || "").replace(/^d-/, "").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");

// Today in US Eastern — the timezone the daily challenge rolls over in (see routes/challenge.js).
function todayEastern() {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// The calendar day before an ISO date, used to decide whether a daily streak survives.
function prevDate(d) {
  const t = new Date(d + "T12:00:00Z");
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

module.exports = { fmtClock, fmtTime, dayFromChallengeId, todayEastern, prevDate };
