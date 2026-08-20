"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const CATEGORY_GROUPS = require("../data/categories.js");
const {
  CATS, GENRES, GEO_MISC, findCat, nonSprint, recommendedTime, pickGenreRounds, geoBoardCats, buildCat,
  FLAG_CATS, SILHOUETTE_CATS,
} = require("../lib/solo-catalog.js");

describe("the solo catalogue", () => {
  test("flattens every non-hidden category into { name, group, emoji, entries }, plus the Flags/Silhouette quizzes", () => {
    const expected = Object.values(CATEGORY_GROUPS).filter((g) => !g.defaultOff).reduce((n, g) => n + g.cats.length, 0);
    assert.equal(CATS.length, expected + FLAG_CATS.length + SILHOUETTE_CATS.length);
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

describe("Flags quizzes", () => {
  test("World plus one per continent, in that order", () => {
    assert.deepEqual(FLAG_CATS.map((c) => c.name), [
      "Flags of the World", "Flags of Africa", "Flags of Asia", "Flags of Europe",
      "Flags of North America", "Flags of South America", "Flags of Oceania",
    ]);
  });

  test("each one has the same entry count as its Countries counterpart, and every entry has a flag code", () => {
    const pairs = [
      ["Flags of the World", "Countries of the World"], ["Flags of Africa", "Countries in Africa"],
      ["Flags of Oceania", "Countries in Oceania"],
    ];
    for (const [flagName, countryName] of pairs) {
      const flagCat = findCat(flagName);
      assert.equal(flagCat.entries.length, findCat(countryName).entries.length);
      for (const e of flagCat.entries) assert.match(e.flagCode, /^[a-z]{2}$/, `${e.display} in ${flagName}`);
    }
  });

  test("are folded into the Geography group — the generic picker, genre pool, and Geography Challenge all see them", () => {
    for (const c of FLAG_CATS) {
      assert.equal(CATS.includes(c), true, `${c.name} should be the exact same object in CATS`);
      assert.equal(c.group, "Geography");
      assert.equal(nonSprint(c), false);
    }
  });

  test("still resolve via findCat, so a saved run's rounds replay correctly", () => {
    assert.equal(findCat("Flags of Europe").group, "Geography");
  });

  test("get their own leaderboard alongside the geography boards", () => {
    for (const c of FLAG_CATS) assert.ok(geoBoardCats().includes(c.name), c.name);
  });

  test("mirror their Countries counterpart's recommended time", () => {
    assert.equal(recommendedTime("Flags of the World"), recommendedTime("Countries of the World"));
    assert.equal(recommendedTime("Flags of Oceania"), recommendedTime("Countries in Oceania"));
  });
});

describe("Silhouette quizzes", () => {
  test("World plus one per continent, in that order", () => {
    assert.deepEqual(SILHOUETTE_CATS.map((c) => c.name), [
      "Silhouettes of the World", "Silhouettes of Africa", "Silhouettes of Asia", "Silhouettes of Europe",
      "Silhouettes of North America", "Silhouettes of South America", "Silhouettes of Oceania",
    ]);
  });

  test("share entries with their Countries counterpart, minus the couple with no drawable polygon", () => {
    const pairs = [
      ["Silhouettes of the World", "Countries of the World", 1], // Tuvalu
      ["Silhouettes of Africa", "Countries in Africa", 0],
      ["Silhouettes of South America", "Countries in South America", 1], // French Guiana
      ["Silhouettes of Oceania", "Countries in Oceania", 1], // Tuvalu
    ];
    for (const [silName, countryName, excluded] of pairs) {
      assert.equal(findCat(silName).entries.length, findCat(countryName).entries.length - excluded, silName);
    }
  });

  test("are folded into the Geography group, same as the Flags quizzes", () => {
    for (const c of SILHOUETTE_CATS) {
      assert.equal(CATS.includes(c), true, `${c.name} should be the exact same object in CATS`);
      assert.equal(c.group, "Geography");
      assert.equal(c.isSilhouetteQuiz, true);
      assert.equal(nonSprint(c), false);
    }
  });

  test("get their own leaderboard alongside the geography and Flags boards", () => {
    for (const c of SILHOUETTE_CATS) assert.ok(geoBoardCats().includes(c.name), c.name);
  });

  test("mirror their Countries counterpart's recommended time", () => {
    assert.equal(recommendedTime("Silhouettes of the World"), recommendedTime("Countries of the World"));
    assert.equal(recommendedTime("Silhouettes of Oceania"), recommendedTime("Countries in Oceania"));
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
