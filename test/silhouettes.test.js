"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { NO_POLYGON, SILHOUETTE_SOURCE, SILHOUETTE_CAT_NAMES } = require("../lib/silhouettes.js");

describe("Silhouette quizzes source list", () => {
  test("World plus one per continent, mirroring the Flags source order", () => {
    assert.deepEqual(SILHOUETTE_SOURCE.map(([, name]) => name), [
      "Silhouettes of the World", "Silhouettes of Africa", "Silhouettes of Asia", "Silhouettes of Europe",
      "Silhouettes of North America", "Silhouettes of South America", "Silhouettes of Oceania",
    ]);
  });

  test("each maps back to the Countries category it shares entries with", () => {
    for (const [baseName] of SILHOUETTE_SOURCE) assert.match(baseName, /^Countries (of|in) /);
  });

  test("SILHOUETTE_CAT_NAMES matches the source list", () => {
    for (const [, name] of SILHOUETTE_SOURCE) assert.ok(SILHOUETTE_CAT_NAMES.has(name));
    assert.equal(SILHOUETTE_CAT_NAMES.size, SILHOUETTE_SOURCE.length);
  });

  test("NO_POLYGON is a small, deliberate exclusion list, not empty and not most of the world", () => {
    assert.ok(NO_POLYGON.size > 0);
    assert.ok(NO_POLYGON.size < 10);
  });
});
