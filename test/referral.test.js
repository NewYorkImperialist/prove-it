"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { sourceOf, safeReferrer, MAX_LABEL, MAX_REFERRER } = require("../lib/referral.js");

const SITE = "https://prove-it.fly.dev/";

describe("sourceOf — known channels", () => {
  test("folds every Reddit form into one channel", () => {
    for (const r of ["https://reddit.com/r/x", "https://www.reddit.com/r/x", "https://old.reddit.com/r/x",
      "https://m.reddit.com/r/x", "https://np.reddit.com/r/x", "https://out.reddit.com/", "https://redd.it/abc123"]) {
      assert.equal(sourceOf({ referrer: r, landing: SITE }), "reddit", r);
    }
  });

  test("x.com, twitter.com and the t.co wrapper are all one channel", () => {
    for (const r of ["https://x.com/someone/status/1", "https://www.x.com/", "https://twitter.com/someone",
      "https://mobile.twitter.com/", "https://t.co/AbCdEf"]) {
      assert.equal(sourceOf({ referrer: r, landing: SITE }), "twitter", r);
    }
  });

  test("the rest of the hardcoded social/chat hosts, bare and prefixed", () => {
    const expected = {
      "https://discord.com/channels/1/2": "discord",
      "https://ptb.discord.com/": "discord",
      "https://discord.gg/invite": "discord",
      "https://discordapp.com/": "discord",
      "https://facebook.com/": "facebook",
      "https://www.facebook.com/": "facebook",
      "https://m.facebook.com/": "facebook",
      "https://l.facebook.com/l.php": "facebook",
      "https://fb.me/x": "facebook",
      "https://instagram.com/p/x": "instagram",
      "https://l.instagram.com/": "instagram",
      "https://www.tiktok.com/@x": "tiktok",
      "https://vm.tiktok.com/x": "tiktok",
      "https://youtube.com/watch?v=x": "youtube",
      "https://m.youtube.com/watch?v=x": "youtube",
      "https://youtu.be/x": "youtube",
      "https://news.ycombinator.com/item?id=1": "hackernews",
      "https://www.linkedin.com/feed/": "linkedin",
      "https://lnkd.in/x": "linkedin",
      "https://web.whatsapp.com/": "whatsapp",
      "https://wa.me/1555": "whatsapp",
      "https://t.me/somechannel": "telegram",
      "https://web.telegram.org/k/": "telegram",
      "https://bsky.app/profile/x": "bluesky",
      "https://github.com/owner/repo": "github",
    };
    for (const [ref, channel] of Object.entries(expected)) assert.equal(sourceOf({ referrer: ref, landing: SITE }), channel, ref);
  });

  test("every search engine collapses to one 'search' bucket, including Google's country domains", () => {
    for (const r of ["https://www.google.com/", "https://google.com/search?q=prove+it", "https://google.co.uk/",
      "https://www.google.com.br/", "https://www.bing.com/", "https://duckduckgo.com/", "https://search.brave.com/",
      "https://search.yahoo.com/", "https://startpage.com/"]) {
      assert.equal(sourceOf({ referrer: r, landing: SITE }), "search", r);
    }
  });

  test("Gmail is email and Gemini is ai-chat, even though both sit under google.com", () => {
    assert.equal(sourceOf({ referrer: "https://mail.google.com/mail/u/0/", landing: SITE }), "email");
    assert.equal(sourceOf({ referrer: "https://gemini.google.com/app", landing: SITE }), "ai-chat");
    assert.equal(sourceOf({ referrer: "https://chatgpt.com/c/1", landing: SITE }), "ai-chat");
    assert.equal(sourceOf({ referrer: "https://claude.ai/chat/1", landing: SITE }), "ai-chat");
  });
});

