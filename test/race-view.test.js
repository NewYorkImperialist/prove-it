"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { raceView, raceFormatLine, raceRoster, raceClockDeadline } = require("../lib/race-view.js");

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
  test("a pause freezes everything but chat", () => {
    const v = view({ paused: true });
    assert.equal(v.frozen, true);
    assert.deepEqual(actions(v), []);
    assert.match(v.statusText, /waiting up to 30s/);
  });
});

describe("raceClockDeadline", () => {
  test("you count down to your own clock", () => {
    assert.equal(raceClockDeadline(base, ME), 1_700_000_005_000);
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
});

describe("raceRoster", () => {
  test("puts you first, then everyone else by current score", () => {
    assert.deepEqual(raceRoster(base, ME).map((p) => p.name), ["Me", "Bea", "Cy"]);
  });
  test("survives a roster that doesn't include you (a spectator's view)", () => {
    assert.deepEqual(raceRoster(base, "nobody").map((p) => p.name), ["Bea", "Me", "Cy"]);
  });
});
