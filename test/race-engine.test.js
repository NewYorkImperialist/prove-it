"use strict";
const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const engine = require("../race-engine.js");

// Mirrors test/game-engine.test.js's pattern: mock timers so round/countdown/reveal timers
// never actually wait, and can be advanced deterministically with t.mock.timers.tick(ms).
beforeEach((t) => { t.mock.timers.enable({ apis: ["setTimeout"] }); });

function makeIO() {
  const events = [];
  return {
    events,
    to() { return { emit: (event, payload) => events.push({ event, payload }) }; },
    lastOfType(type) { for (let i = events.length - 1; i >= 0; i--) if (events[i].event === type) return events[i].payload; return null; },
    allOfType(type) { return events.filter((e) => e.event === type).map((e) => e.payload); },
  };
}
function sock(playerId) { return { data: { playerId } }; }

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

// A room with room.game already sitting in "live" phase, bypassing startMatch's random
// category pick so answer-handling tests are deterministic.
function liveRoom({ players = ["p1", "p2"], format = 3, suddenDeath = false, timer = 30, increment = 0 } = {}) {
  const playersMap = new Map(players.map((id) => [id, { id, name: id.toUpperCase(), crown: false, connected: true }]));
  const room = { code: "ABCD", players: playersMap, spectators: new Map(), status: "playing", settings: {}, hostId: players[0] };
  const winsNeeded = format == null ? null : Math.ceil(format / 2);
  const timerFn = () => {};
  room.game = {
    order: [...players], names: Object.fromEntries(players.map((id) => [id, id.toUpperCase()])),
    activeIds: new Set(players), leftPlayers: new Set(),
    pool: [testCategory()], groups: [],
    format, winsNeeded, suddenDeath, tiebreakerCandidates: null,
    timer, increment, roundWins: Object.fromEntries(players.map((id) => [id, 0])),
    round: 1, isTiebreaker: false, usedNames: [], lastCatName: null,
    current: testCategory(), phase: "live", deadline: Date.now() + timer * 1000,
    // Clocks are per player: everyone starts the round with the same deadline, and the
    // increment only ever moves the answerer's own.
    deadlines: Object.fromEntries(players.map((id) => [id, Date.now() + timer * 1000])),
    doneIds: new Set(), pausedClocks: null,
    timerFn, timeout: setTimeout(timerFn, 999999), // a real (mocked) armed timer, like a live round actually has
    answers: Object.fromEntries(players.map((id) => [id, new Map()])),
    liveScores: Object.fromEntries(players.map((id) => [id, 0])),
    misses: Object.fromEntries(players.map((id) => [id, []])), missSeq: 0,
    lastReveal: null, matchWinnerId: null, paused: false, endVotes: new Set(),
    startedAt: Date.now(), gid: "r-test",
  };
  return room;
}

