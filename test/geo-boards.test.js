"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { MODES, modeOf, regionLabel, boardsFor, allBoards, findBoard } = require("../lib/geo-boards.js");
const { CATS, FLAG_CATS, geoBoardCats } = require("../lib/solo-catalog.js");
const { hasGeoBoard } = require("../lib/geo-cats.js");

// Geography's own screen is built out of this arrangement, so a board that falls out of it is a
// board the player can no longer reach from the front door.
describe("the Geography screen's mode × region arrangement", () => {
  test("covers every board category exactly once", () => {
    const arranged = allBoards().map((b) => b.name);
    assert.equal(new Set(arranged).size, arranged.length, "a board is listed under two modes");
    assert.deepEqual([...arranged].sort(), [...geoBoardCats()].sort());
  });

  test("holds nothing that doesn't have a board to draw", () => {
    const withoutBoard = allBoards().filter((b) => {
      const c = [...CATS, ...FLAG_CATS].find((x) => x.name === b.name);
      return !hasGeoBoard(b.name) && !c?.isFlagQuiz && !c?.isBorderQuiz;
    });
    assert.deepEqual(withoutBoard, []);
  });

  test("every mode has at least one board, and none is empty on screen", () => {
    for (const m of MODES) assert.ok(boardsFor(m.key).length > 0, `${m.key} has no boards`);
  });

  // A Borders quiz draws on the same atlas as its "Countries in …" category, so geoMode() calls it
  // "map" too — the quiz flags have to win, or Borders and Flags would both land under the maps.
  test("a borders or flags quiz is classified as itself, not as a map", () => {
    const borders = CATS.find((c) => c.isBorderQuiz);
    const flags = FLAG_CATS[0];
    assert.equal(modeOf(borders), "borders");
    assert.equal(modeOf(flags), "flags");
    assert.equal(modeOf(CATS.find((c) => c.name === "Countries of the World")), "map");
    assert.equal(modeOf(CATS.find((c) => c.name === "World Capitals")), "capitals");
  });

  test("a region is named by its region, not by the mode you got to it through", () => {
    // "Flags of Europe" under the Flags mode should just read "Europe".
    assert.equal(regionLabel("Flags of Europe"), "Europe");
    assert.equal(regionLabel("Borders of Africa"), "Africa");
    assert.equal(regionLabel("Countries in Asia"), "Asia");
    assert.equal(regionLabel("Countries of the World"), "World");
    assert.equal(regionLabel("Countries in the Middle East"), "Middle East");
    assert.equal(regionLabel("US State Capitals"), "United States");
    assert.equal(regionLabel("European Union Members"), "EU members");
  });

  test("no region label comes out empty or still carrying its mode", () => {
    for (const b of allBoards()) {
      assert.ok(b.region.trim().length > 0, `${b.name} has no region label`);
      assert.doesNotMatch(b.region, /^(Flags|Borders|Countries)\b/, `${b.name} → "${b.region}" still reads as the mode`);
    }
  });

  test("the same region appears under more than one mode — that's the point of the split", () => {
    const europe = MODES.map((m) => boardsFor(m.key).find((b) => b.region === "Europe")).filter(Boolean);
    assert.ok(europe.length >= 3, "Europe should be playable as a map, as flags and as borders");
  });

  test("boards are ordered biggest first, so the headline one leads", () => {
    for (const m of MODES) {
      const sizes = boardsFor(m.key).map((b) => b.answers);
      assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a), `${m.key} isn't ordered by size`);
    }
  });

  test("every board carries a real answer count and a real clock", () => {
    for (const b of allBoards()) {
      assert.ok(b.answers > 0, `${b.name} claims ${b.answers} answers`);
      assert.ok(b.seconds > 0, `${b.name} has no recommended time`);
    }
  });
});

// A shared board link carries the board name through a URL and back, and AppShell used to test it
// with `=== "1"` — so every shared board link opened the main menu while the preview card promised
// a specific board.
describe("turning a shared board name back into a board", () => {
  test("finds every board the front door can link to, with its mode", () => {
    for (const b of allBoards()) {
      const hit = findBoard(b.name);
      assert.ok(hit, `${b.name} can't be found by name`);
      assert.equal(hit.mode, b.mode);
    }
  });

  test("matches regardless of case and surrounding space, because a URL round-trip mangles both", () => {
    assert.equal(findBoard("flags of europe").name, "Flags of Europe");
    assert.equal(findBoard("  Flags of Europe  ").name, "Flags of Europe");
    assert.equal(findBoard("FLAGS OF EUROPE").name, "Flags of Europe");
  });

  // "1" is the plain entry point (/?geo=1) and names no board: it has to fall back to the mode
  // list rather than resolve to something arbitrary.
  test("anything that isn't a board is null, including the literal 1", () => {
    for (const v of ["1", "", "   ", "Countries of Narnia", null, undefined, 0, {}, []]) {
      assert.equal(findBoard(v), null, `${JSON.stringify(v)} resolved to a board`);
    }
  });
});
