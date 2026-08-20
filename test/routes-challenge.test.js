"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { createChallengeRouter, challengePreview } = require("../routes/challenge.js");

// analytics.enabled() is false throughout (no TURSO_URL in the test environment), so these
// hit the same "persistence not configured" paths verified manually against the real server —
// they confirm the router is wired up correctly, not the Turso-backed behavior.
function buildApp(isLockdown) {
  const app = express();
  app.use(express.json());
  app.use(createChallengeRouter({ isLockdown }));
  return app;
}

describe("routes/challenge.js", () => {
  test("POST /challenge is blocked during lockdown, before the persistence check", async () => {
    const app = buildApp(() => true);
    const res = await request(app).post("/challenge").send({ rounds: ["Countries of the World"] });
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /maintenance/);
  });

  test("POST /challenge reports missing persistence when not in lockdown", async () => {
    const app = buildApp(() => false);
    const res = await request(app).post("/challenge").send({ rounds: ["Countries of the World"] });
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /persistence/);
  });

  // The result route used to answer ok:true whatever the write did, which made the client's
  // retry-and-keep-it-on-the-device path (hooks/useSolo.js trySaveResult) unreachable for the
  // exact failure it exists for: addChallengeResult returns false on a DB error, it doesn't throw.
  // analytics is a plain module object the router reads properties off, so patching it in place is
  // enough to drive both outcomes.
  describe("POST /challenge/:id/result reports what the write actually did", () => {
    const analytics = require("../server/stats.js");
    function withAnalytics(addChallengeResult, run) {
      const saved = { enabled: analytics.enabled, getChallenge: analytics.getChallenge, addChallengeResult: analytics.addChallengeResult };
      analytics.enabled = () => true;
      analytics.getChallenge = async () => ({ id: "abc", rounds: ["Countries of the World"], timer: 45 });
      analytics.addChallengeResult = addChallengeResult;
      return Promise.resolve(run()).finally(() => Object.assign(analytics, saved));
    }
    const post = (app) => request(app).post("/challenge/abc/result").send({ name: "Jayden", scores: [12], wpms: [40], times: [30] });

    test("a successful insert answers ok", async () => {
      await withAnalytics(async () => true, async () => {
        const res = await post(buildApp(() => false));
        assert.equal(res.body.ok, true);
      });
    });

    test("a failed insert is reported as a failure, not as a saved run", async () => {
      await withAnalytics(async () => false, async () => {
        const res = await post(buildApp(() => false));
        assert.equal(res.body.ok, false);
        assert.match(res.body.error, /save/i);
        assert.equal(res.statusCode, 503);
      });
    });

    test("a write that rejects outright is reported too, not turned into a 500", async () => {
      await withAnalytics(async () => { throw new Error("connection reset"); }, async () => {
        const res = await post(buildApp(() => false));
        assert.equal(res.body.ok, false);
        assert.equal(res.statusCode, 503);
      });
    });
  });

  test("GET /name-check flags a blocked name and passes a clean one, without needing persistence", async () => {
    const app = buildApp(() => false);
    const bad = await request(app).get("/name-check").query({ name: "n1gg4" });
    assert.equal(bad.body.ok, false);
    const good = await request(app).get("/name-check").query({ name: "Jayden" });
    assert.equal(good.body.ok, true);
  });

  test("GET /daily reports missing persistence", async () => {
    const app = buildApp(() => false);
    const res = await request(app).get("/daily");
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /persistence/);
  });

  test("GET /geo-goat and /daily/alltime and /category-leaderboard all no-op without persistence", async () => {
    const app = buildApp(() => false);
    for (const path of ["/geo-goat", "/daily/alltime", "/category-leaderboard?name=Countries%20of%20the%20World"]) {
      const res = await request(app).get(path);
      assert.equal(res.body.ok, false, path);
    }
  });

  test("GET /challenge.html with no ?id renders the static template (crawlers' fallback path)", async () => {
    const app = buildApp(() => false);
    const res = await request(app).get("/challenge.html");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/html/);
    assert.equal(res.headers["cache-control"], "no-cache");
  });
});

// The share-link preview is what a crawler puts in a group chat, and solo's "Quick play" /
// "Pick a category → Play" both build ONE-round challenges — so the singular cases below are the
// ones most links actually hit.
describe("challengePreview (the crawler-facing share copy)", () => {
  test("a one-round challenge says round, not rounds", () => {
    const { desc } = challengePreview({ by: "Jayden", type: "custom", rounds: ["US States"], results: [] });
    assert.match(desc, /^1 round\. /);
  });

  test("a multi-round challenge still says rounds", () => {
    const { desc } = challengePreview({ by: "Jayden", type: "custom", rounds: ["US States", "Countries in Europe"], results: [] });
    assert.match(desc, /^2 rounds\. /);
  });

  test("a genre challenge pluralizes the same way", () => {
    assert.match(challengePreview({ by: "Jayden", type: "genre", genre: "Geography", rounds: ["US States"], results: [] }).desc, /^1 round of Geography\. /);
    assert.match(challengePreview({ by: "Jayden", type: "genre", genre: "Geography", rounds: ["US States", "World Capitals"], results: [] }).desc, /^2 rounds of Geography\. /);
  });

  test("a score of 1 doesn't get glued to a plural category name", () => {
    const { title } = challengePreview({ by: "Jayden", type: "custom", rounds: ["US States"], results: [{ name: "Jayden", scores: [1] }] });
    assert.equal(title, "⚡ Jayden says you can't name more than 1 answer in US States");
  });

  test("a score above 1 reads as a count of the category", () => {
    const { title } = challengePreview({ by: "Jayden", type: "custom", rounds: ["US States"], results: [{ name: "Jayden", scores: [17] }] });
    assert.equal(title, "⚡ Jayden says you can't name more than 17 US States");
  });

  test("with no scores on the board yet it falls back to the plain challenge title", () => {
    const { title } = challengePreview({ by: "A friend", type: "custom", rounds: ["US States"], results: [] });
    assert.equal(title, "⚡ A friend challenged you on Prove It!");
  });

  test("the creator's own best wins over a stranger's higher score", () => {
    const { title } = challengePreview({
      by: "Jayden", type: "custom", rounds: ["US States", "World Capitals"],
      results: [{ name: "sam", scores: [50, 50] }, { name: "jayden", scores: [4, 9] }],
    });
    assert.equal(title, "⚡ Jayden says you can't name more than 9 World Capitals");
  });

  test("missing rounds/results don't throw — a half-written challenge row still renders a preview", () => {
    const { title, desc } = challengePreview({ by: "A friend" });
    assert.equal(title, "⚡ A friend challenged you on Prove It!");
    assert.match(desc, /^0 rounds\. /);
  });
});
