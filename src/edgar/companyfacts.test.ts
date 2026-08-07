import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDuration, normalizeInstant, type RawFact } from "./companyfacts.js";

const fact = (start: string, end: string, val: number, filed = "2026-01-01", accn = "a-1"): RawFact => ({
  start,
  end,
  val,
  accn,
  form: "10-Q",
  filed,
});

test("direct quarters pass through", () => {
  const { quarterly } = normalizeDuration([
    fact("2025-01-01", "2025-03-31", 100),
    fact("2025-04-01", "2025-06-30", 110),
  ]);
  assert.equal(quarterly.length, 2);
  assert.deepEqual(quarterly.map((q) => q.val), [100, 110]);
  assert.equal(quarterly[0]!.derived, "direct");
});

test("cash-flow style: quarterly derived from cumulative YTD diffs", () => {
  // 10-Qs report cash flow YTD-only: Q1=50, H1=120, 9M=200, FY=290
  const { quarterly } = normalizeDuration([
    fact("2025-01-01", "2025-03-31", 50),
    fact("2025-01-01", "2025-06-30", 120),
    fact("2025-01-01", "2025-09-30", 200),
    fact("2025-01-01", "2025-12-31", 290),
  ]);
  assert.deepEqual(quarterly.map((q) => q.val), [50, 70, 80, 90]);
  assert.equal(quarterly[3]!.derived, "ytd-diff"); // Q4 = FY − 9M
});

test("Q4 derived from FY minus 9M when only quarters + annual filed", () => {
  const { quarterly, annual } = normalizeDuration([
    fact("2025-01-01", "2025-03-31", 100),
    fact("2025-04-01", "2025-06-30", 110),
    fact("2025-01-01", "2025-09-30", 330), // 9M YTD
    fact("2025-01-01", "2025-12-31", 460), // FY
  ]);
  const q4 = quarterly.find((q) => q.end === "2025-12-31");
  assert.ok(q4, "Q4 should be derived");
  assert.equal(q4.val, 130); // 460 − 330
  assert.equal(annual.length, 1);
});

test("restatement: latest filed wins for the same period", () => {
  const { quarterly } = normalizeDuration([
    fact("2025-01-01", "2025-03-31", 100, "2025-05-01"),
    fact("2025-01-01", "2025-03-31", 95, "2025-08-01"), // restated later
  ]);
  assert.equal(quarterly.length, 1);
  assert.equal(quarterly[0]!.val, 95);
});

test("non-December fiscal year (AAPL-style, FY ends late Sept)", () => {
  const { quarterly } = normalizeDuration([
    fact("2024-09-29", "2024-12-28", 120), // FQ1
    fact("2024-09-29", "2025-03-29", 210), // 6M YTD
    fact("2024-09-29", "2025-06-28", 290), // 9M YTD
    fact("2024-09-29", "2025-09-27", 400), // FY
  ]);
  assert.deepEqual(quarterly.map((q) => q.val), [120, 90, 80, 110]);
});

test("direct quarter beats ytd-diff for the same period end", () => {
  const { quarterly } = normalizeDuration([
    fact("2025-01-01", "2025-03-31", 50),
    fact("2025-04-01", "2025-06-30", 71), // direct Q2
    fact("2025-01-01", "2025-06-30", 120), // YTD would imply Q2 = 70
  ]);
  const q2 = quarterly.find((q) => q.end === "2025-06-30");
  assert.equal(q2?.val, 71);
  assert.equal(q2?.derived, "direct");
});

test("instant series dedupes by end date, latest filed wins", () => {
  const pts = normalizeInstant([
    { end: "2025-03-31", val: 10, accn: "a", form: "10-Q", filed: "2025-05-01" },
    { end: "2025-03-31", val: 12, accn: "b", form: "10-K", filed: "2026-02-01" },
    { end: "2025-06-30", val: 11, accn: "c", form: "10-Q", filed: "2025-08-01" },
  ]);
  assert.deepEqual(pts.map((p) => p.val), [12, 11]);
});
