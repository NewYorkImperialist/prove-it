"use strict";
const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const engine = require("../game-engine.js");

// Every scenario below drives game-engine handlers directly rather than waiting on real clocks
// (open/turn/prove timers run 5-20s). Mock timers so setTimeout calls the engine makes never
// actually schedule a real wait — nothing here calls .tick(), so they simply sit inertly.
beforeEach((t) => { t.mock.timers.enable({ apis: ["setTimeout"] }); }); // clearTimeout is mocked automatically alongside setTimeout

// ---------- test doubles ----------
// A minimal fake Socket.IO `io`: records every emitted event so assertions can
// inspect the latest broadcast state / log lines without a real server.
function makeIO() {
  const events = [];
  return {
    events,
    to() { return { emit: (event, payload) => events.push({ event, payload }) }; },
    lastState() { for (let i = events.length - 1; i >= 0; i--) if (events[i].event === "gameState") return events[i].payload; return null; },
    logs() { return events.filter((e) => e.event === "log").map((e) => e.payload); },
    lastLog() { const l = this.logs(); return l[l.length - 1] || null; },
  };
}
function sock(playerId) { return { data: { playerId } }; }

// A hand-built category so tests don't depend on the real (huge, evolving) content file.
function testCategory(overrides = {}) {
  return {
    name: "Test Cat", group: "Testing", emoji: "🧪", exact: false,
    entries: [
      { id: 0, display: "Alpha", aliases: ["alpha"] },
      { id: 1, display: "Beta", aliases: ["beta"] },
      { id: 2, display: "Gamma", aliases: ["gamma"] },
    ],
    ...overrides,
  };
}

// Builds a `room` whose `.game` already sits in whatever phase a test needs, bypassing the
// randomized category pick in beginRound() so scenarios are deterministic and fast.
function makeRoom(gameOverrides = {}, roomOverrides = {}) {
  const players = roomOverrides.players || [{ id: "p1", name: "Alice" }, { id: "p2", name: "Bob" }];
  const playersMap = new Map(players.map((p) => [p.id, { id: p.id, name: p.name, crown: false, connected: true }]));
  const room = {
    code: "ABCD", players: playersMap, spectators: new Map(), status: "playing",
    settings: {}, hostId: players[0].id,
    ...roomOverrides,
  };
  room.game = {
    order: ["p1", "p2"], names: { p1: "Alice", p2: "Bob" },
    pool: [testCategory()], groups: [], // beginRound() needs at least one category to pick from
    scores: { p1: 0, p2: 0 },
    timer: 30, target: 5, autoAdvance: true, skipVotes: new Set(), endVotes: new Set(),
    round: 1, usedNames: [], lastCatName: null, intermission: false,
    claim: 0, holderId: null, turnId: "p1", proven: [], granted: [],
    phase: "opening", deadline: null, timeout: null,
    lastResult: null, matchWinnerId: null, challengerId: null,
    current: testCategory(),
    startedAt: Date.now(), gid: "g-test",
    ...gameOverrides,
  };
  return room;
}

describe("handleOpen", () => {
  test("rejects when it isn't the caller's turn", () => {
    const io = makeIO(); const room = makeRoom();
    let ack; engine.handleOpen(io, room, sock("p2"), 2, (r) => (ack = r));
    assert.equal(ack.ok, false);
    assert.equal(room.game.phase, "opening");
  });

  test("rejects a non-integer or a number below 1", () => {
    const io = makeIO(); const room = makeRoom();
    let ack;
    engine.handleOpen(io, room, sock("p1"), 0, (r) => (ack = r));
    assert.equal(ack.ok, false);
    engine.handleOpen(io, room, sock("p1"), 1.5, (r) => (ack = r));
    assert.equal(ack.ok, false);
  });

  test("rejects a claim bigger than the category size", () => {
    const io = makeIO(); const room = makeRoom();
    let ack; engine.handleOpen(io, room, sock("p1"), 10, (r) => (ack = r));
    assert.equal(ack.ok, false);
    assert.match(ack.error, /too many|only 3/);
  });

  test("an exact category names the exact remaining count in its error", () => {
    const io = makeIO(); const room = makeRoom({ current: testCategory({ exact: true }) });
    let ack; engine.handleOpen(io, room, sock("p1"), 10, (r) => (ack = r));
    assert.match(ack.error, /only 3 Test Cat/);
  });

  test("a valid open records the claim and passes the turn to the opponent", () => {
    const io = makeIO(); const room = makeRoom();
    let ack; engine.handleOpen(io, room, sock("p1"), 2, (r) => (ack = r));
    assert.equal(ack.ok, true);
    assert.equal(room.game.claim, 2);
    assert.equal(room.game.holderId, "p1");
    assert.equal(room.game.turnId, "p2");
    assert.equal(room.game.phase, "bidding");
    assert.equal(io.lastState().phase, "bidding");
  });
});

