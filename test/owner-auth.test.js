"use strict";
// The 👑 crown and the /admin dashboard used to be the SAME secret, and the crown's secret has to
// live in a browser to work: lib/browser/storage.js keeps it in localStorage, every result POST
// carries it, and the setCrown socket emit sends it. So OWNER_KEY — which unlocks every visitor's
// IP and geography, all chat, the session log, and the tools that rename, merge and delete
// leaderboard entries — was sitting in localStorage on any device the owner had ever crowned on,
// and one XSS anywhere in the app would have handed it over.
//
// CROWN_KEY is the browser-resident half now. OWNER_KEY never leaves the server except into the
// owner's own address bar.
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { ownerOk, crownOk, ownerKeyOk, resetAdminThrottle } = require("../lib/owner-auth.js");

const req = (key) => ({ query: key === undefined ? {} : { key }, get: () => undefined });
const header = (key) => ({ query: {}, get: (h) => (h === "x-owner-key" ? key : undefined) });

let savedOwner, savedCrown;
// Every key check is throttled per caller now (see test/admin-throttle.test.js), and these tests
// share one address while deliberately making wrong guesses — so without a reset the later ones are
// refused for being over budget rather than for the reason they are testing.
beforeEach(() => { savedOwner = process.env.OWNER_KEY; savedCrown = process.env.CROWN_KEY; resetAdminThrottle(); });
afterEach(() => {
  if (savedOwner === undefined) delete process.env.OWNER_KEY; else process.env.OWNER_KEY = savedOwner;
  if (savedCrown === undefined) delete process.env.CROWN_KEY; else process.env.CROWN_KEY = savedCrown;
});

describe("lib/owner-auth.js — the dashboard key and the crown key are separate", () => {
  test("the crown key does NOT open the admin dashboard", () => {
    // The whole point. This is the value that lives in a browser.
    process.env.OWNER_KEY = "admin-secret";
    process.env.CROWN_KEY = "crown-secret";
    assert.equal(crownOk("crown-secret"), true, "it still earns the badge");
    assert.equal(ownerOk(req("crown-secret")), false, "and nothing else");
    assert.equal(ownerKeyOk("crown-secret"), false);
  });

  test("the admin key still earns the crown, so the owner's own device keeps working", () => {
    process.env.OWNER_KEY = "admin-secret";
    process.env.CROWN_KEY = "crown-secret";
    assert.equal(ownerOk(req("admin-secret")), true);
    // Deliberately false: once CROWN_KEY is set, the crown check wants THAT value. An old browser
    // still holding the admin key stops crowning — which is the intended outcome, because the value
    // that was exposed should stop being good for anything.
    assert.equal(crownOk("admin-secret"), false);
  });

  test("with no CROWN_KEY set, the crown falls back to OWNER_KEY", () => {
    // Every already-installed browser is holding the old value, so the split has to be a no-op
    // until the owner sets CROWN_KEY. Nothing breaks on deploy.
    delete process.env.CROWN_KEY;
    process.env.OWNER_KEY = "admin-secret";
    assert.equal(crownOk("admin-secret"), true);
    assert.equal(ownerOk(req("admin-secret")), true);
  });

  test("neither gate opens when its secret is unset", () => {
    // An unconfigured deployment (a fork, a local dev run) must not be wide open, and must not
    // treat an empty/undefined env var as a matching empty key.
    delete process.env.OWNER_KEY;
    delete process.env.CROWN_KEY;
    for (const v of ["", undefined, null, "anything"]) {
      assert.equal(ownerOk(req(v)), false, `owner: ${v}`);
      assert.equal(crownOk(v), false, `crown: ${v}`);
      assert.equal(ownerKeyOk(v), false, `ownerKey: ${v}`);
    }
  });

  test("an empty configured key is still not matched by an empty request", () => {
    process.env.OWNER_KEY = "";
    assert.equal(ownerOk(req("")), false);
    assert.equal(ownerKeyOk(""), false);
  });

  test("a wrong key of the same length is refused", () => {
    // The comparison is constant-time, which means it must still actually compare.
    process.env.OWNER_KEY = "abcdefgh";
    assert.equal(ownerOk(req("abcdefgi")), false);
    assert.equal(ownerOk(req("abcdefgh")), true);
  });

  test("a non-string key can't crash the gate", () => {
    // These arrive from a query string, so they can be arrays or objects.
    process.env.OWNER_KEY = "admin-secret";
    for (const v of [["admin-secret"], { toString: () => "admin-secret" }, 12345, true, {}]) {
      assert.equal(ownerOk(req(v)), false, JSON.stringify(v));
      assert.equal(crownOk(v), false, JSON.stringify(v));
      assert.equal(ownerKeyOk(v), false, JSON.stringify(v));
    }
  });

  test("the key may also arrive as a header, for the dashboard's own fetches", () => {
    process.env.OWNER_KEY = "admin-secret";
    assert.equal(ownerOk(header("admin-secret")), true);
    assert.equal(ownerOk(header("nope")), false);
  });
});

