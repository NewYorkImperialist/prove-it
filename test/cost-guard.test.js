"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { FLY_COST, projectCost } = require("../lib/cost-guard.js");

const closeTo = (actual, expected, tolerance = 0.01) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);

describe("projectCost", () => {
  test("extrapolates this cycle's egress to a month-end projection", () => {
    // Jan 15 2024, 12:00 UTC — 14.5 days into a 31-day month, 10GB used so far.
    const now = Date.UTC(2024, 0, 15, 12, 0, 0);
    const p = projectCost({ monthBytes: 10e9 }, now);
    assert.equal(p.daysInMonth, 31);
    closeTo(p.elapsedDays, 14.5);
    assert.equal(p.gb, 10);
    closeTo(p.projGB, (10 / 14.5) * 31); // ~21.38 GB projected for the full month
    closeTo(p.egressProj, p.projGB * FLY_COST.egressPerGB);
    closeTo(p.projTotal, FLY_COST.computePerMo + p.egressProj);
    closeTo(p.soFar, FLY_COST.computePerMo * (14.5 / 31) + 10 * FLY_COST.egressPerGB);
    assert.equal(p.month, "2024-01");
  });

  test("zero bandwidth still projects the fixed compute cost, no egress", () => {
    const now = Date.UTC(2024, 0, 15, 12, 0, 0);
    const p = projectCost({ monthBytes: 0 }, now);
    assert.equal(p.gb, 0);
    assert.equal(p.projGB, 0);
    assert.equal(p.egressProj, 0);
    closeTo(p.projTotal, FLY_COST.computePerMo);
  });

  test("missing monthBytes is treated as zero (no persistence yet this cycle)", () => {
    const now = Date.UTC(2024, 0, 15, 12, 0, 0);
    const p = projectCost({}, now);
    assert.equal(p.gb, 0);
  });

  test("elapsedDays is floored at 0.5 right at month start, so a noisy first sample doesn't spike the projection", () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 1); // 1 second into the month
    const p = projectCost({ monthBytes: 1e9 }, now);
    assert.equal(p.elapsedDays, 0.5);
  });

  test("month string matches the projected month, in YYYY-MM", () => {
    const now = Date.UTC(2024, 11, 25); // Dec 25 2024
    const p = projectCost({ monthBytes: 0 }, now);
    assert.equal(p.month, "2024-12");
    assert.equal(p.daysInMonth, 31);
  });
});