describe("handleRaise", () => {
  function biddingRoom() { return makeRoom({ phase: "bidding", claim: 2, holderId: "p1", turnId: "p2" }); }

  test("rejects a raise that doesn't exceed the current claim", () => {
    const io = makeIO(); const room = biddingRoom();
    let ack; engine.handleRaise(io, room, sock("p2"), 2, (r) => (ack = r));
    assert.equal(ack.ok, false);
    assert.match(ack.error, /higher than 2/);
  });

  test("rejects a raise past the category size", () => {
    const io = makeIO(); const room = biddingRoom();
    let ack; engine.handleRaise(io, room, sock("p2"), 5, (r) => (ack = r));
    assert.equal(ack.ok, false);
  });

  test("with no explicit number, raises by exactly one", () => {
    const io = makeIO(); const room = biddingRoom();
    let ack; engine.handleRaise(io, room, sock("p2"), undefined, (r) => (ack = r));
    assert.equal(ack.ok, true);
    assert.equal(room.game.claim, 3);
    assert.equal(room.game.holderId, "p2");
    assert.equal(room.game.turnId, "p1"); // turn passes back to the other player
  });

  test("rejects a raise from whoever doesn't currently hold the turn", () => {
    const io = makeIO(); const room = biddingRoom();
    let ack; engine.handleRaise(io, room, sock("p1"), 3, (r) => (ack = r));
    assert.equal(ack.ok, false);
    assert.equal(room.game.claim, 2); // unchanged
  });
});

describe("handleProveIt / startProving", () => {
  test("only the player on turn during bidding can call Prove It!", () => {
    const io = makeIO(); const room = makeRoom({ phase: "bidding", claim: 2, holderId: "p1", turnId: "p2" });
    let ack; engine.handleProveIt(io, room, sock("p1"), (r) => (ack = r));
    assert.equal(ack.ok, false);
    assert.equal(room.game.phase, "bidding");
  });

  test("moves to proving, with the bidder as prover and caller as challenger", () => {
    const io = makeIO(); const room = makeRoom({ phase: "bidding", claim: 2, holderId: "p1", turnId: "p2" });
    let ack; engine.handleProveIt(io, room, sock("p2"), (r) => (ack = r));
    assert.equal(ack.ok, true);
    assert.equal(room.game.phase, "proving");
    assert.equal(room.game.turnId, "p1"); // the prover now acts
    assert.equal(room.game.challengerId, "p2");
    assert.deepEqual(room.game.proven, []);
    assert.deepEqual(room.game.pending, new Map());
  });
});