describe("lib/owner-auth.js — which capabilities sit behind which key", () => {
  // readCode strips comments first. Three separate assertions in this repo have matched the comment
  // explaining why something was removed, passing when the code was wrong. See test/helpers/source.js.
  const { readCode: read } = require("./helpers/source.js");

  test("every /admin route is behind ownerOk, and none of them accept the crown key", () => {
    const src = read("routes/admin.js");
    assert.equal(/crownOk/.test(src), false, "routes/admin.js must never consult the crown key");
    assert.match(src, /ownerOk/);
  });

  test("the cosmetic crown is the only thing the browser-resident key buys", () => {
    // setCrown (a badge on a scoreboard) and the result POST's crown flag. Nothing else.
    assert.match(read("server/rooms.js"), /if \(!crownOk\(key, socketBucket\(socket\)\)\) return;/);
    assert.match(read("routes/challenge.js"), /const crown = crownOk\(b\.ownerKey, callerIp\(req\)\)/);
  });

  test("ghostWatch stays on the admin key — invisible surveillance is not a badge", () => {
    assert.match(read("server/rooms.js"), /if \(!ownerKeyOk\(key, socketBucket\(socket\)\)\)/);
  });

  test("every key check passes a caller bucket, so none of them is unthrottled", () => {
    // The whole point of routing them through one function: a check with no bucket would share a
    // single global budget, and a check that skipped the function entirely would be a free oracle —
    // which is exactly what the public rename endpoint used to be.
    const src = read("lib/owner-auth.js");
    assert.match(src, /function verifyKey\(want, given, bucket\)/);
    for (const fn of ["ownerOk", "crownOk", "ownerKeyOk"]) {
      const body = src.slice(src.indexOf(`function ${fn}(`));
      assert.match(body.slice(0, 260), /verifyKey\(/, `${fn} must go through verifyKey`);
    }
  });

  test("the public rename endpoint no longer accepts an owner key at all", () => {
    // It used to, which made an unauthenticated endpoint answer yes/no about OWNER_KEY: a wrong key
    // returned {ok:false} and the right one {ok:true}. Throttling that would have made guessing
    // slower; removing the branch makes the question unaskable.
    const src = read("routes/challenge.js");
    const rename = src.slice(src.indexOf('router.post("/challenge/rename"'), src.indexOf('router.post("/challenge/:id/guesses"'));
    assert.ok(rename.length > 100, "found the rename route");
    assert.equal(/ownerKeyOk/.test(rename), false, "no owner-key check on a public endpoint");
    assert.equal(/crownAll = /.test(rename), false, "and no branch that depends on one");
    assert.match(rename, /if \(!visitorId\) return res\.json\(\{ ok: false \}\)/, "identity is the only way in");
  });

  test("no key of either kind is baked into the client bundle", () => {
    // NEXT_PUBLIC_* is inlined by Next at build time, which would put the secret in every visitor's
    // JavaScript rather than only in the owner's localStorage.
    for (const f of ["lib/browser/storage.js", "hooks/useSolo.js", "app/layout.jsx"]) {
      assert.equal(/NEXT_PUBLIC_OWNER_KEY|NEXT_PUBLIC_CROWN_KEY/.test(read(f)), false, f);
    }
  });
});
