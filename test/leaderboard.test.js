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
        { name: "sam", visitor_id: "v1", total: 9, scores: [9] },
        { name: "sam", visitor_id: "v1", total: 14, scores: [14] },
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

  test("every crowned row and anyone sharing the creator's name merge into one crowned entry", () => {
    const players = collapseResults({
      creator: "Jayden",
      results: [
        { name: "jayden", visitor_id: "v1", total: 10, scores: [10] },
        { name: "Jayden", visitor_id: "v2", total: 21, scores: [21], crown: 1 },
        { name: "JAYDEN", visitor_id: "v3", total: 6, scores: [6] },
        { name: "sam", visitor_id: "v4", total: 8, scores: [8] },
      ],
    });
    assert.equal(players.length, 2);
    const creator = players.find((p) => p.crown);
    assert.equal(creator.name, "Jayden"); // the crowned row wins the display name
    assert.equal(creator.total, 21);
  });

  test("sorts by total, descending", () => {
    const players = collapseResults({
      results: [
        { name: "a", visitor_id: "v1", total: 3, scores: [3] },
        { name: "b", visitor_id: "v2", total: 12, scores: [12] },
        { name: "c", visitor_id: "v3", total: 7, scores: [7] },
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
  const STATS = fs.readFileSync(path.join(__dirname, "..", "stats.js"), "utf8");

  test("stats.js still counts solo runs only — the copy below is written to that", () => {
    assert.equal([...STATS.matchAll(/challenge_results WHERE mode='solo'/g)].length, 2,
      "categoryLeaderboard/geoGoat changed what they select; the board copy needs to change with them");
  });

  test("CategoryBoard says whose runs the board holds", () => {
    const src = read("CategoryBoard.jsx");
    assert.match(src, /All-time best <b>solo<\/b> runs on/);
    assert.match(src, /shared-link plays don&apos;t count/);
  });

  test("GoatBoard doesn't claim points from every kind of run", () => {
    const src = read("GoatBoard.jsx");
    assert.doesNotMatch(src, /Points across <b>every<\/b> geography category/);
    assert.match(src, /Points from your <b>solo<\/b> runs/);
    // The multiplier half of that sentence is accurate — it should survive any rewording.
    assert.match(src, /up to 2× fast, ½× slow/);
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
