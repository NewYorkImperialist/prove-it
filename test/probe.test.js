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
