"use strict";
// The small shared helpers the client renders from: emoji shortcodes, clock formatting, the
// geography board lookup, and the /name-check pre-check (lib/browser/api.js is an ES module, so
// it comes in through a dynamic import).
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { emojify, EMOJI } = require("../lib/emoji.js");
const { fmtClock, fmtTime, dayFromChallengeId, prevDate } = require("../lib/format.js");
const { geoMode, hasGeoBoard } = require("../lib/geo-cats.js");

describe("emojify", () => {
  test("replaces known shortcodes", () => {
    assert.equal(emojify("nice :fire: run"), "nice 🔥 run");
  });
  test("is case-insensitive and handles several in one message", () => {
    assert.equal(emojify(":SKULL::100:"), "💀💯");
  });
  test("leaves unknown shortcodes exactly as typed", () => {
    assert.equal(emojify("what :notanemoji: is that"), "what :notanemoji: is that");
  });
  test("leaves a half-typed shortcode alone", () => {
    assert.equal(emojify("hold on :fir"), "hold on :fir");
  });
  test("every mapping is a non-empty string", () => {
    for (const [code, glyph] of Object.entries(EMOJI)) {
      assert.equal(typeof glyph, "string", code);
      assert.ok(glyph.length > 0, code);
    }
  });
});

describe("fmtClock", () => {
  test("under a minute shows bare seconds", () => {
    assert.equal(fmtClock(45), "45");
    assert.equal(fmtClock(0), "0");
  });
  test("a minute or more shows m:ss with a padded seconds field", () => {
    assert.equal(fmtClock(60), "1:00");
    assert.equal(fmtClock(605), "10:05");
    assert.equal(fmtClock(900), "15:00");
  });
});

describe("fmtTime", () => {
  test("a run that never cleared the board shows an em dash", () => {
    assert.equal(fmtTime(null), "—");
  });
  test("otherwise it reads like a clock", () => {
    assert.equal(fmtTime(42), "42s");
    assert.equal(fmtTime(125), "2:05");
  });
});

describe("dayFromChallengeId", () => {
  test("turns a daily id back into its date", () => {
    assert.equal(dayFromChallengeId("d-20260624"), "2026-06-24");
  });
  test("leaves a normal challenge id alone", () => {
    assert.equal(dayFromChallengeId("a1b2c3d"), "a1b2c3d");
  });
});

describe("prevDate", () => {
  test("steps back one day", () => {
    assert.equal(prevDate("2026-06-24"), "2026-06-23");
  });
  test("crosses a month boundary", () => {
    assert.equal(prevDate("2026-07-01"), "2026-06-30");
  });
  test("crosses a leap day", () => {
    assert.equal(prevDate("2024-03-01"), "2024-02-29");
  });
});

describe("geography boards", () => {
  test("world and US shape categories get a map", () => {
    assert.equal(geoMode("Countries of the World"), "map");
    assert.equal(geoMode("US States"), "map");
  });
  test("the capitals categories get a fill-in grid", () => {
    assert.equal(geoMode("World Capitals"), "fill");
    assert.equal(geoMode("US State Capitals"), "fill");
  });
  test("Borders quizzes get the same big map as their Countries counterpart", () => {
    assert.equal(geoMode("Borders of the World"), "map");
    assert.equal(geoMode("Borders of Oceania"), "map");
  });
  test("everything else gets no board", () => {
    assert.equal(geoMode("Natural Disasters"), null);
    assert.equal(hasGeoBoard("Car Brands"), false);
    assert.equal(hasGeoBoard("Flags of the World"), false); // Flags stay their own grid, not the map
  });
});

describe("isNameBlocked", () => {
  // /name-check answers { ok: true } for an allowed name and { ok: false } for a blocked one.
  const withFetch = async (impl, fn) => {
    const real = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const { isNameBlocked } = await import("../lib/browser/api.js");
      return await fn(isNameBlocked);
    } finally {
      globalThis.fetch = real;
    }
  };
  const json = (body) => async () => ({ json: async () => body });

  test("a name the server rejects is blocked", async () => {
    await withFetch(json({ ok: false }), async (isNameBlocked) => {
      assert.equal(await isNameBlocked("something vile"), true);
    });
  });
  test("a name the server allows is not blocked", async () => {
    await withFetch(json({ ok: true }), async (isNameBlocked) => {
      assert.equal(await isNameBlocked("Jayden"), false);
    });
  });
  test("fails OPEN when the request itself fails — a hiccup must not reject a clean name", async () => {
    await withFetch(async () => { throw new Error("offline"); }, async (isNameBlocked) => {
      assert.equal(await isNameBlocked("Jayden"), false);
    });
  });
  test("fails open on a non-JSON response too (a proxy error page, say)", async () => {
    await withFetch(async () => ({ json: async () => { throw new Error("not json"); } }), async (isNameBlocked) => {
      assert.equal(await isNameBlocked("Jayden"), false);
    });
  });
  test("sends the name url-encoded", async () => {
    let seen = null;
    await withFetch(async (url) => { seen = url; return { json: async () => ({ ok: true }) }; }, async (isNameBlocked) => {
      await isNameBlocked("Ann & Bob");
      assert.equal(seen, "/name-check?name=Ann%20%26%20Bob");
    });
  });
});