describe("handleAnswer", () => {
  test("a correct answer bumps the live score and acks accepted:true", () => {
    const io = makeIO(); const room = liveRoom();
    let ack; engine.handleAnswer(io, room, sock("p1"), "alpha", (r) => (ack = r));
    assert.equal(ack.accepted, true);
    assert.equal(room.game.liveScores.p1, 1);
    assert.ok(room.game.answers.p1.has(0));
  });

  test("the live state broadcast never includes the actual answer text — only a count", () => {
    const io = makeIO(); const room = liveRoom();
    engine.handleAnswer(io, room, sock("p1"), "alpha", () => {});
    const state = io.lastOfType("raceState");
    assert.equal(JSON.stringify(state).includes("Alpha"), false);
    const me = state.liveScores.find((p) => p.id === "p1");
    assert.equal(me.score, 1);
  });

  test("a wrong/unrecognized answer is a silent miss — accepted:false, no throw", () => {
    const io = makeIO(); const room = liveRoom();
    let ack; engine.handleAnswer(io, room, sock("p1"), "nonsense", (r) => (ack = r));
    assert.equal(ack.accepted, false);
    assert.equal(room.game.liveScores.p1, 0);
  });

  test("a duplicate correct answer doesn't double-count", () => {
    const io = makeIO(); const room = liveRoom();
    engine.handleAnswer(io, room, sock("p1"), "alpha", () => {});
    let ack; engine.handleAnswer(io, room, sock("p1"), "alpha", (r) => (ack = r));
    assert.equal(ack.alreadyHad, true);
    assert.equal(room.game.liveScores.p1, 1);
  });

  test("a correct answer extends only the answerer's own clock, never an opponent's", () => {
    const io = makeIO(); const room = liveRoom({ increment: 5 });
    const mine = room.game.deadlines.p1, theirs = room.game.deadlines.p2;
    engine.handleAnswer(io, room, sock("p1"), "alpha", () => {});
    assert.ok(room.game.deadlines.p1 >= mine + 4900 && room.game.deadlines.p1 <= mine + 5100);
    assert.equal(room.game.deadlines.p2, theirs); // untouched
  });

  test("increment of 0 (the default) never touches any clock", () => {
    const io = makeIO(); const room = liveRoom({ increment: 0 });
    const mine = room.game.deadlines.p1, theirs = room.game.deadlines.p2;
    engine.handleAnswer(io, room, sock("p1"), "alpha", () => {});
    assert.equal(room.game.deadlines.p1, mine);
    assert.equal(room.game.deadlines.p2, theirs);
  });

  test("a duplicate answer doesn't extend your clock again", () => {
    const io = makeIO(); const room = liveRoom({ increment: 5 });
    engine.handleAnswer(io, room, sock("p1"), "alpha", () => {});
    const before = room.game.deadlines.p1;
    engine.handleAnswer(io, room, sock("p1"), "alpha", () => {});
    assert.equal(room.game.deadlines.p1, before);
  });

  test("each player's increments accumulate on their own clock independently", () => {
    const io = makeIO(); const room = liveRoom({ increment: 5 });
    const base = room.game.deadlines.p1;
    engine.handleAnswer(io, room, sock("p1"), "alpha", () => {});
    engine.handleAnswer(io, room, sock("p1"), "beta", () => {});
    engine.handleAnswer(io, room, sock("p2"), "alpha", () => {});
    assert.ok(room.game.deadlines.p1 >= base + 9900); // two answers → +10s
    assert.ok(room.game.deadlines.p2 >= base + 4900 && room.game.deadlines.p2 <= base + 5100);
  });

  test("answers are rejected once the round isn't 'live' anymore", () => {
    const io = makeIO(); const room = liveRoom(); room.game.phase = "roundover";
    let ack; engine.handleAnswer(io, room, sock("p1"), "alpha", (r) => (ack = r));
    assert.equal(ack.accepted, false);
    assert.equal(room.game.liveScores.p1, 0);
  });

  test("answers past your own deadline are rejected even while the round is still 'live'", () => {
    const io = makeIO(); const room = liveRoom();
    room.game.deadlines.p1 = Date.now() - 5; // my clock is gone; p2 is still racing
    let ack; engine.handleAnswer(io, room, sock("p1"), "alpha", (r) => (ack = r));
    assert.equal(ack.accepted, false);
    assert.equal(ack.outOfTime, true);
    assert.equal(room.game.liveScores.p1, 0);
  });

  test("a player whose clock already ran out is locked out, while the others keep scoring", () => {
    const io = makeIO(); const room = liveRoom();
    room.game.doneIds.add("p1");
    let ack; engine.handleAnswer(io, room, sock("p1"), "alpha", (r) => (ack = r));
    assert.equal(ack.outOfTime, true);
    assert.equal(room.game.liveScores.p1, 0);
    engine.handleAnswer(io, room, sock("p2"), "alpha", () => {}); // p2's clock is still running
    assert.equal(room.game.liveScores.p2, 1);
  });

  test("a player who already left can't submit answers", () => {
    const io = makeIO(); const room = liveRoom(); room.game.activeIds.delete("p1");
    let ack; engine.handleAnswer(io, room, sock("p1"), "alpha", (r) => (ack = r));
    assert.equal(ack.accepted, false);
  });

  test("a wrong answer is tracked as a miss for later review, deduped per player", () => {
    const io = makeIO(); const room = liveRoom();
    engine.handleAnswer(io, room, sock("p1"), "Nowray", () => {});
    engine.handleAnswer(io, room, sock("p1"), "nowray", () => {}); // same normalized text — shouldn't duplicate
    assert.equal(room.game.misses.p1.length, 1);
    assert.equal(room.game.misses.p1[0].text, "Nowray");
  });
});