describe("handleAnswer", () => {
  function provingRoom(overrides = {}) {
    return makeRoom({
      phase: "proving", claim: 2, holderId: "p1", turnId: "p1", challengerId: "p2",
      proven: [], granted: [], pending: new Map(), answerSeq: 0, lastAnswerAt: 0,
      offListCount: 0, judgeQueue: [], judgeActive: null, bonus: 0,
      ...overrides,
    });
  }

  test("a listed answer (matched case/space/accent-insensitively) counts toward the claim", () => {
    const io = makeIO(); const room = provingRoom();
    let ack; engine.handleAnswer(io, room, sock("p1"), " ALPHA ", (r) => (ack = r));
    assert.equal(ack.ok, true);
    assert.deepEqual(room.game.proven, [0]);
    assert.equal(room.game.phase, "proving"); // 1/2, round isn't over yet
  });

  test("repeating the same listed answer is rejected as a dup and doesn't double-count", () => {
    const io = makeIO(); const room = provingRoom({ proven: [0] });
    let ack; engine.handleAnswer(io, room, sock("p1"), "alpha", (r) => (ack = r));
    assert.equal(ack.ok, true);
    assert.deepEqual(room.game.proven, [0]); // unchanged
    assert.match(io.lastLog().text, /already got/);
  });

  test("reaching the claim ends the round in the prover's favor", () => {
    const io = makeIO(); const room = provingRoom({ claim: 1 });
    let ack; engine.handleAnswer(io, room, sock("p1"), "alpha", (r) => (ack = r));
    assert.equal(ack.ok, true);
    assert.equal(room.game.phase, "roundover");
    assert.equal(room.game.scores.p1, 1);
    assert.equal(room.game.lastResult.reason, "Nailed it!");
  });

  test("rapid-fire answers inside the cooldown window are bounced, not counted", () => {
    const io = makeIO(); const room = provingRoom({ lastAnswerAt: Date.now() });
    let ack; engine.handleAnswer(io, room, sock("p1"), "alpha", (r) => (ack = r));
    assert.equal(ack.ok, false);
    assert.equal(ack.reason, "cooldown");
    assert.deepEqual(room.game.proven, []);
  });

  test("an off-list answer goes to the pending queue for the challenger to rule on", () => {
    const io = makeIO(); const room = provingRoom();
    let ack; engine.handleAnswer(io, room, sock("p1"), "Not On The List", (r) => (ack = r));
    assert.equal(ack.ok, true);
    assert.equal(room.game.pending.size, 1);
    const [[, p]] = room.game.pending;
    assert.equal(p.text, "Not On The List");
    assert.match(io.lastLog().text, /not on my list/);
  });

  test("re-submitting the same off-list text while it's still pending doesn't queue twice", () => {
    const io = makeIO(); const room = provingRoom();
    engine.handleAnswer(io, room, sock("p1"), "mystery answer", () => {});
    room.game.lastAnswerAt = 0; // bypass the anti-spam cooldown; that's covered by its own test
    let ack; engine.handleAnswer(io, room, sock("p1"), "mystery answer", (r) => (ack = r));
    assert.equal(ack.ok, true);
    assert.equal(room.game.pending.size, 1);
    assert.match(io.lastLog().text, /already counted\/awaiting/);
  });

  test("caps the number of simultaneously pending off-list answers", () => {
    const io = makeIO(); const room = provingRoom();
    for (let i = 0; i < 6; i++) { room.game.lastAnswerAt = 0; engine.handleAnswer(io, room, sock("p1"), `guess ${i}`, () => {}); }
    room.game.lastAnswerAt = 0;
    let ack; engine.handleAnswer(io, room, sock("p1"), "one too many", (r) => (ack = r));
    assert.equal(ack.ok, false);
    assert.equal(ack.reason, "pending");
    assert.equal(room.game.pending.size, 6);
  });

  test("caps total off-list guesses per round even once earlier ones are ruled on", () => {
    const io = makeIO(); const room = provingRoom({ offListCount: 15 });
    let ack; engine.handleAnswer(io, room, sock("p1"), "one more", (r) => (ack = r));
    assert.equal(ack.ok, false);
    assert.equal(ack.reason, "roundcap");
  });

  test("easter egg: Netanyahu on US Presidents adds +50 toward the claim", () => {
    const io = makeIO();
    const room = provingRoom({ claim: 100, current: testCategory({ name: "US Presidents" }) });
    let ack; engine.handleAnswer(io, room, sock("p1"), "bibi", (r) => (ack = r));
    assert.equal(ack.ok, true);
    assert.equal(room.game.bonus, 50);
    assert.equal(room.game.phase, "proving"); // 50 < 100, round continues
  });

  test("easter egg: Netanyahu can finish the round outright if it closes the claim", () => {
    const io = makeIO();
    const room = provingRoom({ claim: 50, current: testCategory({ name: "US Presidents" }) });
    engine.handleAnswer(io, room, sock("p1"), "Benjamin Netanyahu", () => {});
    assert.equal(room.game.phase, "roundover");
    assert.equal(room.game.lastResult.reason, "Nailed it!");
  });

  test("easter egg: the magic Video Games answer gives a flat +5 match-score bonus", () => {
    const io = makeIO();
    const room = provingRoom({
      claim: 3, target: 100,
      current: testCategory({ name: "Video Games", entries: [{ id: 0, display: "Prove It!", aliases: ["prove it!"] }] }),
    });
    engine.handleAnswer(io, room, sock("p1"), "Prove It!", () => {});
    assert.equal(room.game.scores.p1, 5);
    assert.equal(room.game.phase, "proving"); // bonus is score, not claim progress
  });
});

