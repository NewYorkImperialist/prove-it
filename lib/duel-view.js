"use strict";
// What the duel screen offers at any moment, derived from one server game-state snapshot.
// Pure: no DOM, no socket. The action rows come back as descriptors ({ label, tone, action })
// that GameScreen turns into buttons, so this stays testable and the screen stays dumb.

const DEFAULT_PLACEHOLDER = "Type / to chat…";

function duelView(gs, { myId, isSpectator, isGhost, iAmHost }) {
  const nameOf = (id) => (gs.players.find((p) => p.id === id) || {}).name || "?";
  const myTurn = gs.turnId === myId;

  const v = {
    enable: false, // "the input is your game action right now" — drives focus + the ANSWER pill
    placeholder: DEFAULT_PLACEHOLDER,
    statusText: "",
    actions: [],
    canSkip: (gs.phase === "opening" || gs.phase === "bidding") && !isSpectator,
    skipLabel: gs.skipVotes ? `Skip category (${gs.skipVotes}/2)` : "Skip category",
    // Frozen while an opponent reconnects: chat keeps working, everything else stops.
    frozen: false,
  };

  if (gs.phase === "opening") {
    if (myTurn) {
      v.enable = true;
      v.placeholder = "Your turn · type a number to open!";
      v.statusText = "You're opening · how many can you name?";
    } else v.statusText = `Waiting for ${nameOf(gs.turnId)} to open…`;
  } else if (gs.phase === "bidding") {
    if (myTurn) {
      v.enable = true;
      v.placeholder = `Raise higher than ${gs.claim}, or…`;
      v.actions.push({ label: `Raise to ${gs.claim + 1}`, tone: "raise", action: "raise" });
      v.actions.push({ label: "Prove It!", tone: "danger", action: "proveIt" });
    } else v.statusText = `${nameOf(gs.turnId)} is deciding · raise or call Prove It!`;
  } else if (gs.phase === "proving") {
    const pace = `${gs.proven}/${gs.claim}${gs.wpm ? ` · ${gs.wpm} wpm` : ""}`;
    if (myTurn) {
      v.enable = true;
      v.placeholder = `Name a ${gs.category.name}…`;
      v.actions.push({ label: "Give up", tone: "danger", action: "giveUp" });
      v.statusText = `Proving ${pace}`;
    } else v.statusText = `${nameOf(gs.turnId)} is proving… (${pace})`;
  } else if (gs.phase === "judging") {
    v.statusText =
      gs.challengerId === myId
        ? "Time! Rule on the remaining off-list answers."
        : `${nameOf(gs.holderId)}'s off-list answers are being ruled on…`;
  } else if (gs.phase === "roundover") {
    if (gs.intermission) {
      // Waiting for a player to advance (auto-advance off, or paused).
      v.statusText = gs.autoAdvance ? "Paused · press P or tap for the next round" : "Press P or tap for the next round";
      v.actions.push({ label: "Next round (P)", tone: "again", action: "nextRound" });
    } else {
      v.statusText = "Next round coming up…";
      v.actions.push({ label: "Pause", tone: "", action: "pauseRound" });
    }
    // Endless → let either player vote to end the whole game.
    if (gs.target == null) v.actions.push({ label: gs.endVotes ? `End game (${gs.endVotes}/2)` : "End game", tone: "danger", action: "voteEnd" });
  } else if (gs.phase === "matchover") {
    v.statusText = gs.matchWinnerId ? `${nameOf(gs.matchWinnerId)} wins the match!` : "Game over · it's a tie!";
    if (iAmHost) v.actions.push({ label: "Play again", tone: "again", action: "rematch" });
    v.actions.push({ label: "Leave", tone: "danger", action: "leave" });
  }

  // Spectators watch read-only: no game buttons, the input is chat-only.
  if (isSpectator) {
    v.enable = false;
    v.actions = [];
    v.placeholder = isGhost ? "Ghost mode · you're invisible (can't chat)" : "Say something… (you're spectating)";
    if (gs.phase === "matchover") v.actions.push({ label: "Stop watching", tone: "danger", action: "leave" });
  }

  // A finished match is never "waiting for a reconnect": it keeps its own status and its
  // Play again / Leave actions even if a stale snapshot still carries `paused`.
  if (gs.paused && gs.phase !== "matchover") {
    v.frozen = true;
    v.enable = false;
    v.actions = [];
    v.canSkip = false;
    v.placeholder = "Paused · type / to chat…";
    v.statusText = "Opponent disconnected · waiting up to 30s for them to reconnect…";
  }
  return v;
}

// Should the input auto-switch modes on this transition? My move → ANSWER; my opponent
// guessing → CHAT (I can't answer, only chat). Returns "answer" | "chat" | null.
function duelAutoMode(gs, myId) {
  const myTurn = gs.turnId === myId;
  if (myTurn && (gs.phase === "opening" || gs.phase === "bidding" || gs.phase === "proving")) return "answer";
  if (gs.phase === "proving" && !myTurn) return "chat";
  return null;
}

module.exports = { duelView, duelAutoMode };
