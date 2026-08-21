"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { collapseResults, columnMax, scoresOf, wpmsOf, avgWpm } = require("../lib/leaderboard.js");

describe("collapseResults", () => {
  test("keeps each visitor's best run, not every run", () => {
    const players = collapseResults({
      results: [
        { name: "sam", vkey: "v1", total: 9, scores: [9] },
        { name: "sam", vkey: "v1", total: 14, scores: [14] },
      ],
    });
    assert.equal(players.length, 1);
    assert.equal(players[0].total, 14);
  });

  test("rows with no visitor id fall back to grouping by name", () => {
    const players = collapseResults({
      results: [
        { name: "sam", total: 4, scores: [4] },
        { name: "sam", total: 7, scores: [7] },
        { name: "ada", total: 5, scores: [5] },
      ],
    });
    assert.deepEqual(players.map((p) => [p.name, p.total]), [["sam", 7], ["ada", 5]]);
  });

  test("crowned rows merge into one creator entry — but a matching NAME does not", () => {
    // This used to merge any row whose name matched the creator's, which meant anyone could type
    // "Jayden", post a score, and have it rendered as the creator's own crowned entry. The crown is
    // server-validated against OWNER_KEY, so it is the only trustworthy signal; names are free.
    const players = collapseResults({
      creator: "Jayden",
      results: [
        { name: "jayden", vkey: "v1", total: 10, scores: [10] },
        { name: "Jayden", vkey: "v2", total: 21, scores: [21], crown: 1 },
        { name: "JAYDEN", vkey: "v3", total: 6, scores: [6] },
        { name: "sam", vkey: "v4", total: 8, scores: [8] },
      ],
    });
    const creator = players.find((p) => p.crown);
    assert.equal(creator.name, "Jayden"); // the crowned row wins the display name
    assert.equal(creator.total, 21);
    // Exactly one crowned entry, and the impostors stand on their own.
    assert.equal(players.filter((p) => p.crown).length, 1);
    assert.equal(players.length, 4);
    // The cost of the change: a creator playing without their owner key shows as an ordinary row.
    // That is the right trade against a stranger being displayed as the owner.
    assert.deepEqual(players.map((p) => [p.name, p.total]), [["Jayden", 21], ["jayden", 10], ["sam", 8], ["JAYDEN", 6]]);
  });

  test("two crowned rows still collapse to the best one", () => {
    const players = collapseResults({
      creator: "Jayden",
      results: [
        { name: "Jayden", vkey: "v1", total: 12, scores: [12], crown: 1 },
        { name: "Jayden", vkey: "v2", total: 30, scores: [30], crown: 1 },
      ],
    });
    assert.equal(players.length, 1);
    assert.equal(players[0].total, 30);
  });

  test("sorts by total, descending", () => {
    const players = collapseResults({
      results: [
        { name: "a", vkey: "v1", total: 3, scores: [3] },
        { name: "b", vkey: "v2", total: 12, scores: [12] },
        { name: "c", vkey: "v3", total: 7, scores: [7] },
      ],
    });
    assert.deepEqual(players.map((p) => p.total), [12, 7, 3]);
  });

  test("no results at all yields an empty board rather than throwing", () => {
    assert.deepEqual(collapseResults({}), []);
  });
});

describe("columnMax", () => {
  const players = [
    { scores: [3, 9], wpms: [40, 0] },
    { scores: [8, 2], wpms: [0, 55] },
  ];
  test("finds the best score in each round", () => {
    assert.deepEqual(columnMax(players, 2, scoresOf), [8, 9]);
  });
  test("treats missing values as 0", () => {
    assert.deepEqual(columnMax(players, 3, scoresOf), [8, 9, 0]);
  });
  test("works over the wpm columns too", () => {
    assert.deepEqual(columnMax(players, 2, wpmsOf), [40, 55]);
  });
});

describe("avgWpm", () => {
  test("averages only the rounds that recorded a speed", () => {
    assert.equal(avgWpm({ wpms: [60, 0, 40] }), 50);
  });
  test("a run with no speeds averages to 0", () => {
    assert.equal(avgWpm({ wpms: [] }), 0);
    assert.equal(avgWpm({}), 0);
  });
});

// What the boards PROMISE has to match what stats.js selects. There's no DOM in this harness, so —
// like test/styles.test.js does for Tailwind variants — these read the components as text. The
// failure they guard is a player being told a board is "all-time" for a run that was never eligible
// for it: CategoryBoard is rendered to whoever just finished a shared link (mode='link') too.
describe("the leaderboard copy doesn't over-promise", () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", "components", "leaderboard", f), "utf8");
  const STATS = fs.readFileSync(path.join(__dirname, "..", "server", "stats.js"), "utf8");

  test("the boards select solo AND shared-link runs — the copy below is written to that", () => {
    // If someone narrows or widens this again, the promises underneath go stale with it. That has
    // now happened once in each direction, which is why it's pinned.
    assert.equal([...STATS.matchAll(/challenge_results WHERE mode='solo' OR mode='link'/g)].length, 2,
      "categoryLeaderboard/geoGoat changed what they select; the board copy needs to change with them");
    // …and a link run only counts at the recommended time. Losing this guard would leave the copy
    // promising every shared-link play, which is how it read before.
    assert.equal([...STATS.matchAll(/r\.mode === "link" && timerById\[r\.challenge_id\] !== 0/g)].length, 2,
      "the recommended-time condition on link runs moved; the board copy describes it");
  });

  test("CategoryBoard says whose runs the board holds", () => {
    const src = read("CategoryBoard.jsx");
    assert.match(src, /Solo runs count,\s*\n?\s*plus shared-link plays that used the recommended time/);
    assert.doesNotMatch(src, /shared-link plays don&apos;t count/);
  });

  test("GoatBoard describes the scoring it actually uses", () => {
    const src = read("GoatBoard.jsx");
    // Main's rescoring: a full clear earns a bonus, and a leisurely one is never penalised.
    assert.match(src, /never a penalty/);
    assert.doesNotMatch(src, /½× slow/);
  });

  test("the geography tab's title is scoped to the boards its picker offers", () => {
    const src = read("LeaderboardModal.jsx");
    assert.doesNotMatch(src, /"All-time best per category"/);
    assert.match(src, /geoCats\.length\} geography boards/);
  });

  test("ChallengeBoard calls them rounds, like every other screen", () => {
    const src = read("ChallengeBoard.jsx");
    assert.doesNotMatch(src, /Question winners/);
    assert.match(src, /Round winners:/);
  });
});
