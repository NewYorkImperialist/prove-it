"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { NO_POLYGON, BORDER_SOURCE, BORDER_CAT_NAMES } = require("../lib/borders.js");

describe("Borders quizzes source list", () => {
  test("World plus one per continent, mirroring the Flags source order", () => {
    assert.deepEqual(BORDER_SOURCE.map(([, name]) => name), [
      "Borders of the World", "Borders of Africa", "Borders of Asia", "Borders of Europe",
      "Borders of North America", "Borders of South America", "Borders of Oceania",
    ]);
  });

  test("each maps back to the Countries category it shares entries with", () => {
    for (const [baseName] of BORDER_SOURCE) assert.match(baseName, /^Countries (of|in) /);
  });

  test("BORDER_CAT_NAMES matches the source list", () => {
    for (const [, name] of BORDER_SOURCE) assert.ok(BORDER_CAT_NAMES.has(name));
    assert.equal(BORDER_CAT_NAMES.size, BORDER_SOURCE.length);
  });

  test("NO_POLYGON is a small, deliberate exclusion list, not empty and not most of the world", () => {
    assert.ok(NO_POLYGON.size > 0);
    assert.ok(NO_POLYGON.size < 10);
  });
});
