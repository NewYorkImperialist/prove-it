"use strict";
// Challenge Race's counterpart to duel-view.js: same shape, but N players instead of
// exactly two, and phases named for a live listing race rather than a bid.
const { geoMode } = require("./geo-cats.js");
const { fmtTime } = require("./format.js");

// Geography rounds get the same board solo uses — outlined shapes to fill in, or a capitals
// grid. Only while the round is being played: once it's over the round-end reveal (which lists
// everyone's answers) is the thing worth the space. Returns "map" | "fill" | null.
function raceBoardMode(g) {
  if (!g || !g.category) return null;
  if (g.phase !== "countdown" && g.phase !== "live") return null;
  return geoMode(g.category.name);
}

function raceView(g, { myId, isSpectator, isGhost, iAmHost, reviewOpen }) {
  const nameOf = (id) => (g.liveScores.find((p) => p.id === id) || {}).name || "?";
  const me = g.liveScores.find((p) => p.id === myId);
  const activeCount = g.liveScores.filter((p) => p.active).length;
  // Clocks run per player, so mine can be spent while the others are still going.
  const myClockDone = !!me && !!me.done;

  const v = {
    enable: false, placeholder: "Type / to chat…", statusText: "", actions: [], frozen: false,
    // Skipping a category needs everyone, so it's offered from the moment you see it until the
    // round is over — including to a player whose own clock has already run out.
    canSkip: (g.phase === "countdown" || g.phase === "live") && !isSpectator && !!me && me.active,
    skipLabel: g.skipVotes ? `Skip category (${g.skipVotes}/${activeCount})` : "Skip category",
  };

  if (g.phase === "starting" || g.phase === "countdown") {
    v.statusText = g.isTiebreaker ? "Sudden death! Get ready…" : "Get ready…";
  } else if (g.phase === "live") {
    if (!isSpectator && me && me.active && !myClockDone) {
      v.enable = true;
      // Not "Name a ${name}…": nearly every category in data/categories.js is plural, so that
      // read "Name a Countries in Oceania…". Asking for one OF the list works for either number.
      v.placeholder = g.category ? `Name one: ${g.category.name}…` : "…";
    }
    if (myClockDone) {
      // Nothing to reveal yet: no answers leave the server until every clock is spent.
      const racing = g.racing ?? 0;
      v.placeholder = "Out of time · type / to chat…";
      v.statusText = `Time's up — you got ${me.score ?? 0}. Waiting for ${racing} still racing…`;
    } else {
      v.statusText = `Racing! You have ${me ? (me.score ?? 0) : 0} so far.`;
    }
  } else if (g.phase === "roundover") {
    v.statusText = reviewOpen
      ? "Reviewing answers — approve a miss above before time runs out…"
      : "See the reveal above · next round starting…";
    if (g.winsNeeded == null) {
      v.actions.push({ label: g.endVotes ? `End match (${g.endVotes}/${activeCount})` : "End match", tone: "danger", action: "raceVoteEnd" });
    }
  } else if (g.phase === "matchover") {
    v.statusText = g.matchWinnerId ? `${nameOf(g.matchWinnerId)} wins the match!` : "Match over.";
    if (iAmHost) v.actions.push({ label: "Play again", tone: "again", action: "rematch" });
    v.actions.push({ label: "Leave", tone: "danger", action: "leave" });
  }

  if (isSpectator) {
    v.enable = false;
    v.actions = [];
    v.canSkip = false;
    v.placeholder = isGhost ? "Ghost mode · you're invisible (can't chat)" : "Say something… (you're spectating)";
    // A watcher has no score of their own, so "Racing! You have 0 so far." is nonsense for them.
    if (g.phase === "live") v.statusText = `Racing! ${g.racing ?? 0} still going…`;
    if (g.phase === "matchover") v.actions.push({ label: "Stop watching", tone: "danger", action: "leave" });
  }

  // A finished match is never "waiting for a reconnect", so it keeps its own status and actions
  // even if a stale snapshot still carries `paused` — otherwise the winner is left frozen with no
  // way out but the ⋯ menu.
  if (g.paused && g.phase !== "matchover") {
    v.frozen = true;
    v.enable = false;
    v.actions = [];
    v.canSkip = false; // nothing moves while we wait for a reconnect
    v.placeholder = "Paused · type / to chat…";
    v.statusText = "A player disconnected · waiting up to 30s for them to reconnect…";
  }
  return v;
}

// Which clock this viewer counts down to: their own while they're still racing, otherwise the
// last one standing — so a player who is out of time can see how long the wait is, and so can a
// spectator. `done` is checked as well as the map, so a stale snapshot can't strand the clock at 0.
function raceClockDeadline(g, myId) {
  const me = g.liveScores && g.liveScores.find((p) => p.id === myId);
  if (me && me.done) return g.deadline || null;
  return (g.deadlines && g.deadlines[myId]) || g.deadline || null;
}

// The banner's second line: round number, match format and the modifiers in play.
function raceFormatLine(g) {
  // NOT "Best of ${g.format}": the race takes up to 8 players and only ceil(format/2) round wins,
  // so "Best of 5" with four players can run nine rounds (a tie with sudden death off scores
  // nobody at all). winsNeeded is the number that actually ends the match, so say that instead.
  const fmt = g.winsNeeded == null ? "Endless" : `First to ${g.winsNeeded} wins`;
  // The increment's ceiling is worth saying out loud — a player who doesn't know their clock stops
  // growing reads it as the timer glitching. clockCap can be absent on an older snapshot, and the
  // server derives it from the round's real ceiling, so it can't promise time the engine won't pay.
  // fmtTime (not fmtClock) because this one is prose and wants its unit: "max 30s a round".
  const incr = g.increment
    ? ` · +${g.increment}s to your own clock per answer` + (g.clockCap ? ` (max ${fmtTime(g.clockCap)} a round)` : "")
    : "";
  return (
    `Round ${g.round} · ${fmt}` +
    incr +
    (g.suddenDeath ? " · sudden death on ties" : "") +
    (g.isTiebreaker ? " · Tiebreaker!" : "")
  );
}

// You first, then everyone else ranked by their current live score.
function raceRoster(g, myId) {
  const me = g.liveScores.find((p) => p.id === myId);
  const others = g.liveScores.filter((p) => p.id !== myId).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return [me, ...others].filter(Boolean);
}

module.exports = { raceView, raceFormatLine, raceRoster, raceClockDeadline, raceBoardMode };
