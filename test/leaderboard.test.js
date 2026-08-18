"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
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
