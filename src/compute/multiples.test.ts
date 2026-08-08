import assert from "node:assert/strict";
import { test } from "node:test";
import { historicalMultipleRanges, percentile, ttmSeries } from "./multiples.js";
import type { ComputedMetrics } from "./metrics.js";
import type { FactsByConcept } from "../edgar/companyfacts.js";

const q = (end: string, val: number) => ({ start: end.slice(0, 8) + "01", end, val, accn: "a", derived: "direct" as const });

test("ttmSeries sums trailing four quarters", () => {
  const s = ttmSeries([q("2025-03-31", 10), q("2025-06-30", 20), q("2025-09-30", 30), q("2025-12-31", 40), q("2026-03-31", 50)]);
  assert.deepEqual(s.map((p) => p.ttm), [100, 140]);
});

test("percentile interpolates", () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4], 0.25), 1.75);
});

test("historical ranges computed from closes × shares over TTM revenue", () => {
  // 8 quarters of revenue 100 each → TTM 400 at 5 quarter-ends.
  const rev = ["2024-06-30", "2024-09-30", "2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31"].map((d) => q(d, 100));
  const facts = { revenue: { concept: "revenue", tag: "Revenues", quarterly: rev, annual: [], instant: [] } } as unknown as FactsByConcept;
  const metrics = {
    dilution: { sharesOutstanding: { value: 100, accn: "a" }, yoyChangePct: null },
    balance: { netDebt: 0 },
  } as unknown as ComputedMetrics;
  // closes at each TTM end: EV = close×100, ttm=400 → multiple = close/4
  const closes = ["2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2024-12-31", "2025-03-31"].map((d, i) => ({
    date: d,
    close: [8, 12, 16, 20, 4, 6][i]!,
  }));
  const ranges = historicalMultipleRanges(closes, metrics, facts);
  const evs = ranges.find((r) => r.metric === "EV/Sales");
  assert.ok(evs, "EV/Sales range should exist");
  // 8 quarters → 5 TTM ends (2025-03-31 … 2026-03-31); 2024-12-31 close unused.
  assert.equal(evs.n, 5);
  assert.equal(evs.p50, 3); // multiples: 1.5, 2, 3, 4, 5 → median 3
});

test("historical EV uses the share count OF THAT TIME, not today's", () => {
  // Heavy diluter: 50 shares historically, 100 today. Same $8 close at the
  // 2025-06-30 TTM end must produce cap 400 (not 800) → multiple 1, not 2.
  const rev = ["2024-06-30", "2024-09-30", "2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31"].map((d) => q(d, 100));
  const facts = {
    revenue: { concept: "revenue", tag: "Revenues", quarterly: rev, annual: [], instant: [] },
    sharesOutstanding: {
      concept: "sharesOutstanding",
      tag: "EntityCommonStockSharesOutstanding",
      quarterly: [],
      annual: [],
      instant: [
        { end: "2025-06-30", val: 50, accn: "a" },
        { end: "2026-03-31", val: 100, accn: "a" },
      ],
    },
  } as unknown as FactsByConcept;
  const metrics = {
    dilution: { sharesOutstanding: { value: 100, accn: "a" }, yoyChangePct: null },
    balance: { netDebt: 0 },
  } as unknown as ComputedMetrics;
  const ranges = historicalMultipleRanges(
    [
      { date: "2025-06-30", close: 8 },
      { date: "2025-09-30", close: 8 },
      { date: "2025-12-31", close: 8 },
      { date: "2026-03-31", close: 8 },
      { date: "2025-03-31", close: 8 },
    ],
    metrics,
    facts,
  );
  const evs = ranges.find((r) => r.metric === "EV/Sales")!;
  // At 2025-06-30 shares≈50 → 8×50/400 = 1; at 2026-03-31 shares=100 → 2.
  assert.ok(evs.p25 < 1.5, `p25 ${evs.p25} should reflect the historical (smaller) share count`);
  assert.ok(evs.p75 >= 1.5, `p75 ${evs.p75} should reflect today's diluted count`);
});
