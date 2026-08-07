import assert from "node:assert/strict";
import { test } from "node:test";
import { entryPrice, impliedPrice, weightedAnchorPrice, type ValuationAnchor } from "./anchors.js";
import type { ComputedMetrics } from "./metrics.js";

const metrics = (over: Partial<{ shares: number; netDebt: number }> = {}): ComputedMetrics =>
  ({
    dilution: { sharesOutstanding: { value: over.shares ?? 100_000_000, accn: "a" }, yoyChangePct: null },
    balance: { netDebt: over.netDebt ?? 500_000_000 },
    ttm: {},
  }) as unknown as ComputedMetrics;

const anchor = (metric: ValuationAnchor["metric"], multiple: number, assumed: number): ValuationAnchor => ({
  metric,
  multiple,
  assumedMetricValueUsd: assumed,
  rationale: "test",
});

test("EV/EBITDA subtracts net debt", () => {
  // 10 × 1B EBITDA = 10B EV − 0.5B net debt = 9.5B equity / 100M shares = $95
  assert.equal(impliedPrice(anchor("EV/EBITDA", 10, 1_000_000_000), metrics()), 95);
});

test("P/E ignores net debt", () => {
  // 20 × 500M earnings = 10B / 100M shares = $100
  assert.equal(impliedPrice(anchor("P/E", 20, 500_000_000), metrics()), 100);
});

test("weighted anchor blends by narrative weight, skips unpriced scenarios", () => {
  const m = metrics({ netDebt: 0 });
  const scenarios = [
    { horizonYears: "1", narrativeWeight: 0.25, valuationAnchor: anchor("P/E", 10, 1_000_000_000) }, // $100
    { horizonYears: "1", narrativeWeight: 0.5, valuationAnchor: anchor("P/E", 20, 1_000_000_000) }, // $200
    { horizonYears: "1", narrativeWeight: 0.25, valuationAnchor: anchor("none", 0, 0) }, // unpriced
    { horizonYears: "3", narrativeWeight: 1, valuationAnchor: anchor("P/E", 99, 1_000_000_000) }, // other horizon
  ];
  // (0.25×100 + 0.5×200) / 0.75 = 166.67
  assert.equal(weightedAnchorPrice(scenarios, m, "1"), 166.67);
  assert.equal(weightedAnchorPrice(scenarios, m, "3"), 990);
});

test("entry price discounts the estimate by the hurdle rate", () => {
  assert.equal(entryPrice(115, 1, 0.15), 100); // 115 / 1.15
  assert.equal(entryPrice(152.09, 3, 0.15), 100); // 152.09 / 1.15³
  assert.equal(entryPrice(null, 1, 0.15), null);
});

test("negative equity value → null, missing shares → null, none → null", () => {
  assert.equal(impliedPrice(anchor("EV/EBITDA", 1, 100_000_000), metrics({ netDebt: 5_000_000_000 })), null);
  assert.equal(impliedPrice(anchor("P/E", 20, 500_000_000), metrics({ shares: 0 })), null);
  assert.equal(impliedPrice(anchor("none", 10, 1_000_000_000), metrics()), null);
});