describe("handleJudge / handleRejectAll", () => {
  function pendingRoom(overrides = {}) {
    const pending = new Map([[1, { id: 1, text: "Delta", q: "delta" }]]);
    return makeRoom({
      phase: "proving", claim: 2, holderId: "p1", turnId: "p1", challengerId: "p2",
      proven: [], granted: [], pending, answerSeq: 1, judgeQueue: [], judgeActive: null,
      ...overrides,
    });
  }

  test("only the challenger may rule on a pending answer", () => {
    const io = makeIO(); const room = pendingRoom();
    engine.handleJudge(io, room, sock("p1"), { answerId: 1, accept: true });
    assert.equal(room.game.pending.size, 1); // untouched
  });

  test("accepting a pending answer grants it and can close out the round", () => {
    const io = makeIO(); const room = pendingRoom({ claim: 1 });
    engine.handleJudge(io, room, sock("p2"), { answerId: 1, accept: true });
    assert.equal(room.game.phase, "roundover");
    assert.equal(room.game.lastResult.reason, "Proved it!");
  });

  test("rejecting a pending answer removes it without granting credit", () => {
    const io = makeIO(); const room = pendingRoom();
    engine.handleJudge(io, room, sock("p2"), { answerId: 1, accept: false });
    assert.equal(room.game.pending.size, 0);
    assert.deepEqual(room.game.granted, []);
    assert.equal(room.game.phase, "proving");
  });

  test("reject-all clears every pending answer in one shot", () => {
    const io = makeIO();
    const pending = new Map([[1, { id: 1, text: "A", q: "a" }], [2, { id: 2, text: "B", q: "b" }]]);
    const room = pendingRoom({ pending });
    engine.handleRejectAll(io, room, sock("p2"));
    assert.equal(room.game.pending.size, 0);
  });

  test("during forced judging, only the front-of-queue answer can be ruled on", () => {
    const io = makeIO();
    const active = { id: 1, text: "Delta", q: "delta" };
    const room = pendingRoom({ phase: "judging", judgeActive: active, judgeQueue: [active], challengerId: "p2" });
    engine.handleJudge(io, room, sock("p2"), { answerId: 99, accept: true }); // wrong id, ignored
    assert.equal(room.game.judgeQueue.length, 1);
    engine.handleJudge(io, room, sock("p2"), { answerId: 1, accept: true });
    assert.equal(room.game.judgeQueue.length, 0);
    assert.equal(room.game.judgeActive, null);
  });
});

describe("handleGiveUp", () => {
  test("gives the point to the challenger and ends the round", () => {
    const io = makeIO();
    const room = makeRoom({ phase: "proving", turnId: "p1", challengerId: "p2" });
    engine.handleGiveUp(io, room, sock("p1"));
    assert.equal(room.game.phase, "roundover");
    assert.equal(room.game.scores.p2, 1);
  });

  test("only the prover currently on turn can give up", () => {
    const io = makeIO();
    const room = makeRoom({ phase: "proving", turnId: "p1", challengerId: "p2" });
    engine.handleGiveUp(io, room, sock("p2"));
    assert.equal(room.game.phase, "proving");
  });
});

