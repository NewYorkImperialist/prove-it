"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const SITE = require("../lib/site-config.js");
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

    test("no database configured is not reported as a failed write", async () => {
      // Otherwise the client's retry loop treats a deployment with no persistence as a network
      // fault: 15s of retrying and then "check your connection" after every single run.
      const res = await post(buildApp(() => false)); // analytics.enabled() is false in this env
      assert.equal(res.body.ok, true);
      assert.equal(res.body.stored, false, "and it says the run wasn't kept, rather than implying it was");
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
    // The defaults, unchanged: with nothing to say about a specific run this is still the static
    // hand-made card and site-config.js's challenge copy.
    assert.ok(res.text.includes(`content="${SITE.challenge.ogTitle}"`), res.text);
    assert.ok(res.text.includes(SITE.ogImage.url), "no share shape means the static card, not a generated one");
    assert.ok(!res.text.includes("{{"), "every token the template uses needs a default in siteVars");
  });
});

// The stub is what a crawler reads and the ONLY thing it reads — there is no bot sniffing here,
// /challenge.html is simply an Express path claimed ahead of the Next catch-all, and the script at
// the bottom of the template bounces real browsers into the app carrying the same query string.
// So every assertion below is about the meta tags: they are the entire product for this route.
describe("GET /challenge.html · the generated share card, per link shape", () => {
  const analytics = require("../server/stats.js");
  // The router reads properties off the analytics module object at call time, so patching it in
  // place is enough to stand in for Turso (analytics.enabled() is false in this environment).
  function withAnalytics(patch, run) {
    const saved = { enabled: analytics.enabled, getChallenge: analytics.getChallenge, getChallengeResults: analytics.getChallengeResults };
    Object.assign(analytics, { enabled: () => true }, patch);
    return Promise.resolve(run()).finally(() => Object.assign(analytics, saved));
  }
  // Extract meta tag values with HTML entity decoding.
  // A card URL has several params, so its ampersands arrive HTML-escaped inside the attribute —
  // which is correct markup and what a crawler unescapes before fetching, but it means new URL()
  // would otherwise read the query as "amp;k=...". Only &amp; is decoded here: the hostile-input
  // test below wants to see the other entities still in place.
  const attr = (html, sel) => ((html.match(new RegExp(`<meta ${sel} content="([^"]*)"`)) || [])[1] || "").replace(/&amp;/g, "&");
  const metaOf = (html, kind, name) => attr(html, `${kind}="${name}"`);

  test("?id= quotes the challenger's real name, best score and category from the database", async () => {
    await withAnalytics({
      getChallenge: async () => ({ id: "abc1234", type: "custom", genre: "", rounds: ["US States", "World Capitals"], by_name: "Jayden", timer: 45 }),
      getChallengeResults: async () => [{ name: "Jayden", scores: [4, 17] }],
    }, async () => {
      const res = await request(buildApp(() => false)).get("/challenge.html?id=abc1234");
      assert.equal(res.status, 200);
      assert.ok(res.text.includes(SITE.ogImage.url), "uses the static card");
      assert.match(metaOf(res.text, "property", "og:image:alt"), /Prove It/);
      assert.match(metaOf(res.text, "property", "og:url"), /\?id=abc1234$/);
    });
  });

  test("a daily ?id= is its own card kind and honours the sharer's ?by=", async () => {
    await withAnalytics({
      getChallenge: async () => ({ id: "d-20260624", type: "daily", genre: "", rounds: ["US States"], by_name: "Daily", timer: 30 }),
      getChallengeResults: async () => [{ name: "Jayden", scores: [9] }],
    }, async () => {
      const res = await request(buildApp(() => false)).get("/challenge.html?id=d-20260624&by=Jayden");
      assert.ok(res.text.includes(SITE.ogImage.url), "uses the static card");
      assert.match(metaOf(res.text, "property", "og:url"), /\?id=d-20260624&by=Jayden$/);
    });
  });

  test("?id= with no database falls back to the defaults rather than inventing a score", async () => {
    const res = await request(buildApp(() => false)).get("/challenge.html?id=abc1234");
    assert.equal(res.status, 200);
    assert.ok(res.text.includes(SITE.ogImage.url), "the static card, because there is no score to quote");
    assert.ok(res.text.includes(`content="${SITE.challenge.ogTitle}"`));
  });

  test("?geo=<board> validates the board name and describes that board", async () => {
    const res = await request(buildApp(() => false)).get("/challenge.html?geo=Countries%20of%20the%20World");
    assert.equal(res.status, 200);
    assert.ok(res.text.includes(SITE.ogImage.url), "uses the static card");
    assert.match(metaOf(res.text, "property", "og:title"), /Can you name all 197 Countries of the World/);
    assert.match(metaOf(res.text, "property", "og:url"), /\?geo=Countries%20of%20the%20World$/);
  });

  test("?geo=1 — the app's own 'open the Geography screen' link — gets the generic geography card", async () => {
    for (const q of ["geo=1", "geo=Atlantis"]) {
      const res = await request(buildApp(() => false)).get(`/challenge.html?${q}`);
      assert.ok(res.text.includes(SITE.ogImage.url), `${q} uses the static card`);
      assert.match(metaOf(res.text, "property", "og:title"), /geography boards/);
    }
  });

  test("?room= normalises the code and renders a multiplayer invite", async () => {
    const res = await request(buildApp(() => false)).get("/challenge.html?room=ab1&by=Jayden");
    assert.ok(res.text.includes(SITE.ogImage.url), "uses the static card");
    assert.match(metaOf(res.text, "property", "og:description"), /Room code AB1/);
  });

  test("every shape fills in the twitter tags and og:url, not just the og: ones", async () => {
    // Twitter falls back to og:title/og:description; Discord's summary_large_image card does not
    // fall back the same way, so a shape that set only the og: pair shipped a preview with the
    // site-wide description under a run-specific title.
    for (const q of ["geo=Flags%20of%20Europe", "room=AB12"]) {
      const res = await request(buildApp(() => false)).get(`/challenge.html?${q}`);
      assert.equal(res.status, 200, q);
      assert.equal(metaOf(res.text, "name", "twitter:title"), metaOf(res.text, "property", "og:title"), q);
      assert.equal(metaOf(res.text, "name", "twitter:description"), metaOf(res.text, "property", "og:description"), q);
      assert.ok(metaOf(res.text, "property", "og:url").startsWith(SITE.url), q);
      assert.ok(metaOf(res.text, "property", "og:image:alt").length > 0, q);
      assert.ok(!res.text.includes("{{"), `${q} left a template token unfilled`);
    }
  });

  test("a crafted ?by= never reaches the HTML raw, in a tag or in the card URL", async () => {
    const hostile = '"><script>alert(1)</script>';
    const res = await request(buildApp(() => false)).get(`/challenge.html?room=AB12&by=${encodeURIComponent(hostile)}`);
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes("<script>alert(1)"), "unescaped angle brackets would close the meta tag");
    assert.ok(!res.text.includes('"><script'), res.text);
    // And the name still shows up, escaped, rather than being silently dropped.
    assert.match(metaOf(res.text, "property", "og:title"), /&quot;&gt;&lt;script&gt;/);
  });

  test("a share link is never cached and never fails: the stub answers 200 with no-cache", async () => {
    for (const q of ["", "id=nope", "geo=1", "room=!!!", "by=Jayden", "geo[]=1&room[]=AB12"]) {
      const res = await request(buildApp(() => false)).get(`/challenge.html?${q}`);
      assert.equal(res.status, 200, q);
      assert.equal(res.headers["cache-control"], "no-cache", q);
    }
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

// A fabricated run reached the top of the live daily board: 999/999/999 for 2997, submitted
// straight to this endpoint with no keystrokes behind it (its WPM columns were empty, which is
// what gave it away). Three things were wrong, and all three are covered here.
describe("POST /challenge/:id/result — what an unauthenticated write may do", () => {
  const analytics = require("../server/stats.js");
  // Each test gets its own caller IP so the per-IP limiter doesn't leak between them — and so the
  // limiter test below can pin one IP deliberately.
  const post = (app, ip, body) => request(app).post("/challenge/d-20260820/result").set("fly-client-ip", ip).send(body);

  function withChallenge(rounds, run) {
    const saved = { enabled: analytics.enabled, getChallenge: analytics.getChallenge, addChallengeResult: analytics.addChallengeResult };
    const written = [];
    analytics.enabled = () => true;
    analytics.getChallenge = async () => ({ id: "d-20260820", rounds, timer: 30 });
    analytics.addChallengeResult = async (row) => { written.push(row); return true; };
    return Promise.resolve(run(written)).finally(() => Object.assign(analytics, saved));
  }

  test("a score can't exceed the number of answers its category actually has", async () => {
    // The old cap was a flat 999 for every category, so this is exactly the payload that put
    // 999/999/999 on the board. "Countries of the World" has 197 answers; "US States" has 50.
    await withChallenge(["Countries of the World", "US States"], async (written) => {
      const res = await post(buildApp(() => false), "1.1.1.1", { name: "THE ONE ABOVE ALL", scores: [999, 999] });
      assert.equal(res.body.ok, true);
      assert.deepEqual(written[0].scores, [197, 50], "each round capped to its own category, not a shared ceiling");
      assert.equal(written[0].total, 247);
    });
  });

  test("a legitimate score passes through untouched", async () => {
    await withChallenge(["Countries of the World", "US States"], async (written) => {
      await post(buildApp(() => false), "1.1.1.2", { name: "mark", scores: [8, 14] });
      assert.deepEqual(written[0].scores, [8, 14]);
    });
  });

  test("each score is capped against its OWN round, even on an over-long payload", async () => {
    // Mapping before slicing capped score[i] against the wrong category once the payload ran
    // longer than the challenge — a way to smuggle a big number into a small board.
    await withChallenge(["US States"], async (written) => {
      await post(buildApp(() => false), "1.1.1.3", { name: "x", scores: [999, 999, 999] });
      assert.deepEqual(written[0].scores, [50], "only the real round survives, capped to its own size");
    });
  });

  test("an unknown category keeps a ceiling rather than becoming unbounded", async () => {
    await withChallenge(["A Category That No Longer Exists"], async (written) => {
      await post(buildApp(() => false), "1.1.1.4", { name: "x", scores: [999999] });
      assert.equal(written[0].scores[0], 999);
    });
  });

  test("maintenance mode blocks the write, not just new games", async () => {
    // The kill-switch was checked on POST /challenge alone, so flipping it during an incident
    // closed every room, announced "the game is down", and left this endpoint wide open.
    await withChallenge(["US States"], async (written) => {
      const res = await post(buildApp(() => true), "1.1.1.5", { name: "x", scores: [10] });
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.ok, false);
      assert.equal(written.length, 0, "nothing may reach the database while the game is down");
    });
  });

  test("one IP can't hammer the endpoint indefinitely", async () => {
    await withChallenge(["US States"], async (written) => {
      const app = buildApp(() => false);
      let limited = 0;
      for (let i = 0; i < 26; i++) {
        const res = await post(app, "9.9.9.9", { name: "flood", scores: [1] });
        if (res.statusCode === 429) limited++;
      }
      assert.ok(limited > 0, "the limiter never engaged");
      assert.ok(written.length <= 20, `wrote ${written.length} rows past the limit`);
      // A different caller is unaffected — the limit is per IP, not global.
      const other = await post(app, "9.9.9.10", { name: "innocent", scores: [3] });
      assert.equal(other.body.ok, true);
    });
  });
});
