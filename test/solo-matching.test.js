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

// norm() keeps punctuation, so a punctuation-free spelling landed one edit away from the answer —
// i.e. inside nearMiss's "almost, check your spelling" loop, which can't be escaped because the
// spelling was already right. It can't just be stripped in norm(), though: several categories hold
// answers that differ ONLY by punctuation, and merging those would make the ones behind the
// collision unwinnable.
describe("findEntry — punctuation", () => {
  const punct = {
    entries: [
      { id: 0, display: "Kareem Abdul-Jabbar", aliases: ["kareem abdul-jabbar"] },
      { id: 1, display: "John F. Kennedy", aliases: ["john f. kennedy"] },
      { id: 2, display: "Nuku'alofa", aliases: ["nuku'alofa"] },
    ],
  };
  test("an exact alias still wins, unchanged", () => {
    assert.equal(findEntry(punct, norm("Kareem Abdul-Jabbar")).id, 0);
  });
  test("the same name typed without its punctuation counts", () => {
    assert.equal(findEntry(punct, norm("Kareem Abdul Jabbar")).id, 0);
    assert.equal(findEntry(punct, norm("John F Kennedy")).id, 1);
    assert.equal(findEntry(punct, norm("Nukualofa")).id, 2);
  });
  test("run together with no spaces at all, too", () => {
    assert.equal(findEntry(punct, norm("kareemabduljabbar")).id, 0);
  });
  test("an unrelated guess is still a miss", () => {
    assert.equal(findEntry(punct, norm("Michael Jordan")), null);
  });

  // The reason this is a fallback and not part of norm().
  const langs = {
    entries: [
      { id: 0, display: "C", aliases: ["c"] },
      { id: 1, display: "C++", aliases: ["c++", "cpp"] },
      { id: 2, display: "C#", aliases: ["c#", "c sharp"] },
    ],
  };
  test("answers that differ only by punctuation are each still reachable", () => {
    assert.equal(findEntry(langs, norm("C")).display, "C");
    assert.equal(findEntry(langs, norm("C++")).display, "C++");
    assert.equal(findEntry(langs, norm("C#")).display, "C#");
  });
  test("a guess that can't tell them apart resolves to nothing rather than guessing", () => {
    // "csharp" strips to "csharp", which is only C#'s — but a bare "see" style key that maps to
    // all three has to come back null so the near-miss path handles it instead of picking one.
    const ambiguous = {
      entries: [
        { id: 0, display: "B-Tree", aliases: ["b-tree"] },
        { id: 1, display: "B*Tree", aliases: ["b*tree"] },
      ],
    };
    assert.equal(findEntry(ambiguous, norm("btree")), null);
  });
  test("…but the punctuation you did type breaks the tie when it can", () => {
    const ambiguous = {
      entries: [
        { id: 0, display: "B-Tree", aliases: ["b-tree"] },
        { id: 1, display: "B+ Tree", aliases: ["b+ tree"] },
      ],
    };
    assert.equal(findEntry(ambiguous, norm("B+Tree")).display, "B+ Tree");
    assert.equal(findEntry(ambiguous, norm("B-Tree")).display, "B-Tree");
  });
});
