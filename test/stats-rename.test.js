"use strict";
// adminRename is the only owner-side write that OVERWRITES data instead of appending or deleting,
// which makes two things worth pinning down at the SQL level rather than at the route:
//   1. the previous name is read BEFORE the update, or the audit row records the new name as the old
//      one and the record is worthless in exactly the case it exists for;
//   2. the scope decides the WHERE clause, and a visitor-wide rename must never key on a NULL
//      visitor_id — `WHERE visitor_id=NULL` matches nothing in SQL, but a fallback that got this
//      wrong in the other direction would rewrite every anonymous row on every board.
//
// server/stats.js talks to Turso over HTTP with no injection seam, so this loads it against a fake
// @libsql/client/web planted in the require cache. That also keeps the real SQL strings under test —
// a stub of adminRename itself (which is what the route tests use) could not catch a typo in a
// WHERE clause.
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const LIBSQL = require.resolve("@libsql/client/web");
const STATS = require.resolve("../server/stats.js");

// Every statement the module runs, in order, so ordering is assertable and not just outcomes.
let log = [];
// Canned answers, keyed by a fragment of the SQL. Anything unmatched returns no rows, which is
// also how a "row not found" case is set up.
let selects = [];

// SQL fragments whose statement should reject, standing in for a Turso outage mid-rename.
let throwOn = [];

function fakeClient() {
  const respond = (sql, args) => {
    log.push({ sql: String(sql).replace(/\s+/g, " ").trim(), args: args || [] });
    if (throwOn.some((f) => String(sql).includes(f))) return Promise.reject(new Error("connection reset"));
    const hit = selects.find((s) => String(sql).includes(s.match));
    return Promise.resolve({
      rows: hit && hit.row ? [hit.row] : [],
      rowsAffected: hit && hit.rowsAffected != null ? hit.rowsAffected : 1,
    });
  };
  return {
    execute: (arg) => (typeof arg === "string" ? respond(arg, null) : respond(arg.sql, arg.args)),
    batch: () => Promise.resolve([]),
  };
}

let analytics, realLog, realError, savedLibsql;

