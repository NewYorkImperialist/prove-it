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
const { ownerOk, crownOk, ownerKeyOk } = require("../lib/owner-auth.js");

const req = (key) => ({ query: key === undefined ? {} : { key }, get: () => undefined });
const header = (key) => ({ query: {}, get: (h) => (h === "x-owner-key" ? key : undefined) });

let savedOwner, savedCrown;
beforeEach(() => { savedOwner = process.env.OWNER_KEY; savedCrown = process.env.CROWN_KEY; });
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
  const fs = require("fs");
  const path = require("path");
  const ROOT = path.join(__dirname, "..");
  const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

  test("every /admin route is behind ownerOk, and none of them accept the crown key", () => {
    const src = read("routes/admin.js");
    assert.equal(/crownOk/.test(src), false, "routes/admin.js must never consult the crown key");
    assert.match(src, /ownerOk/);
  });

  test("the cosmetic crown is the only thing the browser-resident key buys", () => {
    // setCrown (a badge on a scoreboard) and the result POST's crown flag. Nothing else.
    assert.match(read("server/rooms.js"), /if \(!crownOk\(key\)\) return;/);
    assert.match(read("routes/challenge.js"), /const crown = crownOk\(b\.ownerKey\)/);
  });

  test("ghostWatch stays on the admin key — invisible surveillance is not a badge", () => {
    assert.match(read("server/rooms.js"), /if \(!ownerKeyOk\(key\)\) return ack\?\.\(\{ ok: false/);
  });

  test("renaming EVERY crowned row stays on the admin key too", () => {
    // A bulk write across rows, not a badge. A client sending its crown key simply doesn't get this
    // branch; its own rows are still renameable through the visitorId path.
    assert.match(read("routes/challenge.js"), /const crownAll = ownerKeyOk\(b\.ownerKey\)/);
  });

  test("no key of either kind is baked into the client bundle", () => {
    // NEXT_PUBLIC_* is inlined by Next at build time, which would put the secret in every visitor's
    // JavaScript rather than only in the owner's localStorage.
    for (const f of ["lib/browser/storage.js", "hooks/useSolo.js", "app/layout.jsx"]) {
      assert.equal(/NEXT_PUBLIC_OWNER_KEY|NEXT_PUBLIC_CROWN_KEY/.test(read(f)), false, f);
    }
  });
});
