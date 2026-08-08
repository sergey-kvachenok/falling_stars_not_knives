import assert from "node:assert/strict";
import { test } from "node:test";
import { fiveYearSummary } from "./metrics.js";
import type { QuarterPoint } from "../edgar/companyfacts.js";

// 20 quarters spanning 2021-09-30 … 2026-06-30 (~4.75y).
const ends: string[] = [];
for (let y = 2021; y <= 2026; y++) {
  for (const q of ["03-31", "06-30", "09-30", "12-31"]) {
    const d = `${y}-${q}`;
    if (d >= "2021-09-30" && d <= "2026-06-30") ends.push(d);
  }
}
const series = (vals: (i: number) => number): QuarterPoint[] =>
  ends.map((end, i) => ({ start: end.slice(0, 8) + "01", end, val: vals(i), accn: "a", derived: "direct" as const }));

test("five-year summary: CAGR, margin trajectory, FCF consistency, dilution", () => {
  const rev = series((i) => 100 * Math.pow(1.05, i)); // +5%/quarter ≈ 21.6%/yr
  const gross = series((i) => rev[i]!.val * (0.4 + 0.0025 * i)); // gross margin 40% → ~45%
  const op = series((i) => rev[i]!.val * 0.1);
  const fcf = series((i) => (i % 4 === 0 ? -5 : 10)); // positive in 15/20
  const shares = [
    { end: ends[0]!, val: 100_000_000 },
    { end: ends[ends.length - 1]!, val: 121_000_000 }, // ≈ +4.1%/yr over ~4.75y
  ];
  const fy = fiveYearSummary(rev, gross, op, fcf, shares, [])!;
  assert.ok(fy, "summary should exist");
  assert.ok(Math.abs(fy.revenueCagrPct! - 21.6) < 1.5, `rev CAGR ${fy.revenueCagrPct}`);
  assert.ok(fy.grossMarginDeltaBp! > 300 && fy.grossMarginDeltaBp! < 600, `gross Δ ${fy.grossMarginDeltaBp}bp`);
  assert.equal(fy.fcfPositiveQuarters, 15);
  assert.equal(fy.fcfQuarters, 20);
  assert.ok(Math.abs(fy.shareCagrPct! - 4.1) < 0.5, `share CAGR ${fy.shareCagrPct}`);
});

test("under 3 years of history → no five-year summary", () => {
  const short = series((i) => 100).slice(-8);
  assert.equal(fiveYearSummary(short, short, short, short, [], []), null);
});