before(async () => {
  realLog = console.log; console.log = () => {};
  realError = console.error; console.error = () => {};
  savedLibsql = require.cache[LIBSQL];
  require.cache[LIBSQL] = { id: LIBSQL, filename: LIBSQL, loaded: true, exports: { createClient: () => fakeClient() } };
  process.env.TURSO_URL = "libsql://fake.test";
  delete require.cache[STATS];
  analytics = require(STATS);
  // init() runs on load (CREATE TABLEs + ALTERs) and is async — let it drain so its statements
  // don't land in the middle of a test's log.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

after(() => {
  delete process.env.TURSO_URL;
  delete require.cache[STATS];
  if (savedLibsql) require.cache[LIBSQL] = savedLibsql; else delete require.cache[LIBSQL];
  require(STATS); // restore the shared, persistence-off module object other suites may load
  console.log = realLog; console.error = realError;
});

beforeEach(() => { log = []; selects = []; throwOn = []; });

const rowLookup = (row) => selects.push({ match: "SELECT id, name, visitor_id FROM challenge_results WHERE id=?", row });
// How many rows the UPDATE claims to have rewritten (a visitor-wide rename hits more than one).
const updateAffects = (n) => selects.push({ match: "UPDATE challenge_results SET name=?", row: null, rowsAffected: n });
const stmts = (frag) => log.filter((e) => e.sql.includes(frag));
const only = (frag) => { const m = stmts(frag); assert.equal(m.length, 1, `expected exactly one ${frag}, got ${m.length}`); return m[0]; };

describe("server/stats.js — adminRename", () => {
  test("the schema creates a table to hold the name a rename replaced", () => {
    // Without this the previous name is gone from the database entirely: renameResults overwrites
    // `name` in place, there is no history column, and nothing else records it.
    const src = require("node:fs").readFileSync(path.join(__dirname, "..", "server", "stats.js"), "utf8");
    assert.match(src, /CREATE TABLE IF NOT EXISTS name_audit/);
    assert.match(src, /old_name TEXT, new_name TEXT/);
  });

  test("row scope updates that one entry by id", async () => {
    rowLookup({ id: 42, name: "doodooblud", visitor_id: "v-abc" });
    const out = await analytics.adminRename({ rowId: 42, scope: "row", name: "jayden" });
    assert.equal(out.ok, true);
    assert.equal(out.scope, "row");
    const upd = only("UPDATE challenge_results SET name=?");
    assert.match(upd.sql, /WHERE id=\?$/);
    assert.deepEqual(upd.args, ["jayden", 42]);
  });

  test("visitor scope updates every entry that visitor submitted", async () => {
    rowLookup({ id: 42, name: "doodooblud", visitor_id: "v-abc" });
    const out = await analytics.adminRename({ rowId: 42, scope: "visitor", name: "jayden" });
    assert.equal(out.scope, "visitor");
    const upd = only("UPDATE challenge_results SET name=?");
    assert.match(upd.sql, /WHERE visitor_id=\?$/);
    assert.deepEqual(upd.args, ["jayden", "v-abc"]);
  });

  test("an unknown scope is treated as the narrow one, never as the bulk one", async () => {
    rowLookup({ id: 42, name: "diddy kong", visitor_id: "v-abc" });
    await analytics.adminRename({ rowId: 42, scope: "everything", name: "jayden" });
    assert.match(only("UPDATE challenge_results SET name=?").sql, /WHERE id=\?$/);
  });

  test("scope defaults to the single row when the caller omits it", async () => {
    rowLookup({ id: 7, name: "claude code", visitor_id: "v-xyz" });
    const out = await analytics.adminRename({ rowId: 7, name: "jayden" });
    assert.equal(out.scope, "row");
    assert.match(only("UPDATE challenge_results SET name=?").sql, /WHERE id=\?$/);
  });

  test("a visitor-wide rename of a row with no visitor_id falls back to the row", async () => {
    // `WHERE visitor_id=NULL` matches nothing, so the rename would silently do nothing and report
    // success. Rows predating the visitor_id column are real and still on the boards.
    rowLookup({ id: 9, name: "Anon", visitor_id: null });
    const out = await analytics.adminRename({ rowId: 9, scope: "visitor", name: "jayden" });
    assert.equal(out.scope, "row");
    assert.equal(out.visitorId, null);
    assert.deepEqual(only("UPDATE challenge_results SET name=?").args, ["jayden", 9]);
  });

  test("the old name is read before the update, and is what the audit row keeps", async () => {
    rowLookup({ id: 42, name: "THE ONE ABOVE ALL", visitor_id: "v-abc" });
    const out = await analytics.adminRename({ rowId: 42, scope: "row", name: "jayden" });
    const iSelect = log.findIndex((e) => e.sql.startsWith("SELECT id, name, visitor_id"));
    const iUpdate = log.findIndex((e) => e.sql.startsWith("UPDATE challenge_results SET name=?"));
    assert.ok(iSelect >= 0 && iUpdate > iSelect, "the SELECT must precede the UPDATE");
    const audit = only("INSERT INTO name_audit");
    assert.equal(audit.args[4], "THE ONE ABOVE ALL", "old_name");
    assert.equal(audit.args[5], "jayden", "new_name");
    assert.equal(out.from, "THE ONE ABOVE ALL");
  });

  test("the audit row records which scope ran and how many entries it rewrote", async () => {
    rowLookup({ id: 42, name: "doodooblud", visitor_id: "v-abc" });
    updateAffects(4);
    const out = await analytics.adminRename({ rowId: 42, scope: "visitor", name: "jayden", by: "admin" });
    const audit = only("INSERT INTO name_audit");
    assert.equal(audit.args[1], "visitor", "scope");
    assert.equal(audit.args[2], 42, "row_id — which entry the owner clicked");
    assert.equal(audit.args[3], "v-abc", "visitor_id");
    assert.equal(audit.args[7], "admin", "by_who");
    assert.equal(out.rows, 4);
  });

  test("a blank or whitespace-only name is refused, and writes nothing at all", async () => {
    for (const name of ["", "   ", null, undefined]) {
      log = [];
      rowLookup({ id: 42, name: "doodooblud", visitor_id: "v-abc" });
      const out = await analytics.adminRename({ rowId: 42, scope: "row", name });
      assert.equal(out.ok, false, JSON.stringify(name));
      assert.equal(out.reason, "no-name");
      assert.equal(stmts("UPDATE challenge_results").length, 0);
      assert.equal(stmts("INSERT INTO name_audit").length, 0);
    }
  });

  test("the name is stored trimmed", async () => {
    rowLookup({ id: 42, name: "doodooblud", visitor_id: "v-abc" });
    await analytics.adminRename({ rowId: 42, scope: "row", name: "  jayden  " });
    assert.equal(only("UPDATE challenge_results SET name=?").args[0], "jayden");
  });

  test("a missing row id is refused before anything is read", async () => {
    for (const rowId of [undefined, null, 0, "", "abc", NaN]) {
      log = [];
      const out = await analytics.adminRename({ rowId, scope: "row", name: "jayden" });
      assert.equal(out.ok, false, String(rowId));
      assert.equal(out.reason, "no-row");
      assert.equal(log.length, 0, "nothing should be queried");
    }
  });

  test("a row id that doesn't exist updates nothing rather than falling back to a broader match", async () => {
    // selects is empty, so the lookup returns no rows.
    const out = await analytics.adminRename({ rowId: 999, scope: "visitor", name: "jayden" });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "not-found");
    assert.equal(stmts("UPDATE challenge_results").length, 0);
    assert.equal(stmts("INSERT INTO name_audit").length, 0);
  });

  test("an entry whose stored name is NULL still renames, and records that it was blank", async () => {
    rowLookup({ id: 42, name: null, visitor_id: "v-abc" });
    const out = await analytics.adminRename({ rowId: 42, scope: "row", name: "jayden" });
    assert.equal(out.ok, true);
    assert.equal(out.from, "");
    assert.equal(only("INSERT INTO name_audit").args[4], "");
  });

  test("a failed update reports failure and writes no audit row claiming it happened", async () => {
    rowLookup({ id: 42, name: "doodooblud", visitor_id: "v-abc" });
    throwOn = ["UPDATE challenge_results"];
    const out = await analytics.adminRename({ rowId: 42, scope: "row", name: "jayden" });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "write-failed");
    assert.equal(stmts("INSERT INTO name_audit").length, 0, "an audit row here would record a rename that never happened");
  });

  test("a rename that matched no rows is not reported as a failure", async () => {
    // 0 rows affected and a dropped connection are different outcomes, and the caller has to be
    // able to tell them apart — one means the entry is gone, the other means try again.
    rowLookup({ id: 42, name: "doodooblud", visitor_id: "v-abc" });
    updateAffects(0);
    const out = await analytics.adminRename({ rowId: 42, scope: "row", name: "jayden" });
    assert.equal(out.ok, true);
    assert.equal(out.rows, 0);
  });

  test("a failed audit write doesn't undo or hide the rename that did land", async () => {
    rowLookup({ id: 42, name: "doodooblud", visitor_id: "v-abc" });
    throwOn = ["INSERT INTO name_audit"];
    const out = await analytics.adminRename({ rowId: 42, scope: "row", name: "jayden" });
    assert.equal(out.ok, true, "the name really did change; reporting otherwise would be worse");
    assert.equal(stmts("UPDATE challenge_results").length, 1);
  });

  test("nameAuditList reads the history newest first, and clamps the limit", async () => {
    await analytics.nameAuditList(25);
    assert.match(only("FROM name_audit").sql, /ORDER BY id DESC LIMIT \?/);
    // 0 and a non-number are meaningless limits rather than requests for nothing, so they take the
    // default; a negative one clamps to the floor.
    for (const [asked, want] of [[0, 25], [-5, 1], [10000, 200], ["abc", 25], [undefined, 25], [50, 50]]) {
      log = [];
      await analytics.nameAuditList(asked);
      assert.equal(only("FROM name_audit").args[0], want, `limit ${asked}`);
    }
  });
});

describe("server/stats.js — adminRename with persistence off", () => {
  test("it no-ops rather than throwing when Turso isn't configured", async () => {
    // The whole module is meant to go quiet with no TURSO_URL — an owner tool that threw here
    // would 500 the admin page in local development.
    const saved = require.cache[STATS];
    delete require.cache[STATS];
    const prevUrl = process.env.TURSO_URL;
    delete process.env.TURSO_URL;
    const realL = console.log; console.log = () => {};
    try {
      const off = require(STATS);
      assert.equal(off.enabled(), false);
      assert.deepEqual(await off.adminRename({ rowId: 1, scope: "row", name: "jayden" }), { ok: false, rows: 0, reason: "off" });
      assert.deepEqual(await off.nameAuditList(10), []);
    } finally {
      console.log = realL;
      if (prevUrl) process.env.TURSO_URL = prevUrl;
      delete require.cache[STATS];
      require.cache[STATS] = saved;
    }
  });
});
