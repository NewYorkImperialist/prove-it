"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const CATEGORY_GROUPS = require("../data/categories.js");
const {
  CATS, GENRES, findCat, nonSprint, recommendedTime, QUICK_MAX_SECONDS, quickPlayPool,
  genreRoundLimit, pickGenreRounds, geoBoardCats, buildCat, FLAG_CATS, BORDER_CATS,
} = require("../lib/solo-catalog.js");

describe("the solo catalogue", () => {
  test("flattens every non-hidden category into { name, group, emoji, entries }, plus the Flags/Border quizzes", () => {
    const expected = Object.values(CATEGORY_GROUPS).filter((g) => !g.defaultOff).reduce((n, g) => n + g.cats.length, 0);
    assert.equal(CATS.length, expected + FLAG_CATS.length + BORDER_CATS.length);
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

  test("only ever names groups that exist in data/categories.js — no pseudo-groups", () => {
    const real = new Set(Object.keys(CATEGORY_GROUPS));
    for (const c of CATS) assert.ok(real.has(c.group), `${c.name} is filed under invented group ${c.group}`);
    assert.equal(GENRES.includes("Geography Misc"), false); // players were shown this one
  });

  test("orders Geography first, boards before the boardless geography categories", () => {
    assert.equal(GENRES[0], "Geography");
    const geo = CATS.filter((c) => c.group === "Geography");
    const boards = geoBoardCats();
    const lastBoard = geo.reduce((n, c, i) => (boards.includes(c.name) ? i : n), -1);
    const firstBoardless = geo.findIndex((c) => !boards.includes(c.name));
    assert.ok(lastBoard >= 0 && firstBoardless > lastBoard, "a boardless geography category sorted above a board one");
    assert.equal(CATS[0].group, "Geography");
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

describe("Border quizzes", () => {
  test("World plus one per continent, in that order", () => {
    assert.deepEqual(BORDER_CATS.map((c) => c.name), [
      "Borders of the World", "Borders of Africa", "Borders of Asia", "Borders of Europe",
      "Borders of North America", "Borders of South America", "Borders of Oceania",
    ]);
  });

  test("share entries with their Countries counterpart, minus the couple with no drawable polygon", () => {
    const pairs = [
      ["Borders of the World", "Countries of the World", 1], // Tuvalu
      ["Borders of Africa", "Countries in Africa", 0],
      ["Borders of South America", "Countries in South America", 1], // French Guiana
      ["Borders of Oceania", "Countries in Oceania", 1], // Tuvalu
    ];
    for (const [borderName, countryName, excluded] of pairs) {
      assert.equal(findCat(borderName).entries.length, findCat(countryName).entries.length - excluded, borderName);
    }
  });

  test("are folded into the Geography group, same as the Flags quizzes", () => {
    for (const c of BORDER_CATS) {
      assert.equal(CATS.includes(c), true, `${c.name} should be the exact same object in CATS`);
      assert.equal(c.group, "Geography");
      assert.equal(c.isBorderQuiz, true);
      assert.equal(nonSprint(c), false);
    }
  });

  test("get their own leaderboard alongside the geography and Flags boards", () => {
    for (const c of BORDER_CATS) assert.ok(geoBoardCats().includes(c.name), c.name);
  });

  test("mirror their Countries counterpart's recommended time", () => {
    assert.equal(recommendedTime("Borders of the World"), recommendedTime("Countries of the World"));
    assert.equal(recommendedTime("Borders of Oceania"), recommendedTime("Countries in Oceania"));
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
  test("never repeats a category — the builder promises a different one each round", () => {
    for (const genre of GENRES) {
      const rounds = pickGenreRounds(genre, 10);
      assert.equal(new Set(rounds).size, rounds.length, `${genre} repeated a category`);
    }
  });
  test("a genre smaller than the round count plays a shorter run, and says how short", () => {
    const small = GENRES.find((g) => genreRoundLimit(g) < 10);
    assert.ok(small, "expected at least one genre with fewer than 10 usable categories");
    assert.equal(pickGenreRounds(small, 10).length, genreRoundLimit(small));
    assert.equal(pickGenreRounds("Geography", 200).length, genreRoundLimit("Geography"));
  });
  test("an unknown genre yields nothing rather than throwing", () => {
    assert.deepEqual(pickGenreRounds("Nope", 3), []);
    assert.equal(genreRoundLimit("Nope"), 0);
  });
});

describe("quickPlayPool", () => {
  test("is every sprintable category short enough for one quick round", () => {
    const pool = quickPlayPool();
    assert.ok(pool.length > 20);
    for (const c of pool) {
      assert.equal(nonSprint(c), false, c.name);
      assert.ok(recommendedTime(c.name) <= QUICK_MAX_SECONDS, `${c.name} wants ${recommendedTime(c.name)}s`);
    }
  });
  test("leaves out the 15-minute enumerations Quick play used to hand out", () => {
    const names = quickPlayPool().map((c) => c.name);
    assert.equal(names.includes("Countries of the World"), false);
    assert.equal(names.includes("World Capitals"), false);
    assert.equal(names.includes("Car Brands"), true);
  });
});

// The Geography Challenge exists to put you on a map, a flag grid or a borders quiz. Picking the
// group by name instead meant the picker (and the random pick) also offered the group's ordinary
// typing lists, which have nothing to draw.
describe("geoChallengeCats", () => {
  const { geoChallengeCats, geoBoardCats, CATS } = require("../lib/solo-catalog.js");
  const { hasGeoBoard } = require("../lib/geo-cats.js");

  test("offers only categories that actually have a board", () => {
    const withoutBoard = geoChallengeCats().filter((n) => {
      const c = CATS.find((x) => x.name === n);
      return !hasGeoBoard(n) && !c?.isFlagQuiz && !c?.isBorderQuiz;
    });
    assert.deepEqual(withoutBoard, [], "these have no map, flag grid or borders quiz to draw");
  });

  test("in particular, none of the plain geography typing lists", () => {
    const pool = geoChallengeCats();
    for (const n of [
      "Languages of the World", "Natural Disasters", "Major Rivers", "Famous Mountains",
      "Deserts", "Seas and Oceans", "Tourist Attractions in America", "Major American Cities",
    ]) {
      assert.ok(!pool.includes(n), `"${n}" has no board and shouldn't be a Geography Challenge`);
    }
  });

  test("and every board IS offered — including the small ones you can only reach deliberately", () => {
    // Countries in Central America is 7 answers, so the under-12 sprint filter was hiding a real
    // map from a picker where the player chooses on purpose.
    assert.deepEqual([...geoChallengeCats()].sort(), [...geoBoardCats()].sort());
    assert.ok(geoChallengeCats().includes("Countries in Central America"));
  });
});