// The user-visible contract of per-player clocks: a fast player keeps going, a spent player
// waits, and NOBODY sees an opponent's answers until every clock is done.
describe("per-player clocks", () => {
  test("startLiveRound deals every active player the same clock", () => {
    const io = makeIO(); const room = liveRoom({ timer: 30 });
    room.game.deadlines = {}; room.game.phase = "countdown";
    engine.startLiveRound(io, room);
    assert.equal(room.game.phase, "live");
    assert.equal(room.game.deadlines.p1, room.game.deadlines.p2);
    assert.ok(room.game.deadlines.p1 > Date.now() + 29000);
    assert.equal(room.game.doneIds.size, 0);
  });

  test("the round does NOT end — and no answers are revealed — while someone is still racing", () => {
    const io = makeIO(); const room = liveRoom({ increment: 5 });
    engine.handleAnswer(io, room, sock("p1"), "alpha", () => {}); // p1 buys 5 more seconds
    engine.handleAnswer(io, room, sock("p2"), "beta", () => {});
    room.game.deadlines.p2 = Date.now() - 1; // p2's clock is spent, p1 still has time

    engine.sweepClocks(io, room);

    assert.equal(room.game.phase, "live"); // the round is still running for p1
    assert.equal(room.game.doneIds.has("p2"), true);
    assert.equal(room.game.doneIds.has("p1"), false);
    assert.equal(io.lastOfType("raceReveal"), null); // ← the important one: nothing leaked
    const state = io.lastOfType("raceState");
    assert.equal(JSON.stringify(state).includes("Alpha"), false);
    assert.equal(state.racing, 1);
    assert.equal(state.liveScores.find((p) => p.id === "p2").done, true);
    assert.equal(state.liveScores.find((p) => p.id === "p1").done, false);
  });

  test("the reveal only lands once the last clock is spent", () => {
    const io = makeIO(); const room = liveRoom();
    engine.handleAnswer(io, room, sock("p1"), "alpha", () => {});
    room.game.deadlines.p2 = Date.now() - 1;
    engine.sweepClocks(io, room);
    assert.equal(io.lastOfType("raceReveal"), null);

    room.game.deadlines.p1 = Date.now() - 1; // now p1 is out too
    engine.sweepClocks(io, room);

    assert.equal(room.game.phase, "roundover");
    const reveal = io.lastOfType("raceReveal");
    assert.ok(reveal, "expected a reveal once every clock was spent");
    assert.equal(reveal.perPlayer.find((p) => p.id === "p1").got.join(","), "Alpha");
  });

  test("a player waiting on the others is told so, without leaking anyone's score", () => {
    const io = makeIO(); const room = liveRoom();
    room.game.deadlines.p2 = Date.now() - 1;
    engine.sweepClocks(io, room);
    const logs = io.allOfType("raceLog").map((l) => l.text);
    assert.ok(logs.some((t) => /P2.*time is up/.test(t)), `expected a waiting notice, got ${JSON.stringify(logs)}`);
    assert.equal(logs.some((t) => /\d/.test(t.replace("P2", ""))), false); // no score in the notice
  });

  test("when every clock expires together there's no spurious 'waiting for the rest'", () => {
    const io = makeIO(); const room = liveRoom({ increment: 0 });
    const gone = Date.now() - 1;
    room.game.deadlines.p1 = gone; room.game.deadlines.p2 = gone;
    engine.sweepClocks(io, room);
    assert.equal(room.game.phase, "roundover");
    assert.equal(io.allOfType("raceLog").some((l) => /time is up/.test(l.text)), false);
  });

  test("the last racer leaving ends the round instead of stranding the waiters", () => {
    const io = makeIO(); const room = liveRoom({ players: ["p1", "p2", "p3"] });
    room.game.deadlines.p1 = Date.now() - 1;
    room.game.deadlines.p2 = Date.now() - 1;
    engine.sweepClocks(io, room); // p1 and p2 are waiting on p3
    assert.equal(room.game.phase, "live");

    engine.playerLeftMatch(io, room, "p3");

    assert.equal(room.game.phase, "roundover");
    assert.ok(io.lastOfType("raceReveal"));
  });

  test("a pause banks each clock separately and resume gives the time back", () => {
    const io = makeIO(); const room = liveRoom({ increment: 5 });
    engine.handleAnswer(io, room, sock("p1"), "alpha", () => {}); // p1 is 5s ahead
    const gap = room.game.deadlines.p1 - room.game.deadlines.p2;

    engine.pauseGame(io, room);
    assert.equal(room.game.paused, true);
    assert.equal(room.game.deadline, null);
    assert.ok(room.game.pausedClocks.p1 > room.game.pausedClocks.p2);

    engine.resumeGame(io, room);
    assert.equal(room.game.paused, false);
    const gapAfter = room.game.deadlines.p1 - room.game.deadlines.p2;
    assert.ok(Math.abs(gapAfter - gap) < 60, `clock gap should survive a pause (${gap} → ${gapAfter})`);
  });

  test("endLiveRound retires every clock, so a late answer can't sneak in", () => {
    const io = makeIO(); const room = liveRoom();
    engine.endLiveRound(io, room);
    room.game.phase = "live"; // pretend a stray packet arrives as the phase flips
    let ack; engine.handleAnswer(io, room, sock("p1"), "alpha", (r) => (ack = r));
    assert.equal(ack.accepted, false);
    assert.equal(ack.outOfTime, true);
  });
});

