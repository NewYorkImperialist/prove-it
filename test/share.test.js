"use strict";
// The share-sheet wrapper (lib/browser/share.js). Its whole reason for existing is the three-way
// answer — shared / cancelled / unsupported — because the caller has to say something different
// for each, and a boolean would force a cancel to be reported as either a success or a failure.
// This is where that contract is pinned; the screens that render it are covered in
// test-browser/share.spec.js, since there is no DOM here.
const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// lib/browser is ES modules, so it comes in through a dynamic import (same as api.js in
// client-helpers.test.js). navigator is a real global in Node 22 — configurable, so it can be
// swapped for a fake and put back.
const real = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const withNavigator = async (fake, fn) => {
  Object.defineProperty(globalThis, "navigator", { value: fake, configurable: true, writable: true });
  const mod = await import("../lib/browser/share.js");
  return fn(mod);
};
afterEach(() => Object.defineProperty(globalThis, "navigator", real));

const rejectWith = (name) => () => {
  const err = new Error(name);
  err.name = name;
  return Promise.reject(err);
};

const PAYLOAD = { title: "Prove It!", text: "beat me", url: "https://example.test/c?id=1" };

describe("canShare", () => {
  test("a browser with no share sheet is not offered one", async () => {
    await withNavigator({}, ({ canShare }) => {
      assert.equal(canShare(), false);
      assert.equal(canShare(PAYLOAD), false);
    });
  });

  test("navigator.canShare gets the last word on a specific payload", async () => {
    // share() exists on browsers that still refuse the payload you hand them, and they report
    // that by throwing at click time — long after the button was labelled.
    await withNavigator({ share: async () => {}, canShare: (d) => !!d.url }, ({ canShare }) => {
      assert.equal(canShare(PAYLOAD), true);
      assert.equal(canShare({ text: "no link" }), false);
    });
  });

  test("without navigator.canShare, the presence of share() is all there is to go on", async () => {
    await withNavigator({ share: async () => {} }, ({ canShare }) => {
      assert.equal(canShare(PAYLOAD), true);
    });
  });

  test("a canShare that throws means no, not a crash", async () => {
    await withNavigator({ share: async () => {}, canShare: () => { throw new Error("nope"); } }, ({ canShare }) => {
      assert.equal(canShare(PAYLOAD), false);
    });
  });

  test("asked bare, it answers the capability question a label needs", async () => {
    // Called with no payload it must NOT consult canShare — a render-time label has no payload.
    let asked = false;
    await withNavigator({ share: async () => {}, canShare: () => { asked = true; return false; } }, ({ canShare }) => {
      assert.equal(canShare(), true);
      assert.equal(asked, false);
    });
  });
});

describe("share", () => {
  test("a sheet that accepts the payload reports 'shared'", async () => {
    let seen = null;
    await withNavigator({ share: async (d) => { seen = d; } }, async ({ share }) => {
      assert.equal(await share(PAYLOAD), "shared");
      assert.deepEqual(seen, PAYLOAD);
    });
  });

  test("backing out of the sheet is 'cancelled', never a failure", async () => {
    // The player made a decision. Reporting this as a failure puts an error on screen for
    // someone who simply changed their mind; reporting it as success confirms a share that
    // never happened.
    await withNavigator({ share: rejectWith("AbortError") }, async ({ share }) => {
      assert.equal(await share(PAYLOAD), "cancelled");
    });
  });

  test("any other rejection is 'unsupported', so the caller falls back to the clipboard", async () => {
    // NotAllowedError is the common one: called outside a user gesture, or with a sheet already open.
    await withNavigator({ share: rejectWith("NotAllowedError") }, async ({ share }) => {
      assert.equal(await share(PAYLOAD), "unsupported");
    });
    await withNavigator({ share: rejectWith("TypeError") }, async ({ share }) => {
      assert.equal(await share(PAYLOAD), "unsupported");
    });
  });

  test("no share sheet at all is 'unsupported'", async () => {
    await withNavigator({}, async ({ share }) => {
      assert.equal(await share(PAYLOAD), "unsupported");
    });
  });

  test("an empty payload never reaches the sheet", async () => {
    // navigator.share({}) throws; and there is nothing to share anyway.
    let called = false;
    await withNavigator({ share: async () => { called = true; } }, async ({ share }) => {
      assert.equal(await share({}), "unsupported");
      assert.equal(await share({ title: "", text: "  ", url: undefined }), "unsupported");
      assert.equal(called, false);
    });
  });

  test("blank fields are dropped rather than handed over as empty strings", async () => {
    // A sheet given text: "" shows an empty message body.
    let seen = null;
    await withNavigator({ share: async (d) => { seen = d; } }, async ({ share }) => {
      await share({ title: "Prove It!", text: "", url: "https://example.test/" });
      assert.deepEqual(seen, { title: "Prove It!", url: "https://example.test/" });
    });
  });
});
