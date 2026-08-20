"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { raceView, raceFormatLine, raceRoster, raceClockDeadline, raceBoardMode } = require("../lib/race-view.js");

const ME = "me";
const base = {
  phase: "live",
  round: 2,
  format: 3,
  winsNeeded: 2,
  increment: 0,
  suddenDeath: false,
  isTiebreaker: false,
  category: { name: "Countries", group: "Geography", emoji: "🌍" },
  liveScores: [
    { id: ME, name: "Me", score: 4, active: true, done: false },
    { id: "b", name: "Bea", score: 7, active: true, done: false },
    { id: "c", name: "Cy", score: 1, active: false, done: false },
  ],
  racing: 2,
  skipVotes: 0,
  deadline: 1_700_000_010_000,
  deadlines: { [ME]: 1_700_000_005_000, b: 1_700_000_010_000 },
  roundWins: [{ id: ME, wins: 1 }, { id: "b", wins: 0 }],
};
const view = (over = {}, ctx = {}) => raceView({ ...base, ...over }, { myId: ME, isSpectator: false, isGhost: false, iAmHost: false, reviewOpen: false, ...ctx });
const actions = (v) => v.actions.map((a) => a.action);

describe("the race screen", () => {
  test("while live, a still-active racer can type answers", () => {
    const v = view();
    assert.equal(v.enable, true);
    assert.equal(v.placeholder, "Name a Countries…");
    assert.equal(v.statusText, "Racing! You have 4 so far.");
  });
  test("a racer who has left can't", () => {
    const v = view({ liveScores: [{ id: ME, name: "Me", score: 4, active: false }] });
    assert.equal(v.enable, false);
  });
  test("once your own clock is spent you're locked out and told who you're waiting on", () => {
    const v = view({
      liveScores: [{ id: ME, name: "Me", score: 4, active: true, done: true }, { id: "b", name: "Bea", score: 7, active: true, done: false }],
      racing: 1,
    });
    assert.equal(v.enable, false); // can't answer any more
    assert.match(v.placeholder, /Out of time/);
    assert.match(v.statusText, /Time's up — you got 4/);
    assert.match(v.statusText, /Waiting for 1 still racing/);
  });

  test("a spent clock still leaves chat open", () => {
    const v = view({ liveScores: [{ id: ME, name: "Me", score: 4, active: true, done: true }], racing: 0 });
    assert.equal(v.frozen, false); // not a pause — the input stays usable for chat
  });

  test("skipping the category is offered from the countdown through the whole round", () => {
    assert.equal(view({ phase: "countdown" }).canSkip, true);
    assert.equal(view({ phase: "live" }).canSkip, true);
    // Still offered once your own clock is spent — a skip needs everyone, including you.
    assert.equal(view({ liveScores: [{ id: ME, name: "Me", score: 0, active: true, done: true }], racing: 1 }).canSkip, true);
  });

  test("skipping is not offered once the round is decided, or to a watcher, or while paused", () => {
    assert.equal(view({ phase: "roundover" }).canSkip, false);
    assert.equal(view({ phase: "matchover" }).canSkip, false);
    assert.equal(view({}, { isSpectator: true }).canSkip, false);
    assert.equal(view({ paused: true }).canSkip, false);
  });

  test("the skip label carries the tally against the number still in the round", () => {
    assert.equal(view().skipLabel, "Skip category");
    assert.equal(view({ skipVotes: 1 }).skipLabel, "Skip category (1/2)");
  });

  test("the countdown just says to get ready", () => {
    assert.equal(view({ phase: "countdown" }).statusText, "Get ready…");
    assert.match(view({ phase: "countdown", isTiebreaker: true }).statusText, /Sudden death/);
  });
});

describe("round end", () => {
  test("an open review window says so", () => {
    assert.match(view({ phase: "roundover" }, { reviewOpen: true }).statusText, /approve a miss/);
  });
  test("a finalised round points at the reveal", () => {
    assert.match(view({ phase: "roundover" }).statusText, /See the reveal above/);
  });
  test("a best-of match has nothing to vote on", () => {
    assert.deepEqual(actions(view({ phase: "roundover" })), []);
  });
  test("an endless match can be voted to an end, counting only active racers", () => {
    const v = view({ phase: "roundover", winsNeeded: null, endVotes: 1 });
    assert.deepEqual(actions(v), ["raceVoteEnd"]);
    assert.equal(v.actions[0].label, "End game (1/2)"); // Cy has left, so 2 not 3
  });
});

describe("match over", () => {
  test("names the winner and lets the host rematch", () => {
    const v = view({ phase: "matchover", matchWinnerId: "b" }, { iAmHost: true });
    assert.equal(v.statusText, "Bea wins the match!");
    assert.deepEqual(actions(v), ["rematch", "leave"]);
  });
  test("a non-host only gets Leave", () => {
    assert.deepEqual(actions(view({ phase: "matchover", matchWinnerId: "b" })), ["leave"]);
  });
});

describe("spectators and pauses", () => {
  test("a spectator can only chat", () => {
    const v = view({}, { isSpectator: true });
    assert.equal(v.enable, false);
    assert.match(v.placeholder, /you're spectating/);
  });
  test("a watcher isn't told what they scored — they have no score", () => {
    const v = view({}, { isSpectator: true });
    assert.equal(/You have/.test(v.statusText), false);
    assert.match(v.statusText, /2 still going/); // the fixture has two racers left
  });
  test("a pause freezes everything but chat", () => {
    const v = view({ paused: true });
    assert.equal(v.frozen, true);
    assert.deepEqual(actions(v), []);
    assert.match(v.statusText, /waiting up to 30s/);
  });
  test("a finished match keeps its result and its exits even if the snapshot still says paused", () => {
    // A forfeit ends the match while the room was paused waiting on the player who left. Letting
    // `paused` win here stranded the winner on "waiting up to 30s…" with no button to leave.
    const v = view({ paused: true, phase: "matchover", matchWinnerId: ME }, { iAmHost: true });
    assert.equal(v.frozen, false);
    assert.deepEqual(actions(v), ["rematch", "leave"]);
    assert.match(v.statusText, /wins the match/);
  });
});

describe("raceClockDeadline", () => {
  test("you count down to your own clock", () => {
    assert.equal(raceClockDeadline(base, ME), 1_700_000_005_000);
  });
  test("once your clock is spent you count down to the last one still running", () => {
    const spent = {
      ...base,
      liveScores: [{ id: ME, name: "Me", score: 4, active: true, done: true }, { id: "b", name: "Bea", score: 7, active: true, done: false }],
      deadlines: { b: 1_700_000_010_000 }, // the server drops spent clocks
    };
    assert.equal(raceClockDeadline(spent, ME), 1_700_000_010_000);
  });
  test("a stale snapshot that still lists your dead clock can't strand the countdown at zero", () => {
    const stale = {
      ...base,
      liveScores: [{ id: ME, name: "Me", score: 4, active: true, done: true }],
      deadlines: { [ME]: 1_699_999_999_000 }, // already in the past
    };
    assert.equal(raceClockDeadline(stale, ME), 1_700_000_010_000); // falls back to g.deadline
  });
  test("a spectator (or anyone with no clock of their own) follows the last one still running", () => {
    assert.equal(raceClockDeadline(base, "nobody"), 1_700_000_010_000);
  });
  test("no clocks at all reads as no countdown", () => {
    assert.equal(raceClockDeadline({ deadlines: {}, deadline: null }, ME), null);
  });
});

describe("raceFormatLine", () => {
  test("shows the round and the match format", () => {
    assert.equal(raceFormatLine(base), "Round 2 · Best of 3");
  });
  test("an endless match says so", () => {
    assert.equal(raceFormatLine({ ...base, winsNeeded: null }), "Round 2 · Endless");
  });
  test("appends every modifier in play", () => {
    assert.equal(
      raceFormatLine({ ...base, increment: 5, suddenDeath: true, isTiebreaker: true }),
      "Round 2 · Best of 3 · +5s to your own clock per answer · sudden death on ties · Tiebreaker!",
    );
  });
  test("spells out the clock ceiling when the server advertises one", () => {
    assert.equal(
      raceFormatLine({ ...base, increment: 5, clockCap: 90 }),
      "Round 2 · Best of 3 · +5s to your own clock per answer (max 1:30 a round)",
    );
  });
  test("a cap is only mentioned alongside an increment that could reach it", () => {
    assert.equal(raceFormatLine({ ...base, increment: 0, clockCap: 90 }), "Round 2 · Best of 3");
  });
});

describe("raceRoster", () => {
  test("puts you first, then everyone else by current score", () => {
    assert.deepEqual(raceRoster(base, ME).map((p) => p.name), ["Me", "Bea", "Cy"]);
  });
  test("survives a roster that doesn't include you (a spectator's view)", () => {
    assert.deepEqual(raceRoster(base, "nobody").map((p) => p.name), ["Bea", "Me", "Cy"]);
  });
});

describe("raceBoardMode", () => {
  const g = (over) => ({ ...base, ...over });
  test("a map category draws the outline board while the round is being played", () => {
    assert.equal(raceBoardMode(g({ category: { name: "Countries in Europe" } })), "map");
    assert.equal(raceBoardMode(g({ phase: "countdown", category: { name: "US States" } })), "map");
  });
  test("a capitals category draws the fill-in grid", () => {
    assert.equal(raceBoardMode(g({ category: { name: "World Capitals" } })), "fill");
  });
  test("geography without a board, and every non-geography category, get nothing", () => {
    assert.equal(raceBoardMode(g({ category: { name: "Rivers of the World" } })), null);
    assert.equal(raceBoardMode(g({ category: { name: "NBA Teams" } })), null);
  });
  test("the board gives the space back once the round is decided — the reveal needs it", () => {
    for (const phase of ["starting", "roundover", "matchover"]) {
      assert.equal(raceBoardMode(g({ phase, category: { name: "US States" } })), null);
    }
  });
  test("a round with no category yet has no board", () => {
    assert.equal(raceBoardMode(g({ category: null })), null);
    assert.equal(raceBoardMode(null), null);
  });
});