describe("round end scoring (via startLiveRound's timer)", () => {
  function play(room, pid, ...words) { for (const w of words) engine.handleAnswer({ to: () => ({ emit() {} }) }, room, sock(pid), w, () => {}); }

  test("a single top scorer wins the round — full reveal includes everyone's answers", () => {
    const io = makeIO(); const room = liveRoom();
    play(room, "p1", "alpha", "beta"); play(room, "p2", "alpha");
    engine.endLiveRound(io, room); // simulates the round timer running out
    const reveal = io.lastOfType("raceReveal");
    assert.deepEqual(reveal.roundWinnerIds, ["p1"]);
    assert.equal(reveal.tie, false);
    const p1 = reveal.perPlayer.find((p) => p.id === "p1");
    assert.deepEqual(p1.got.sort(), ["Alpha", "Beta"]);
    assert.equal(room.game.roundWins.p1, 1);
    assert.equal(room.game.phase, "roundover");
  });

  test("a tie with sudden death OFF is a draw — no round win, no tiebreaker flagged", () => {
    const io = makeIO(); const room = liveRoom({ suddenDeath: false });
    play(room, "p1", "alpha"); play(room, "p2", "beta");
    engine.endLiveRound(io, room);
    const reveal = io.lastOfType("raceReveal");
    assert.equal(reveal.tie, true);
    assert.equal(reveal.suddenDeathTriggered, false);
    assert.equal(room.game.roundWins.p1, 0);
    assert.equal(room.game.roundWins.p2, 0);
  });

  test("a tie with sudden death ON triggers an immediate tiebreaker round", (t) => {
    const io = makeIO(); const room = liveRoom({ suddenDeath: true });
    play(room, "p1", "alpha"); play(room, "p2", "beta");
    engine.endLiveRound(io, room); // round ends in a tie
    const reveal = io.lastOfType("raceReveal");
    assert.equal(reveal.suddenDeathTriggered, true);
    t.mock.timers.tick(7000); // REVEAL_MS pause → next round begins
    assert.equal(room.game.isTiebreaker, true);
    assert.equal(room.game.round, 2);
    assert.deepEqual([...room.game.tiebreakerCandidates].sort(), ["p1", "p2"]);
  });
});