describe("sourceOf — campaign params", () => {
  test("a campaign param beats the referrer header", () => {
    // The header says Reddit, but the link itself was tagged as a Discord share — the tag is the
    // deliberate signal, so it wins.
    assert.equal(sourceOf({ referrer: "https://old.reddit.com/r/x", landing: "https://prove-it.fly.dev/?utm_source=discord" }), "discord");
  });

  test("precedence is utm_source, then ref, then src", () => {
    assert.equal(sourceOf({ landing: "https://prove-it.fly.dev/?utm_source=a&ref=b&src=c" }), "a");
    assert.equal(sourceOf({ landing: "https://prove-it.fly.dev/?ref=b&src=c" }), "b");
    assert.equal(sourceOf({ landing: "https://prove-it.fly.dev/?src=c" }), "c");
  });

  test("a bare query string works as the landing value, not just a full URL", () => {
    // The client is free to send only location.search; a leading "?" is what makes it a query
    // string rather than a path, exactly as the browser hands it over.
    assert.equal(sourceOf({ landing: "?utm_source=poster" }), "poster");
    assert.equal(sourceOf({ landing: "/?utm_source=poster" }), "poster");
  });

  test("tags are slugified: lowercased, separators collapsed, junk characters replaced", () => {
    assert.equal(sourceOf({ landing: "?utm_source=Reddit%20Post" }), "reddit-post");
    assert.equal(sourceOf({ landing: "?ref=My%20%20Cool%2FTag" }), "my-cool-tag");
    assert.equal(sourceOf({ landing: "?ref=-trimmed-" }), "trimmed");
  });

  test("an empty or junk-only tag falls through to the referrer instead of returning nothing", () => {
    assert.equal(sourceOf({ referrer: "https://reddit.com/", landing: "?utm_source=" }), "reddit");
    assert.equal(sourceOf({ referrer: "https://reddit.com/", landing: "?utm_source=%20%20" }), "reddit");
    assert.equal(sourceOf({ referrer: "https://reddit.com/", landing: "?utm_source=%00" }), "reddit");
  });

  test("an oversized tag is clamped rather than rejected", () => {
    const label = sourceOf({ landing: "?utm_source=" + "z".repeat(500) });
    assert.equal(label.length, MAX_LABEL);
    assert.equal(label, "z".repeat(MAX_LABEL));
  });

  test("a tag cannot smuggle markup or a quote out of this function", () => {
    assert.equal(sourceOf({ landing: "?ref=%3Cscript%3Ealert(1)%3C%2Fscript%3E" }), "script-alert-1-script");
  });
});

describe("sourceOf — direct and internal", () => {
  test("no referrer at all is direct", () => {
    assert.equal(sourceOf({ referrer: "", landing: SITE }), "direct");
    assert.equal(sourceOf({ landing: SITE }), "direct");
    assert.equal(sourceOf({}), "direct");
    assert.equal(sourceOf(), "direct");
  });

  test("a same-origin referrer is internal navigation, collapsed to direct", () => {
    // history.replaceState (?id=, ?crown=) makes these common — without the collapse the site's own
    // domain would top the channel table.
    assert.equal(sourceOf({ referrer: "https://prove-it.fly.dev/?id=ABCD", landing: SITE }), "direct");
    assert.equal(sourceOf({ referrer: "https://www.prove-it.fly.dev/", landing: SITE }), "direct");
    assert.equal(sourceOf({ referrer: "http://localhost:3000/x", landing: "http://localhost:3000/?id=AB" }), "direct");
  });

  test("`self` supplies the origin when the landing value has no host", () => {
    assert.equal(sourceOf({ referrer: "https://prove-it.fly.dev/", landing: "?id=ABCD", self: "prove-it.fly.dev" }), "direct");
    assert.equal(sourceOf({ referrer: "https://prove-it.fly.dev/", landing: "?id=ABCD", self: "https://prove-it.fly.dev" }), "direct");
    // …and without it a self-referral can't be recognised, which is why the client sends the full URL.
    assert.equal(sourceOf({ referrer: "https://prove-it.fly.dev/", landing: "?id=ABCD" }), "prove-it.fly.dev");
  });

  test("a different host is still a referral even when `self` is given", () => {
    assert.equal(sourceOf({ referrer: "https://old.reddit.com/", landing: SITE, self: "prove-it.fly.dev" }), "reddit");
  });

  test("the placeholder base host used for relative landing values never leaks out", () => {
    assert.equal(sourceOf({ referrer: "https://landing.invalid/x", landing: "?id=AB" }), "landing.invalid");
  });
});

