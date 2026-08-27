"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { attempt } = require("../scripts/probe.js");

// The prober's whole value is that it is honest about a site being down, so what needs testing is
// its verdict — driven against a real socket rather than a mocked fetch, because the failures that
// matter here (a 200 carrying the wrong body, a connection that never answers) are transport
// behaviour and a mock would just restate my assumptions about them.
describe("scripts/probe.js — the health verdict", () => {
  let server, base, mode = "ok";
  before(async () => {
    server = http.createServer((req, res) => {
      if (mode === "ok") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ok: true, now: Date.now() })); }
      if (mode === "notfound") { res.writeHead(404); return res.end("Not found"); }
      if (mode === "edgepage") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>upstream error</html>"); }
      if (mode === "notok") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ok: false })); }
      // "hang": accept the connection and never answer, which is what a wedged machine does.
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
    process.env.OWNER_KEY = "probe-test-key";
  });
  after(() => new Promise((r) => server.close(r)));
  const run = (m) => { mode = m; return attempt(); };

  test("a real ping is up, with a latency", async () => {
    process.env.PROBE_URL = base;
    const r = await run("ok");
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(typeof r.ms, "number");
  });

  test("the owner gate answering 404 is recorded as down, not skipped", async () => {
    process.env.PROBE_URL = base;
    const r = await run("notfound");
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
    assert.match(r.err, /HTTP 404/);
  });

  test("a 200 that isn't the ping payload is down — an edge error page is not uptime", async () => {
    // This is the case a status-only check gets wrong: Fly (or any proxy) can answer 200 with its
    // own page while the app behind it is gone.
    process.env.PROBE_URL = base;
    const r = await run("edgepage");
    assert.equal(r.ok, false);
    assert.equal(r.status, 200, "the status really was 200");
    assert.match(r.err, /not the ping payload/);
  });

  test("ok:false in the body is down even with a 200", async () => {
    process.env.PROBE_URL = base;
    const r = await run("notok");
    assert.equal(r.ok, false);
  });

  test("a server that accepts the connection and never answers times out, and says so", async () => {
    process.env.PROBE_URL = base;
    process.env.PROBE_TIMEOUT_MS = "400"; // read per-call, so this only affects this test
    const started = Date.now();
    const r = await run("hang");
    const took = Date.now() - started;
    assert.equal(r.ok, false);
    assert.equal(r.status, 0);
    assert.match(r.err, /timeout after/);
    // The point of the bound: it returns rather than hanging forever, which is the failure mode
    // that wedged the deploy workflow.
    assert.ok(took < 5000, `took ${took}ms — the timeout didn't fire`);
    delete process.env.PROBE_TIMEOUT_MS;
  });

  test("an address with nothing listening is down, not a crash", async () => {
    process.env.PROBE_URL = "http://127.0.0.1:1";
    const r = await attempt();
    assert.equal(r.ok, false);
    assert.equal(r.status, 0);
    assert.ok(r.err.length > 0);
  });
});

// The probe runs every five minutes from a PUBLIC repository, so its workflow logs are
// world-readable. That makes where it puts the owner key a security question, not a style one.
describe("scripts/probe.js — the owner key never goes into a URL", () => {
  const fs = require("fs");
  const path = require("path");
  const RAW = fs.readFileSync(path.join(__dirname, "..", "scripts", "probe.js"), "utf8");
  // Assert on CODE, not on prose. Twice now a check for "X must not appear" has matched the comment
  // explaining why X is absent — a test that passes when the code is wrong and fails when it is
  // right. Strip line comments first; the code in this file has no block comments.
  const SRC = RAW.split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "$1")).join("\n");

  test("the key is sent as a header, not a query parameter", () => {
    // Three ways a keyed URL leaks from here, any one of which is enough:
    //  • GitHub masks `${{ secrets.X }}` in logs by EXACT match, and encodeURIComponent(key) is a
    //    different string as soon as the key contains + / = or a space — so an encoded key in a URL
    //    is not masked at all.
    //  • A fetch failure's message can carry the request URL, and this script prints that message
    //    and re-emits it as a ::warning:: annotation.
    //  • Fly's HTTP access log records path and query for every request.
    assert.match(SRC, /"x-owner-key": key/, "the key belongs in a header");
    assert.match(RAW, /x-owner-key/, "and the file should say why, in a comment");
    assert.equal(/\/admin\/ping\?key=/.test(SRC), false, "no keyed URL anywhere");
    assert.equal(/encodeURIComponent\(key\)/.test(SRC), false, "and nothing that would encode it into one");
  });

  test("the failure path prints only an error string, never a URL it built", () => {
    // If a future edit logs the request URL on failure, this is the test that should stop it.
    const printed = [...SRC.matchAll(/console\.(?:log|error)\(([^\n]*)\)/g)].map((m) => m[1]);
    for (const line of printed) {
      assert.equal(/\$\{base\}/.test(line), false, `a log line builds a URL: ${line}`);
      assert.equal(/key/.test(line) && /\$\{/.test(line), false, `a log line interpolates the key: ${line}`);
    }
  });

  test("the workflow still supplies the key, so the probe can still authenticate", () => {
    const wf = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "uptime.yml"), "utf8");
    assert.match(wf, /OWNER_KEY: \$\{\{ secrets\.OWNER_KEY \}\}/);
    // And it must not be interpolated into a URL there either.
    assert.equal(/PROBE_URL:.*OWNER_KEY|key=/.test(wf), false);
  });
});