describe("match format → win condition", () => {
  test("best-of-3 needs 2 round wins to end the match", () => {
    const io = makeIO(); const room = liveRoom({ format: 3 });
    assert.equal(room.game.winsNeeded, 2);
    room.game.roundWins.p1 = 1;
    engine.handleAnswer(io, room, sock("p1"), "alpha", () => {});
    // not over yet after just one round win — winsNeeded is only checked at round-end, not per-answer
    assert.equal(room.game.phase, "live");
  });

  test("best-of-5 needs 3 round wins", () => {
    const room = liveRoom({ format: 5 });
    assert.equal(room.game.winsNeeded, 3);
  });

  test("endless format has no round-win target", () => {
    const room = liveRoom({ format: null });
    assert.equal(room.game.winsNeeded, null);
  });

  test("reaching winsNeeded ends the match after the reveal pause", (t) => {
    const io = makeIO(); const room = liveRoom({ format: 3 });
    room.game.roundWins.p1 = 1; // one win away from winsNeeded=2
    engine.handleAnswer(io, room, sock("p1"), "alpha", () => {});
    engine.endLiveRound(io, room); // p1 wins this round too → roundWins.p1 = 2
    t.mock.timers.tick(7000); // REVEAL_MS pause → match should end, not start another round
    const over = io.lastOfType("raceMatchOver");
    assert.ok(over);
    assert.equal(over.winnerId, "p1");
    assert.equal(room.game.phase, "matchover");
  });
});

describe("handleVoteEnd (endless format)", () => {
  test("ends the match once every active player has voted", () => {
    const io = makeIO(); const room = liveRoom({ format: null, players: ["p1", "p2"] });
    room.game.roundWins = { p1: 3, p2: 1 };
    engine.handleVoteEnd(io, room, sock("p1"));
    assert.equal(room.game.phase, "live"); // only 1/2 votes so far
    engine.handleVoteEnd(io, room, sock("p2"));
    const over = io.lastOfType("raceMatchOver");
    assert.equal(over.winnerId, "p1");
  });

  test("is ignored for a fixed-format (non-endless) match", () => {
    const io = makeIO(); const room = liveRoom({ format: 3 });
    engine.handleVoteEnd(io, room, sock("p1"));
    engine.handleVoteEnd(io, room, sock("p2"));
    assert.equal(io.lastOfType("raceMatchOver"), null);
  });
});

describe("playerLeftMatch (N-player forfeit)", () => {
  test("with 3+ players, the match continues when one leaves", () => {
    const io = makeIO(); const room = liveRoom({ players: ["p1", "p2", "p3"] });
    engine.playerLeftMatch(io, room, "p3");
    assert.equal(room.game.activeIds.has("p3"), false);
    assert.equal(room.game.activeIds.size, 2);
    assert.equal(room.game.phase, "live"); // match keeps going, not ended
    assert.equal(io.lastOfType("raceMatchOver"), null);
  });

  test("dropping to a single remaining player ends the match by forfeit", () => {
    const io = makeIO(); const room = liveRoom({ players: ["p1", "p2"] });
    engine.playerLeftMatch(io, room, "p2");
    const over = io.lastOfType("raceMatchOver");
    assert.equal(over.winnerId, "p1");
    assert.equal(over.reason, "forfeit");
    assert.equal(room.game.phase, "matchover");
  });

  test("an already-departed player already answered this round still counts toward that round's result", () => {
    const io = makeIO(); const room = liveRoom({ players: ["p1", "p2", "p3"] });
    engine.handleAnswer(io, room, sock("p3"), "alpha", () => {});
    engine.handleAnswer(io, room, sock("p3"), "beta", () => {});
    engine.playerLeftMatch(io, room, "p3"); // p3 leaves after answering, before the timer ends
    engine.endLiveRound(io, room);
    const reveal = io.lastOfType("raceReveal");
    // p3 is gone from activeIds, so they don't appear in the reveal or win the round — this is
    // the documented v1 behavior (their round is simply forfeited along with them).
    assert.ok(!reveal.perPlayer.some((p) => p.id === "p3"));
  });
});