describe("sourceOf — unknown hosts", () => {
  test("an unknown external host keeps its hostname so new channels are discoverable", () => {
    assert.equal(sourceOf({ referrer: "https://some.forum.example.org/thread/1", landing: SITE }), "some.forum.example.org");
    assert.equal(sourceOf({ referrer: "https://www.example.org/page", landing: SITE }), "example.org");
    assert.equal(sourceOf({ referrer: "HTTPS://Example.ORG/Page", landing: SITE }), "example.org");
  });

  test("an app referrer is recorded as its package name rather than dropped", () => {
    assert.equal(sourceOf({ referrer: "android-app://com.reddit.frontpage/", landing: SITE }), "com.reddit.frontpage");
  });

  test("an absurdly long hostname is clamped", () => {
    const label = sourceOf({ referrer: "https://" + "a".repeat(400) + ".example.org/", landing: SITE });
    assert.equal(label.length, MAX_LABEL);
  });
});

describe("sourceOf — never throws, never returns junk", () => {
  test("garbage, relative and non-http referrers are direct, not an exception", () => {
    for (const r of ["not a url at all", "///", "http://", "://x", "{}", "javascript:alert(1)", "data:text/html,x", "/relative/path"]) {
      assert.equal(sourceOf({ referrer: r, landing: SITE }), "direct", r);
    }
  });

  test("a malformed landing value degrades to referrer-only labelling", () => {
    assert.equal(sourceOf({ referrer: "https://old.reddit.com/", landing: "http://[" }), "reddit");
    assert.equal(sourceOf({ referrer: "https://old.reddit.com/", landing: null }), "reddit");
  });

  test("hostile input types don't throw", () => {
    for (const arg of [{ referrer: null, landing: undefined }, { referrer: 42, landing: 7 }, { referrer: {}, landing: [] },
      { referrer: true }, { landing: { toString: () => "?ref=weird" } }]) {
      const label = sourceOf(arg);
      assert.equal(typeof label, "string");
      assert.ok(label.length > 0 && label.length <= MAX_LABEL, JSON.stringify(arg) + " → " + label);
    }
  });

  test("control characters are stripped, not preserved, before anything is matched", () => {
    assert.equal(sourceOf({ referrer: "https://old.red\u0000dit.com/", landing: SITE }), "reddit");
    assert.equal(sourceOf({ landing: "?ref=disc\u0007ord" }), "discord");
    assert.equal(sourceOf({ referrer: "\u001fhttps://old.reddit.com/\u007f", landing: SITE }), "reddit");
  });

  test("every label is short, lowercase and safe for a table cell", () => {
    for (const r of ["https://old.reddit.com/", "https://t.co/x", "https://SHOUTY.Example.ORG/", "", "junk"]) {
      const label = sourceOf({ referrer: r, landing: SITE });
      assert.match(label, /^[a-z0-9._-]{1,32}$/, r + " → " + label);
    }
  });
});

describe("safeReferrer", () => {
  test("keeps the raw URL — the one thing a better label can't reconstruct later", () => {
    assert.equal(safeReferrer("https://old.reddit.com/r/x/comments/1?utm=2"), "https://old.reddit.com/r/x/comments/1?utm=2");
  });

  test("blank and missing referrers become null, so the DB column stays empty rather than ''", () => {
    assert.equal(safeReferrer(""), null);
    assert.equal(safeReferrer("   "), null);
    assert.equal(safeReferrer(null), null);
    assert.equal(safeReferrer(undefined), null);
  });

  test("clamps an arbitrarily long referrer and strips control characters", () => {
    const long = safeReferrer("https://example.org/" + "q".repeat(5000));
    assert.equal(long.length, MAX_REFERRER);
    assert.equal(safeReferrer("https://example.org/\u0000\u0001x"), "https://example.org/x");
  });
});