describe("round/match resolution", () => {
  test("winning enough rounds ends the match instead of advancing", () => {
    const io = makeIO();
    const room = makeRoom({ phase: "proving", turnId: "p1", challengerId: "p2", target: 1, scores: { p1: 0, p2: 0 } });
    engine.handleGiveUp(io, room, sock("p1"));
    assert.equal(room.game.phase, "matchover");
    assert.equal(room.game.matchWinnerId, "p2");
  });

  test("with autoAdvance off, a finished round waits in intermission for a manual next round", () => {
    const io = makeIO();
    const room = makeRoom({ phase: "proving", turnId: "p1", challengerId: "p2", target: 100, autoAdvance: false });
    engine.handleGiveUp(io, room, sock("p1"));
    assert.equal(room.game.phase, "roundover");
    assert.equal(room.game.intermission, true);
  });

  test("handleNextRound only works once the round is actually over", () => {
    const io = makeIO();
    const room = makeRoom({ phase: "bidding" });
    engine.handleNextRound(io, room, sock("p1"));
    assert.equal(room.game.round, 1); // ignored — not roundover yet
  });

  test("handleNextRound starts a fresh round (bumps round count, resets claim)", () => {
    const io = makeIO();
    const room = makeRoom({ phase: "roundover", claim: 2, round: 1 });
    engine.handleNextRound(io, room, sock("p1"));
    assert.equal(room.game.round, 2);
    assert.equal(room.game.claim, 0);
    assert.equal(room.game.phase, "opening");
  });
});

describe("handleVoteSkip", () => {
  test("needs both players before the category actually changes", () => {
    const io = makeIO();
    const room = makeRoom({ phase: "bidding", round: 1 });
    engine.handleVoteSkip(io, room, sock("p1"));
    assert.equal(room.game.round, 1); // only 1 vote so far
    engine.handleVoteSkip(io, room, sock("p2"));
    assert.equal(room.game.round, 2); // both voted -> fresh round
  });

  test("the same player voting twice doesn't count as two votes", () => {
    const io = makeIO();
    const room = makeRoom({ phase: "bidding" });
    engine.handleVoteSkip(io, room, sock("p1"));
    engine.handleVoteSkip(io, room, sock("p1"));
    assert.equal(room.game.skipVotes.size, 1);
  });
});

describe("handleVoteEnd", () => {
  test("is a no-op outside endless mode", () => {
    const io = makeIO();
    const room = makeRoom({ target: 5, phase: "roundover" });
    engine.handleVoteEnd(io, room, sock("p1"));
    assert.equal(room.game.endVotes.size, 0); // vote never registered
    assert.equal(io.events.length, 0); // nothing broadcast
  });

  test("a mutual vote on a tied endless match ends it as a tie", () => {
    const io = makeIO();
    const room = makeRoom({ target: Infinity, scores: { p1: 3, p2: 3 } });
    engine.handleVoteEnd(io, room, sock("p1"));
    engine.handleVoteEnd(io, room, sock("p2"));
    assert.equal(room.game.phase, "matchover");
    assert.equal(room.game.matchWinnerId, null);
  });

  test("a mutual vote on an untied endless match awards the leader", () => {
    const io = makeIO();
    const room = makeRoom({ target: Infinity, scores: { p1: 5, p2: 2 } });
    engine.handleVoteEnd(io, room, sock("p1"));
    engine.handleVoteEnd(io, room, sock("p2"));
    assert.equal(room.game.phase, "matchover");
    assert.equal(room.game.matchWinnerId, "p1");
  });
});

describe("pause / resume", () => {
  test("pausing freezes the game and resuming pushes state back out", () => {
    const io = makeIO();
    const room = makeRoom({ phase: "bidding", deadline: Date.now() + 5000, timeout: setTimeout(() => {}, 5000) });
    engine.pauseGame(io, room);
    assert.equal(room.game.paused, true);
    assert.equal(room.game.deadline, null);
    engine.resumeGame(io, room);
    assert.equal(room.game.paused, false);
    assert.equal(io.lastState().paused, false);
  });

  test("pausing twice in a row is a no-op the second time", () => {
    const io = makeIO();
    const room = makeRoom({ phase: "bidding" });
    engine.pauseGame(io, room);
    const eventsAfterFirstPause = io.events.length;
    engine.pauseGame(io, room);
    assert.equal(io.events.length, eventsAfterFirstPause); // nothing new emitted
  });
});

describe("handlePauseRound", () => {
  test("only works between rounds while auto-advance is on", () => {
    const io = makeIO();
    const room = makeRoom({ phase: "bidding", autoAdvance: true });
    engine.handlePauseRound(io, room, sock("p1"));
    assert.equal(room.game.intermission, false); // wrong phase, ignored
  });

  test("sets intermission so the auto-advance timer won't fire", () => {
    const io = makeIO();
    const room = makeRoom({ phase: "roundover", autoAdvance: true, intermission: false });
    engine.handlePauseRound(io, room, sock("p1"));
    assert.equal(room.game.intermission, true);
  });
});

