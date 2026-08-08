import assert from "node:assert/strict";
import { test } from "node:test";
import { computeEconomicView, presentValue, solveImpliedGrowth } from "./economics.js";
import type { ComputedMetrics } from "./metrics.js";

const metrics = (over: Partial<{ ebit: number | null; fcf: number | null; revenue: number | null }> = {}): ComputedMetrics =>
  ({
    dilution: { sharesOutstanding: { value: 100_000_000, accn: "a" }, yoyChangePct: null },
    balance: { netDebt: 1_000_000_000 },
    ttm: {
      revenue: over.revenue ?? 10_000_000_000,
      ebitda: null,
      ebit: over.ebit === undefined ? 2_000_000_000 : over.ebit,
      netIncome: null,
      fcf: over.fcf === undefined ? 1_000_000_000 : over.fcf,
    },
  }) as unknown as ComputedMetrics;

test("EPV: after-tax EBIT capitalized minus net debt, per share", () => {
  // 2B × 0.79 / 0.10 = 15.8B − 1B debt = 14.8B / 100M shares = $148
  const v = computeEconomicView(50, metrics(), null);
  assert.equal(v.epvPerShare, 148);
});

test("reverse DCF: solving recovers a known growth rate", () => {
  // Price the company exactly at PV(fcf0=1B, g=5%) → solver must return ~5%
  const pv = presentValue(1_000_000_000, 0.05, 0.1, 0.025, 10);
  const g = solveImpliedGrowth(1_000_000_000, pv, 0.1, 0.025, 10);
  assert.ok(g !== null && Math.abs(g - 0.05) < 0.001, `got ${g}`);
});

test("expectations gap: implied vs street", () => {
  // Set the price so implied growth ≈ 0%, street growth = 12%.
  const pvAtZero = presentValue(1_000_000_000, 0, 0.1, 0.025, 10);
  const price = pvAtZero / 100_000_000;
  const v = computeEconomicView(price, metrics(), 11_200_000_000); // street = TTM×1.12
  assert.ok(v.impliedGrowthPct !== null && Math.abs(v.impliedGrowthPct) < 0.5, `implied ${v.impliedGrowthPct}`);
  assert.equal(v.streetGrowthPct, 12);
  assert.ok(v.expectationsGapPts! > 11, `gap ${v.expectationsGapPts}`);
});

test("no positive FCF → implied growth incomputable; EPV falls back through EBIT", () => {
  const v = computeEconomicView(50, metrics({ fcf: -100_000_000 }), null);
  assert.equal(v.impliedGrowthPct, null);
  assert.equal(v.epvPerShare, 148); // EBIT branch still works
  const v2 = computeEconomicView(50, metrics({ fcf: -100_000_000, ebit: -50_000_000 }), null);
  assert.equal(v2.epvPerShare, null);
});
