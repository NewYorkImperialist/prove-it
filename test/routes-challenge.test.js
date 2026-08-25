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
      const res = await post(buildApp(() => false), "1.1.1.1", { name: "THE ONE ABOVE ALL", scores: [999, 999], wpms: [300, 300] });
      assert.equal(res.body.ok, true);
      // Three ceilings apply, and the tightest wins per round. 300 wpm is reported here so the
      // typing ceiling is not the binding one — it has its own tests below. These are 30-second rounds, so
      // "Countries of the World" (197 answers) is bounded by the clock at 90, while "US States"
      // (50 answers) is bounded by its own size because 50 is already under 90.
      assert.deepEqual(written[0].scores, [90, 50], "each round capped by its own category and its own clock");
      assert.equal(written[0].total, 140);
    });
  });

  test("a legitimate score passes through untouched", async () => {
    await withChallenge(["Countries of the World", "US States"], async (written) => {
      await post(buildApp(() => false), "1.1.1.2", { name: "mark", scores: [8, 14], wpms: [40, 45] });
      assert.deepEqual(written[0].scores, [8, 14]);
    });
  });

  test("each score is capped against its OWN round, even on an over-long payload", async () => {
    // Mapping before slicing capped score[i] against the wrong category once the payload ran
    // longer than the challenge — a way to smuggle a big number into a small board.
    await withChallenge(["US States"], async (written) => {
      await post(buildApp(() => false), "1.1.1.3", { name: "x", scores: [999, 999, 999], wpms: [300, 300, 300] });
      assert.deepEqual(written[0].scores, [50], "only the real round survives, capped to its own size");
    });
  });

  test("an unknown category keeps a ceiling rather than becoming unbounded", async () => {
    // A category retired since the challenge was created has no size to check against — but the
    // round still had a clock, so the pace ceiling covers it. 30 seconds allows 90.
    await withChallenge(["A Category That No Longer Exists"], async (written) => {
      await post(buildApp(() => false), "1.1.1.4", { name: "x", scores: [999999], wpms: [300] });
      assert.equal(written[0].scores[0], 90);
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

// POST /challenge/rename used to accept a `visitorId` and nothing else. Every public leaderboard
// response publishes `visitor_id` for every row, so anyone could read a board, take a stranger's
// id, and rewrite every entry that person had ever made — including the owner's. The id says
// *whose* rows these are; it was never evidence of *being* them.
describe("POST /challenge/rename — proving the rows are yours", () => {
  const analytics = require("../server/stats.js");
  const post = (app, ip, body) => request(app).post("/challenge/rename").set("fly-client-ip", ip).send(body);

  // gidOwnedBy is the real check; stub it to say which (gid, visitor) pairs exist.
  function withOwnership(pairs, run) {
    const saved = { enabled: analytics.enabled, gidOwnedBy: analytics.gidOwnedBy, renameResults: analytics.renameResults };
    const renamed = [];
    analytics.enabled = () => true;
    analytics.gidOwnedBy = async (gid, visitorId) => pairs.some(([g, v]) => g === gid && v === visitorId);
    analytics.renameResults = async (args) => { renamed.push(args); return 3; };
    return Promise.resolve(run(renamed)).finally(() => Object.assign(analytics, saved));
  }

  test("a stranger's visitor id alone changes nothing", async () => {
    // This is the exact shape of the hole: victim's id harvested from a public board, no gid.
    await withOwnership([["my-gid", "my-visitor"]], async (renamed) => {
      const res = await post(buildApp(() => false), "2.2.2.1", { name: "pwned", visitorId: "victim-visitor" });
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.ok, false);
      assert.equal(renamed.length, 0, "no rename may reach the database");
    });
  });

  test("a stranger's visitor id plus someone else's gid still changes nothing", async () => {
    // A gid alone isn't enough either — it has to belong to the visitor being renamed.
    await withOwnership([["my-gid", "my-visitor"]], async (renamed) => {
      const res = await post(buildApp(() => false), "2.2.2.2", { name: "pwned", visitorId: "victim-visitor", gid: "my-gid" });
      assert.equal(res.statusCode, 403);
      assert.equal(renamed.length, 0);
    });
  });

  test("your own run id renames your own rows", async () => {
    await withOwnership([["my-gid", "my-visitor"]], async (renamed) => {
      const res = await post(buildApp(() => false), "2.2.2.3", { name: "Ada", visitorId: "my-visitor", gid: "my-gid" });
      assert.equal(res.body.ok, true);
      assert.equal(res.body.updated, 3);
      assert.equal(renamed.length, 1);
      // The gid only authorises — the rename still covers every row this visitor owns, so a player
      // whose older rows predate gids only needs one recent run to fix all of them.
      assert.equal(renamed[0].visitorId, "my-visitor");
      assert.equal(renamed[0].name, "Ada");
    });
  });

  test("the owner key stands on its own, with no run id", async () => {
    const realKey = process.env.OWNER_KEY;
    process.env.OWNER_KEY = "test-owner-key";
    try {
      await withOwnership([], async (renamed) => {
        const res = await post(buildApp(() => false), "2.2.2.4", { name: "Jayden", ownerKey: "test-owner-key" });
        assert.equal(res.body.ok, true);
        assert.equal(renamed[0].crownAll, true);
      });
    } finally { process.env.OWNER_KEY = realKey; }
  });

  test("a wrong owner key gets no crown privileges and still needs to prove ownership", async () => {
    const realKey = process.env.OWNER_KEY;
    process.env.OWNER_KEY = "test-owner-key";
    try {
      await withOwnership([["my-gid", "my-visitor"]], async (renamed) => {
        const res = await post(buildApp(() => false), "2.2.2.5", { name: "x", visitorId: "victim", ownerKey: "guess" });
        assert.equal(res.statusCode, 403);
        assert.equal(renamed.length, 0);
      });
    } finally { process.env.OWNER_KEY = realKey; }
  });

  test("maintenance mode blocks renames too", async () => {
    await withOwnership([["my-gid", "my-visitor"]], async (renamed) => {
      const res = await post(buildApp(() => true), "2.2.2.6", { name: "Ada", visitorId: "my-visitor", gid: "my-gid" });
      assert.equal(res.statusCode, 503);
      assert.equal(renamed.length, 0);
    });
  });

  test("a database error while checking ownership refuses the rename rather than allowing it", async () => {
    // Fail closed: a thrown lookup must not be read as "ownership proved".
    const saved = { enabled: analytics.enabled, gidOwnedBy: analytics.gidOwnedBy, renameResults: analytics.renameResults };
    const renamed = [];
    analytics.enabled = () => true;
    analytics.gidOwnedBy = async () => { throw new Error("connection reset"); };
    analytics.renameResults = async (a) => { renamed.push(a); return 1; };
    try {
      const res = await post(buildApp(() => false), "2.2.2.7", { name: "x", visitorId: "v", gid: "g" });
      assert.equal(res.statusCode, 403);
      assert.equal(renamed.length, 0);
    } finally { Object.assign(analytics, saved); }
  });
});

// A score has to clear two independent ceilings: the category's real answer count, and what a
// human could physically type in the time the round allowed. The size cap alone still let 197
// answers through on a 30-second round — absurd, but within the category.
describe("POST /challenge/:id/result — the pace ceiling", () => {
  const analytics = require("../server/stats.js");
  const post = (app, ip, body) => request(app).post("/challenge/d-1/result").set("fly-client-ip", ip).send(body);

  function withChallenge(challenge, run) {
    const saved = { enabled: analytics.enabled, getChallenge: analytics.getChallenge, addChallengeResult: analytics.addChallengeResult };
    const written = [];
    analytics.enabled = () => true;
    analytics.getChallenge = async () => challenge;
    analytics.addChallengeResult = async (row) => { written.push(row); return true; };
    return Promise.resolve(run(written)).finally(() => Object.assign(analytics, saved));
  }

  test("a 30-second round caps well below the category's size", async () => {
    // "Countries of the World" has 197 answers, but 197 of them in 30 seconds is 6.5 per second.
    // 3/s is the generous ceiling, so 90.
    await withChallenge({ id: "d-1", rounds: ["Countries of the World"], timer: 30 }, async (written) => {
      await post(buildApp(() => false), "3.3.3.1", { name: "x", scores: [999], wpms: [300] });
      assert.equal(written[0].scores[0], 90);
    });
  });

  test("a small category is still bounded by its size, not by the clock", async () => {
    // US States has 50 answers and a 30s round allows 90 — so the size is the tighter ceiling and
    // must win. Whichever is smaller applies.
    await withChallenge({ id: "d-1", rounds: ["US States"], timer: 30 }, async (written) => {
      await post(buildApp(() => false), "3.3.3.2", { name: "x", scores: [999], wpms: [300] });
      assert.equal(written[0].scores[0], 50);
    });
  });

  test("a full-length run can still reach every answer in the category", async () => {
    // The point of the ceilings is that none of them punishes a real player: given the category's
    // own recommended 15 minutes and a real 90 wpm, a perfect 197 must go through untouched.
    await withChallenge({ id: "d-1", rounds: ["Countries of the World"], timer: 900 }, async (written) => {
      await post(buildApp(() => false), "3.3.3.3", { name: "x", scores: [197], wpms: [90] });
      assert.equal(written[0].scores[0], 197);
    });
  });

  test("timer:0 means 'recommended per round', and the recommended time is used", async () => {
    // A challenge created with timer:0 has no single length on the row; the category's own
    // recommended time is the honest figure, and it comes from the server's table either way.
    await withChallenge({ id: "d-1", rounds: ["Countries of the World"], timer: 0 }, async (written) => {
      await post(buildApp(() => false), "3.3.3.4", { name: "x", scores: [999], wpms: [300] });
      assert.equal(written[0].scores[0], 197, "recommended 900s allows the whole category");
    });
  });

  test("a genuine daily score is nowhere near either ceiling", async () => {
    // The best real daily score on this leaderboard is 45. Nothing here may touch that.
    await withChallenge({ id: "d-1", rounds: ["Countries of the World", "US States"], timer: 30 }, async (written) => {
      await post(buildApp(() => false), "3.3.3.5", { name: "mark", scores: [8, 14], wpms: [40, 45] });
      assert.deepEqual(written[0].scores, [8, 14]);
      assert.equal(written[0].total, 22);
    });
  });
});

// Every write in routes/challenge.js is unauthenticated by design; before this only the result
// endpoint had any ceiling on volume. With a shell the others were unbounded row creation, and the
// cost guard watches egress rather than row count so it would never have noticed.
describe("routes/challenge.js — every unauthenticated write is bounded", () => {
  test("challenge creation is limited per IP", async () => {
    const app = buildApp(() => false);
    let refused = 0;
    for (let i = 0; i < 26; i++) {
      const res = await request(app).post("/challenge").set("fly-client-ip", "4.4.4.1")
        .send({ rounds: ["Countries of the World"] });
      if (/Too many challenges/.test(res.body.error || "")) refused++;
    }
    assert.ok(refused > 0, "creation never got limited");
  });

  test("the guess log is limited per IP", async () => {
    const app = buildApp(() => false);
    // analytics is off in this environment so these all answer ok:false; what matters is that the
    // limiter is reached at all, which the bucket state proves by refusing a fresh caller later.
    for (let i = 0; i < 61; i++) {
      await request(app).post("/challenge/abc/guesses").set("fly-client-ip", "4.4.4.2").send({ gid: "g", guesses: [] });
    }
    const after = await request(app).post("/challenge/abc/guesses").set("fly-client-ip", "4.4.4.2").send({ gid: "g", guesses: [] });
    assert.equal(after.body.ok, false);
  });

  test("one flooding IP can't lock a different player out of saving their run", async () => {
    // Separate buckets per endpoint AND per IP: a flood must never turn into an outage for someone
    // else, which a single shared counter would have done.
    const app = buildApp(() => false);
    for (let i = 0; i < 30; i++) {
      await request(app).post("/challenge").set("fly-client-ip", "4.4.4.3").send({ rounds: ["US States"] });
    }
    const victim = await request(app).post("/challenge/abc/result").set("fly-client-ip", "4.4.4.4")
      .send({ name: "innocent", scores: [5] });
    assert.notEqual(victim.statusCode, 429);
  });
});

// Boards used to hand every row's real visitor_id to every client, and /challenge/rename accepted
// that same value as proof of ownership — so reading a public board was enough to learn the
// identifier needed to rewrite a stranger's entries. The id is no longer published at all.
describe("the boards don't publish anyone's identity", () => {
  const analytics = require("../server/stats.js");
  const rows = [
    { name: "Ada", visitor_id: "vid-ada", total: 30, scores: [30], crown: 0 },
    { name: "Me", visitor_id: "vid-me", total: 20, scores: [20], crown: 0 },
    { name: "Bob", visitor_id: "vid-bob", total: 10, scores: [10], crown: 0 },
  ];
  function withBoards(run) {
    const saved = { enabled: analytics.enabled, getChallenge: analytics.getChallenge,
      getChallengeResults: analytics.getChallengeResults, getCreatorName: analytics.getCreatorName,
      categoryLeaderboard: analytics.categoryLeaderboard, dailyAllTime: analytics.dailyAllTime, geoGoat: analytics.geoGoat };
    Object.assign(analytics, {
      enabled: () => true,
      getChallenge: async () => ({ id: "abc", rounds: ["US States"], timer: 30 }),
      getChallengeResults: async () => rows,
      getCreatorName: async () => null,
      categoryLeaderboard: async () => rows,
      dailyAllTime: async () => rows,
      geoGoat: async () => rows,
    });
    return Promise.resolve(run()).finally(() => Object.assign(analytics, saved));
  }
  const PATHS = ["/challenge/abc/results", "/category-leaderboard?name=US%20States", "/daily/alltime", "/geo-goat"];

  test("no board response contains a visitor id, anywhere", async () => {
    await withBoards(async () => {
      for (const p of PATHS) {
        const res = await request(buildApp(() => false)).get(p + (p.includes("?") ? "&" : "?") + "me=vid-me");
        assert.equal(res.status, 200, p);
        assert.equal(res.text.includes("visitor_id"), false, `${p} still publishes the field name`);
        for (const vid of ["vid-ada", "vid-me", "vid-bob"]) {
          assert.equal(res.text.includes(vid), false, `${p} still publishes ${vid}`);
        }
      }
    });
  });

  test("the caller still learns which row is theirs", async () => {
    await withBoards(async () => {
      const res = await request(buildApp(() => false)).get("/daily/alltime?me=vid-me");
      const mine = res.body.results.filter((r) => r.mine);
      assert.equal(mine.length, 1);
      assert.equal(mine[0].name, "Me");
    });
  });

  test("claiming someone else's id only moves the (you) marker on your own screen", async () => {
    // `me` is a display hint, never authorisation — worth pinning so it stays that way.
    await withBoards(async () => {
      const res = await request(buildApp(() => false)).get("/daily/alltime?me=vid-ada");
      assert.equal(res.body.results.find((r) => r.mine).name, "Ada");
      assert.equal(res.text.includes("vid-ada"), false, "and still without echoing the id back");
    });
  });

  test("rows keep a per-response key so one player's runs still collapse to their best", async () => {
    await withBoards(async () => {
      const res = await request(buildApp(() => false)).get("/daily/alltime?me=vid-me");
      const keys = res.body.results.map((r) => r.vkey);
      assert.equal(new Set(keys).size, 3, "three players, three distinct keys");
      for (const k of keys) assert.match(k, /^v\d+$/, "an ordinal, not the real id");
    });
  });

  test("no caller id at all is fine — nothing is marked as yours", async () => {
    await withBoards(async () => {
      const res = await request(buildApp(() => false)).get("/geo-goat");
      assert.equal(res.status, 200);
      assert.equal(res.body.results.some((r) => r.mine), false);
    });
  });
});

// The third ceiling, added after a friend of the owner demonstrated the previous two being
// insufficient with one shell command:
//
//   http POST …/challenge/d-20260820/result scores:='[999,999,999]' wpms:='[0,0,0]' times:='[]'
//
// The size and pace caps clamped that to 49/62/51 — a PERFECT clear of all three of that day's
// categories, total 162, against a real best-ever daily of 45. Both ceilings did exactly what they
// were written to do; the problem is that "answers per second" is not something a payload can be
// checked against. Characters are: the same payload reported typing nothing at all.
describe("POST /challenge/:id/result — the typing ceiling", () => {
  const analytics = require("../server/stats.js");
  const post = (app, ip, body) => request(app).post("/challenge/d-1/result").set("fly-client-ip", ip).send(body);

  function withChallenge(challenge, run) {
    const saved = { enabled: analytics.enabled, getChallenge: analytics.getChallenge, addChallengeResult: analytics.addChallengeResult };
    const written = [];
    analytics.enabled = () => true;
    analytics.getChallenge = async () => challenge;
    analytics.addChallengeResult = async (row) => { written.push(row); return true; };
    return Promise.resolve(run(written)).finally(() => Object.assign(analytics, saved));
  }
  // The real d-20260820 rounds, which is what the reported command targeted.
  const THE_DAILY = { id: "d-1", rounds: ["European Soccer Clubs", "Musical Instruments", "Greek Gods"], timer: 30 };

  test("the reported attack no longer buys a perfect clear", async () => {
    await withChallenge(THE_DAILY, async (written) => {
      await post(buildApp(() => false), "4.4.4.1", { name: "THE INEVITABLE", scores: [999, 999, 999], wpms: [0, 0, 0], times: [] });
      // Was 49/62/51 = 162. Zero reported typing accounts for no answers, so all that survives is
      // the allowance that exists to protect real under-reported rounds.
      assert.deepEqual(written[0].scores, [6, 6, 6]);
      assert.ok(written[0].total < 45, `total ${written[0].total} must fall below the real best-ever daily of 45`);
    });
  });

  test("omitting wpms entirely is treated as claiming no typing, not as claiming exemption", async () => {
    // Otherwise the fix is one deleted field away from being bypassed. Both real submission paths
    // (hooks/useSolo.js and lib/browser/daily.js) always send a wpm per completed round.
    await withChallenge(THE_DAILY, async (written) => {
      await post(buildApp(() => false), "4.4.4.2", { name: "x", scores: [999, 999, 999] });
      assert.deepEqual(written[0].scores, [6, 6, 6]);
    });
  });

  test("a wpm past what anyone sustains is clamped before it can raise anything", async () => {
    // wpms used to be capped at 9999, so "I typed at 9999 wpm" was a free pass through this check.
    await withChallenge(THE_DAILY, async (written) => {
      await post(buildApp(() => false), "4.4.4.3", { name: "x", scores: [999, 999, 999], wpms: [99999, 99999, 99999] });
      assert.deepEqual(written[0].wpms, [300, 300, 300], "stored at the human ceiling, not as claimed");
      // 300 wpm for 30s is 750 characters, which genuinely could type a whole small category —
      // this check bounds the arithmetic, it does not pretend to detect a consistent lie.
      assert.deepEqual(written[0].scores, [49, 62, 51]);
    });
  });

  test("a claimed-plausible speed still can't clear a category it couldn't have typed", async () => {
    // 60 wpm is 150 characters in 30 seconds. European Soccer Clubs answers are 6+ characters at
    // the 10th percentile, so 49 of them was never typeable at that speed.
    await withChallenge(THE_DAILY, async (written) => {
      await post(buildApp(() => false), "4.4.4.4", { name: "x", scores: [999, 999, 999], wpms: [60, 60, 60] });
      assert.ok(written[0].scores[0] < 49, `${written[0].scores[0]} must be under the category's 49`);
      assert.ok(written[0].total < 162, `total ${written[0].total} must be under the old 162`);
    });
  });

  test("a real good run is untouched", async () => {
    // The property that matters most: a false rejection costs a real player their run.
    await withChallenge(THE_DAILY, async (written) => {
      await post(buildApp(() => false), "4.4.4.5", { name: "mark", scores: [15, 15, 15], wpms: [45, 45, 45] });
      assert.deepEqual(written[0].scores, [15, 15, 15]);
      assert.equal(written[0].total, 45, "exactly the real best-ever daily, and it survives intact");
    });
  });

  test("an elite run is untouched too", async () => {
    await withChallenge(THE_DAILY, async (written) => {
      await post(buildApp(() => false), "4.4.4.6", { name: "fast", scores: [25, 30, 28], wpms: [95, 95, 95] });
      assert.deepEqual(written[0].scores, [25, 30, 28]);
    });
  });

  test("a small real round whose typing was never sampled still counts", async () => {
    // liveWpm() returns 0 for a round it never saw a keystroke in, and the answer box is cleared
    // programmatically so it loses roughly the first character of every answer. A player who named
    // two things must not be zeroed for that.
    await withChallenge(THE_DAILY, async (written) => {
      await post(buildApp(() => false), "4.4.4.7", { name: "quiet", scores: [2, 1, 3], wpms: [0, 0, 0] });
      assert.deepEqual(written[0].scores, [2, 1, 3]);
    });
  });

  test("a genuine full clear of a long board is still reachable", async () => {
    // 197 countries over the recommended 15 minutes at 90 wpm: 6750 characters against a 5-character
    // 10th percentile. No ceiling may touch it.
    await withChallenge({ id: "d-1", rounds: ["Countries of the World"], timer: 900 }, async (written) => {
      await post(buildApp(() => false), "4.4.4.8", { name: "x", scores: [197], wpms: [90] });
      assert.equal(written[0].scores[0], 197);
    });
  });

  test("the ceiling is derived per category, not from one global number", async () => {
    // Greek Gods answers are shorter than European Soccer Clubs answers, so the same reported speed
    // has to allow more of them. A flat divisor would make one category unfair or the other useless.
    await withChallenge({ id: "d-1", rounds: ["European Soccer Clubs", "Greek Gods"], timer: 30 }, async (written) => {
      await post(buildApp(() => false), "4.4.4.9", { name: "x", scores: [999, 999], wpms: [60, 60] });
      assert.ok(written[0].scores[1] > written[0].scores[0],
        `shorter answers should permit more of them: got ${JSON.stringify(written[0].scores)}`);
    });
  });

  test("a category with no item list of its own keeps a ceiling rather than becoming unbounded", async () => {
    await withChallenge({ id: "d-1", rounds: ["A Category That No Longer Exists"], timer: 30 }, async (written) => {
      await post(buildApp(() => false), "4.4.4.10", { name: "x", scores: [999999], wpms: [0] });
      assert.equal(written[0].scores[0], 6);
    });
  });
});
