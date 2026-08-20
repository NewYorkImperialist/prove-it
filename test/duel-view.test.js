"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { duelView, duelAutoMode } = require("../lib/duel-view.js");

const ME = "me", OPP = "opp";
const base = {
  players: [{ id: ME, name: "Me" }, { id: OPP, name: "Opp" }],
  scores: { [ME]: 0, [OPP]: 0 },
  category: { name: "Countries", group: "Geography", emoji: "🌍" },
  round: 1,
  phase: "opening",
  turnId: ME,
  claim: 0,
  proven: 0,
};
const view = (over = {}, ctx = {}) => duelView({ ...base, ...over }, { myId: ME, isSpectator: false, isGhost: false, iAmHost: false, ...ctx });
const actions = (v) => v.actions.map((a) => a.action);

describe("opening", () => {
  test("on my turn the input is the game action", () => {
    const v = view();
    assert.equal(v.enable, true);
    assert.match(v.placeholder, /type a number/i);
    assert.match(v.statusText, /You're opening/);
  });
  test("on their turn I'm only told to wait", () => {
    const v = view({ turnId: OPP });
    assert.equal(v.enable, false);
    assert.equal(v.statusText, "Waiting for Opp to open…");
  });
});

describe("bidding", () => {
  test("on my turn I can raise or call the bluff", () => {
    const v = view({ phase: "bidding", claim: 6, turnId: ME });
    assert.deepEqual(actions(v), ["raise", "proveIt"]);
    assert.equal(v.actions[0].label, "Raise to 7");
    assert.match(v.placeholder, /Raise higher than 6/);
  });
  test("on their turn there are no buttons", () => {
    const v = view({ phase: "bidding", claim: 6, turnId: OPP });
    assert.deepEqual(actions(v), []);
    assert.match(v.statusText, /Opp is deciding/);
  });
});

describe("proving", () => {
  test("the prover gets Give up and a progress line", () => {
    const v = view({ phase: "proving", claim: 5, proven: 2, turnId: ME });
    assert.deepEqual(actions(v), ["giveUp"]);
    assert.equal(v.statusText, "Proving 2/5");
    assert.equal(v.placeholder, "Name one: Countries…");
  });
  test("typing speed is folded into the line when the server reports it", () => {
    const v = view({ phase: "proving", claim: 5, proven: 2, wpm: 44, turnId: ME });
    assert.equal(v.statusText, "Proving 2/5 · 44 wpm");
  });
  test("a plural category name still reads as English", () => {
    // Almost every name in data/categories.js is plural, so "Name a …" was wrong nearly always.
    const v = view({ phase: "proving", claim: 5, turnId: ME, category: { name: "Cereals" } });
    assert.equal(v.placeholder, "Name one: Cereals…");
    assert.equal(/Name a /.test(v.placeholder), false);
  });
  test("the challenger watches the same counter", () => {
    const v = view({ phase: "proving", claim: 5, proven: 2, turnId: OPP });
    assert.equal(v.enable, false);
    assert.equal(v.statusText, "Opp is proving… (2/5)");
  });
});

describe("judging", () => {
  test("the judge is told to rule", () => {
    const v = view({ phase: "judging", challengerId: ME });
    assert.match(v.statusText, /Rule on the remaining/);
  });
  test("the prover is told they're being ruled on", () => {
    const v = view({ phase: "judging", challengerId: OPP, holderId: ME });
    assert.equal(v.statusText, "Me's off-list answers are being ruled on…");
  });
});

describe("between rounds", () => {
  test("during an intermission you can advance", () => {
    const v = view({ phase: "roundover", intermission: true, target: 5 });
    assert.deepEqual(actions(v), ["nextRound"]);
  });
  test("otherwise you can pause the auto-advance", () => {
    const v = view({ phase: "roundover", intermission: false, target: 5 });
    assert.deepEqual(actions(v), ["pauseRound"]);
  });
  test("an endless game also offers the end-game vote, with its tally", () => {
    const v = view({ phase: "roundover", intermission: true, target: null, endVotes: 1 });
    assert.deepEqual(actions(v), ["nextRound", "voteEnd"]);
    // "match", not "game": the vote hands off to matchOver, and the result line says "the match".
    assert.equal(v.actions[1].label, "End match (1/2)");
  });
});

describe("match over", () => {
  test("only the host can start a rematch", () => {
    assert.deepEqual(actions(view({ phase: "matchover", matchWinnerId: ME })), ["leave"]);
    assert.deepEqual(actions(view({ phase: "matchover", matchWinnerId: ME }, { iAmHost: true })), ["rematch", "leave"]);
  });
  test("a tie says so — and calls the thing that ended a match, like the winner line does", () => {
    assert.equal(view({ phase: "matchover", matchWinnerId: null }).statusText, "Match over · it's a tie!");
  });
});

describe("skip-category", () => {
  test("is offered while bidding is still open, with the vote tally", () => {
    const v = view({ phase: "bidding", claim: 3, skipVotes: 1 });
    assert.equal(v.canSkip, true);
    assert.equal(v.skipLabel, "Skip category (1/2)");
  });
  test("is not offered once someone is proving", () => {
    assert.equal(view({ phase: "proving", turnId: ME }).canSkip, false);
  });
  test("is never offered to a spectator", () => {
    assert.equal(view({ phase: "bidding", claim: 3 }, { isSpectator: true }).canSkip, false);
  });
});

describe("spectators", () => {
  test("watch read-only, with a chat-only box", () => {
    const v = view({ phase: "bidding", claim: 3, turnId: ME }, { isSpectator: true });
    assert.equal(v.enable, false);
    assert.deepEqual(actions(v), []);
    assert.match(v.placeholder, /you're spectating/);
  });
  test("a ghost is told they're invisible", () => {
    const v = view({}, { isSpectator: true, isGhost: true });
    assert.match(v.placeholder, /Ghost mode/);
  });
  test("at match over they can stop watching", () => {
    const v = view({ phase: "matchover" }, { isSpectator: true });
    assert.deepEqual(actions(v), ["leave"]);
  });
});

describe("frozen while an opponent reconnects", () => {
  test("everything but chat stops", () => {
    const v = view({ phase: "proving", turnId: ME, paused: true });
    assert.equal(v.frozen, true);
    assert.equal(v.enable, false);
    assert.deepEqual(actions(v), []);
    assert.equal(v.canSkip, false);
    assert.match(v.statusText, /waiting up to 30s/);
  });
  test("but a finished match keeps its result and its exits", () => {
    const v = view({ phase: "matchover", matchWinnerId: ME, paused: true }, { iAmHost: true });
    assert.equal(v.frozen, false);
    assert.match(v.statusText, /win/i);
    assert.ok(actions(v).includes("leave"), "there has to be a way out of a decided match");
  });
});

describe("duelAutoMode", () => {
  test("my move puts the box in answer mode", () => {
    for (const phase of ["opening", "bidding", "proving"]) {
      assert.equal(duelAutoMode({ ...base, phase, turnId: ME }, ME), "answer");
    }
  });
  test("my opponent guessing puts me in chat mode", () => {
    assert.equal(duelAutoMode({ ...base, phase: "proving", turnId: OPP }, ME), "chat");
  });
  test("nothing to switch to while waiting on a bid", () => {
    assert.equal(duelAutoMode({ ...base, phase: "bidding", turnId: OPP }, ME), null);
  });
  // duelView tells BOTH players "press P or tap for the next round" at roundover, and the key
  // handler ignores P while chatting. The non-prover is auto-switched into chat while the other
  // player proves, so leaving them there made the shortcut dead for the rest of the match.
  test("the end of a round takes both players out of chat, so P actually works", () => {
    assert.equal(duelAutoMode({ ...base, phase: "roundover", turnId: ME }, ME), "answer");
    assert.equal(duelAutoMode({ ...base, phase: "roundover", turnId: OPP }, ME), "answer");
  });
});
