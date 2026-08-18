"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { norm, editDistance, nearMiss, findEntry } = require("../lib/solo-matching.js");

// A tiny stand-in for a category built by lib/solo-catalog.js (aliases are pre-normalised).
const cat = {
  entries: [
    { id: 0, display: "Norway", aliases: ["norway"] },
    { id: 1, display: "Cristiano Ronaldo", aliases: ["cristiano ronaldo", "cr7", "ronaldo"] },
    { id: 2, display: "Mbappé", aliases: ["mbappe"] },
  ],
};

describe("norm", () => {
  test("lowercases, trims and collapses whitespace", () => {
    assert.equal(norm("  Cristiano   RONALDO "), "cristiano ronaldo");
  });
  test("strips accents so 'mbappe' matches 'Mbappé'", () => {
    assert.equal(norm("Mbappé"), "mbappe");
  });
  test("coerces non-strings", () => {
    assert.equal(norm(42), "42");
  });
});

describe("editDistance", () => {
  test("identical strings are distance 0", () => {
    assert.equal(editDistance("norway", "norway"), 0);
  });
  test("counts single-character edits", () => {
    assert.equal(editDistance("nowray", "norway"), 2); // transposition = two edits
    assert.equal(editDistance("norwa", "norway"), 1);
  });
  test("bails out at 3 once the lengths can't be within 2", () => {
    assert.equal(editDistance("no", "norway"), 3);
  });
});

describe("findEntry", () => {
  test("matches any alias of an entry", () => {
    assert.equal(findEntry(cat, "cr7").id, 1);
    assert.equal(findEntry(cat, "ronaldo").id, 1);
  });
  test("returns null for something that isn't on the list", () => {
    assert.equal(findEntry(cat, "haaland"), null);
  });
});

describe("nearMiss", () => {
  test("a typo is reported as a spelling near-miss", () => {
    const m = nearMiss("norwya", cat);
    assert.equal(m.kind, "spell");
    assert.equal(m.entry.display, "Norway");
  });
  test("a prefix of a longer answer is reported as not specific enough", () => {
    const m = nearMiss("cristiano", cat);
    assert.equal(m.kind, "specific");
    assert.equal(m.entry.display, "Cristiano Ronaldo");
  });
  test("very short guesses are never near-misses (too many false hits)", () => {
    assert.equal(nearMiss("no", cat), null);
  });
  test("an unrelated guess is a real miss", () => {
    assert.equal(nearMiss("haaland", cat), null);
  });
  test("an exact alias is not a near-miss (the caller checks findEntry first)", () => {
    assert.equal(nearMiss("cr7", cat), null);
  });
});
