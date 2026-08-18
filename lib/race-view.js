"use strict";
// Challenge Race's counterpart to duel-view.js: same shape, but N players instead of
// exactly two, and phases named for a live listing race rather than a bid.

function raceView(g, { myId, isSpectator, isGhost, iAmHost, reviewOpen }) {
  const nameOf = (id) => (g.liveScores.find((p) => p.id === id) || {}).name || "?";
  const me = g.liveScores.find((p) => p.id === myId);
  const activeCount = g.liveScores.filter((p) => p.active).length;

  const v = { enable: false, placeholder: "Type / to chat…", statusText: "", actions: [], frozen: false };

  if (g.phase === "starting" || g.phase === "countdown") {
    v.statusText = g.isTiebreaker ? "Sudden death! Get ready…" : "Get ready…";
  } else if (g.phase === "live") {
    if (!isSpectator && me && me.active) {
      v.enable = true;
      v.placeholder = g.category ? `Name a ${g.category.name}…` : "…";
    }
    v.statusText = `Racing! You have ${me ? (me.score ?? 0) : 0} so far.`;
  } else if (g.phase === "roundover") {
    v.statusText = reviewOpen
      ? "Reviewing answers — approve a miss above before time runs out…"
      : "See the reveal above · next round starting…";
    if (g.winsNeeded == null) {
      v.actions.push({ label: g.endVotes ? `End game (${g.endVotes}/${activeCount})` : "End game", tone: "danger", action: "raceVoteEnd" });
    }
  } else if (g.phase === "matchover") {
    v.statusText = g.matchWinnerId ? `${nameOf(g.matchWinnerId)} wins the match!` : "Match over.";
    if (iAmHost) v.actions.push({ label: "Play again", tone: "again", action: "rematch" });
    v.actions.push({ label: "Leave", tone: "danger", action: "leave" });
  }

  if (isSpectator) {
    v.enable = false;
    v.actions = [];
    v.placeholder = isGhost ? "Ghost mode · you're invisible (can't chat)" : "Say something… (you're spectating)";
    if (g.phase === "matchover") v.actions.push({ label: "Stop watching", tone: "danger", action: "leave" });
  }

  if (g.paused) {
    v.frozen = true;
    v.enable = false;
    v.actions = [];
    v.placeholder = "Paused · type / to chat…";
    v.statusText = "A player disconnected · waiting up to 30s for them to reconnect…";
  }
  return v;
}

// The banner's second line: round number, match format and the modifiers in play.
function raceFormatLine(g) {
  const fmt = g.winsNeeded == null ? "Endless" : `Best of ${g.format}`;
  return (
    `Round ${g.round} · ${fmt}` +
    (g.increment ? ` · +${g.increment}s per answer` : "") +
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

module.exports = { raceView, raceFormatLine, raceRoster };
