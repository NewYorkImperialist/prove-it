"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const CATEGORY_GROUPS = require("../data/categories.js");
const { CATS, GENRES, GEO_MISC, findCat, nonSprint, recommendedTime, pickGenreRounds, geoBoardCats, buildCat } = require("../lib/solo-catalog.js");

describe("the solo catalogue", () => {
  test("flattens every non-hidden category into { name, group, emoji, entries }", () => {
    const expected = Object.values(CATEGORY_GROUPS).filter((g) => !g.defaultOff).reduce((n, g) => n + g.cats.length, 0);
    assert.equal(CATS.length, expected);
    for (const c of CATS) {
      assert.ok(c.name && c.group && c.emoji, `${c.name} is missing a field`);
      assert.ok(c.entries.length > 0, `${c.name} has no entries`);
    }
  });

  test("leaves the defaultOff (Secret) group out of solo entirely", () => {
    const hidden = Object.entries(CATEGORY_GROUPS).filter(([, g]) => g.defaultOff).map(([k]) => k);
    assert.ok(hidden.length > 0, "expected at least one defaultOff group to exist");
    for (const g of hidden) assert.equal(CATS.some((c) => c.group === g), false);
  });

  test("splits Geography: categories with a board stay put, the rest become Geography Misc", () => {
    assert.ok(CATS.some((c) => c.group === "Geography" && c.name === "Countries of the World"));
    const misc = CATS.filter((c) => c.group === GEO_MISC);
    assert.ok(misc.length > 0);
    for (const c of misc) assert.equal(geoBoardCats().includes(c.name), false);
  });

  test("orders the genres with Geography first, then Geography Misc", () => {
    assert.equal(GENRES[0], "Geography");
    assert.equal(GENRES[1], GEO_MISC);
  });

  test("aliases all match one entry, and the first name is the one displayed", () => {
    const cat = buildCat({ name: "T", items: [["Cristiano Ronaldo", "cr7"], "Norway"] }, "G", "🎯");
    assert.deepEqual(cat.entries[0], { id: 0, display: "Cristiano Ronaldo", aliases: ["cristiano ronaldo", "cr7"] });
    assert.equal(cat.entries[1].display, "Norway");
  });

  test("findCat looks a category up by its exact name", () => {
    assert.equal(findCat("US States").name, "US States");
    assert.equal(findCat("Not A Category"), null);
  });
});

describe("nonSprint", () => {
  test("flags the troll categories", () => {
    assert.equal(nonSprint(findCat("Counting Numbers")), true);
  });
  test("flags anything with fewer than 12 answers", () => {
    assert.equal(nonSprint({ name: "Tiny", entries: new Array(11) }), true);
    assert.equal(nonSprint({ name: "Big", entries: new Array(12) }), false);
  });
  test("a normal, deep category is sprintable", () => {
    assert.equal(nonSprint(findCat("US States")), false);
  });
});

describe("recommendedTime", () => {
  test("the big enumerations get their own length", () => {
    assert.equal(recommendedTime("Countries of the World"), 900);
    assert.equal(recommendedTime("US States"), 240);
  });
  test("everything else defaults to 45s", () => {
    assert.equal(recommendedTime("Car Brands"), 45);
  });
});

describe("pickGenreRounds", () => {
  test("returns n categories from the requested genre", () => {
    const rounds = pickGenreRounds("Geography", 3);
    assert.equal(rounds.length, 3);
    for (const name of rounds) assert.equal(findCat(name).group, "Geography");
  });
  test("skips non-sprint categories", () => {
    for (const name of pickGenreRounds("Pop Culture", 5)) assert.equal(nonSprint(findCat(name)), false);
  });
  test("repeat-fills when the genre has fewer categories than rounds asked for", () => {
    const rounds = pickGenreRounds("Geography", 200);
    assert.equal(rounds.length, 200);
  });
  test("an unknown genre yields nothing rather than throwing", () => {
    assert.deepEqual(pickGenreRounds("Nope", 3), []);
  });
});