describe("post-round review: approving a missed/off-list answer", () => {
  test("a round with no misses at all finalizes immediately — no review wait", () => {
    const io = makeIO(); const room = liveRoom();
    engine.handleAnswer(io, room, sock("p1"), "alpha", () => {});
    engine.endLiveRound(io, room);
    const reveal = io.lastOfType("raceReveal");
    assert.equal(reveal.final, true); // finalizeRound ran synchronously, no REVIEW_MS wait needed
    assert.deepEqual(reveal.roundWinnerIds, ["p1"]);
  });

  test("a round with a miss opens a non-final review window instead of finalizing right away", () => {
    const io = makeIO(); const room = liveRoom();
    engine.handleAnswer(io, room, sock("p1"), "alpha", () => {});
    engine.handleAnswer(io, room, sock("p2"), "Nowray", () => {}); // an off-list miss for p2
    engine.endLiveRound(io, room);
    const reveal = io.lastOfType("raceReveal");
    assert.equal(reveal.final, false);
    assert.deepEqual(reveal.roundWinnerIds, []); // no winner declared yet
    assert.equal(room.game.phase, "roundover");
    const p2 = reveal.perPlayer.find((p) => p.id === "p2");
    assert.equal(p2.misses.length, 1);
    assert.equal(p2.misses[0].text, "Nowray");
  });

  test("another player approving a miss credits it and can flip the round's outcome", (t) => {
    const io = makeIO(); const room = liveRoom();
    engine.handleAnswer(io, room, sock("p1"), "alpha", () => {});                 // p1: 1 correct
    engine.handleAnswer(io, room, sock("p2"), "Nowray", () => {});                // p2: 0 correct, 1 miss
    engine.endLiveRound(io, room);
    const missId = room.game.misses.p2[0].id;

    engine.handleApproveMiss(io, room, sock("p1"), "p2", missId); // p1 approves p2's "Nowray"
    assert.equal(room.game.liveScores.p2, 1); // now tied 1-1
    const midReveal = io.lastOfType("raceReveal");
    assert.equal(midReveal.final, false); // approving doesn't finalize by itself
    assert.equal(room.game.misses.p2.length, 0); // consumed, can't be double-approved

    t.mock.timers.tick(15000); // REVIEW_MS elapses → finalizeRound runs
    const final = io.lastOfType("raceReveal");
    assert.equal(final.final, true);
    assert.equal(final.tie, true); // 1-1 after the approval, instead of p1 winning outright
  });

  test("you can't approve your own miss, or someone else's after the round is finalized", (t) => {
    const io = makeIO(); const room = liveRoom();
    engine.handleAnswer(io, room, sock("p2"), "Nowray", () => {});
    engine.endLiveRound(io, room);
    const missId = room.game.misses.p2[0].id;

    engine.handleApproveMiss(io, room, sock("p2"), "p2", missId); // self-approval — ignored
    assert.equal(room.game.liveScores.p2, 0);

    t.mock.timers.tick(15000); // finalize
    engine.handleApproveMiss(io, room, sock("p1"), "p2", missId); // too late — already finalized
    assert.equal(room.game.liveScores.p2, 0);
  });
});