describe("handleRematch", () => {
  test("only the host can restart the match", () => {
    const io = makeIO();
    const room = makeRoom({ phase: "matchover" }, {});
    let ack; engine.handleRematch(io, room, sock("p2"), (r) => (ack = r)); // p1 is host
    assert.equal(ack.ok, false);
  });

  test("needs both seats filled", () => {
    const io = makeIO();
    const room = makeRoom({ phase: "matchover" });
    room.players.delete("p2");
    let ack; engine.handleRematch(io, room, sock("p1"), (r) => (ack = r));
    assert.equal(ack.ok, false);
  });

  test("the host restarting resets scores and round back to the top", () => {
    const io = makeIO();
    const room = makeRoom({ phase: "matchover", scores: { p1: 5, p2: 2 }, round: 8 });
    room.settings = { groups: ["Sports"] }; // a real group so buildPool has content
    let ack; engine.handleRematch(io, room, sock("p1"), (r) => (ack = r));
    assert.equal(ack.ok, true);
    assert.equal(room.game.round, 1);
    assert.equal(room.game.scores.p1, 0);
    assert.equal(room.game.scores.p2, 0);
    assert.equal(room.game.phase, "opening");
  });
});

describe("applyLiveSettings", () => {
  test("updates timer/target/autoAdvance going forward", () => {
    const io = makeIO();
    const room = makeRoom({ phase: "bidding" });
    engine.applyLiveSettings(io, room, { timer: 60, target: 10, autoAdvance: false });
    assert.equal(room.game.timer, 60);
    assert.equal(room.game.target, 10);
    assert.equal(room.game.autoAdvance, false);
  });

  test("null target switches to endless mode", () => {
    const io = makeIO();
    const room = makeRoom({ phase: "bidding", target: 5 });
    engine.applyLiveSettings(io, room, { target: null });
    assert.equal(room.game.target, Infinity);
  });

  test("lowering the target below an already-reached score ends the match immediately", () => {
    const io = makeIO();
    const room = makeRoom({ phase: "roundover", scores: { p1: 4, p2: 1 }, target: 10 });
    engine.applyLiveSettings(io, room, { target: 3 });
    assert.equal(room.game.phase, "matchover");
    assert.equal(room.game.matchWinnerId, "p1");
  });
});

describe("setGroups", () => {
  test("ignores an update with no valid group names", () => {
    const io = makeIO();
    const room = makeRoom({}, {});
    room.settings = { groups: ["Sports"] };
    engine.setGroups(io, room, ["NotARealGroup"]);
    assert.deepEqual(room.settings.groups, ["Sports"]); // unchanged
  });

  test("rebuilds the pool from a valid group selection", () => {
    const io = makeIO();
    const room = makeRoom();
    engine.setGroups(io, room, ["Sports", "NotReal"]);
    assert.deepEqual(room.game.groups, ["Sports"]);
    assert.ok(room.game.pool.length > 0);
    assert.ok(room.game.pool.every((c) => c.group === "Sports"));
  });
});

describe("endGameForLeaver", () => {
  test("tears down the match and flags the room as waiting again", () => {
    const io = makeIO();
    const room = makeRoom();
    engine.endGameForLeaver(io, room, "p1");
    assert.equal(room.game, null);
    assert.equal(room.status, "waiting");
    const left = io.events.find((e) => e.event === "opponentLeft");
    assert.equal(left.payload.name, "Alice");
  });
});

describe("startMatch (integration)", () => {
  test("wires up a fresh match from real category content and opens round 1", () => {
    const io = makeIO();
    const room = { code: "REAL", players: new Map([["p1", { id: "p1", name: "Alice", crown: false }], ["p2", { id: "p2", name: "Bob", crown: false }]]), spectators: new Map(), settings: { groups: ["Sports"] } };
    engine.startMatch(io, room);
    assert.equal(room.game.phase, "opening");
    assert.equal(room.game.round, 1);
    assert.ok(room.game.current.entries.length > 0);
    assert.equal(room.game.current.group, "Sports");
    const state = io.lastState();
    assert.equal(state.phase, "opening");
    assert.equal(state.players.length, 2);
  });
});
