import assert from "node:assert/strict";
import { test } from "node:test";
import { computeEconomicView, presentValue, solveImpliedGrowth } from "./economics.js";
import type { ComputedMetrics } from "./metrics.js";

const metrics = (over: Partial<{ ebit: number | null; fcf: number | null; revenue: number | null; equity: number; debt: number }> = {}): ComputedMetrics =>
  ({
    dilution: { sharesOutstanding: { value: 100_000_000, accn: "a" }, yoyChangePct: null },
    balance: {
      netDebt: 1_000_000_000,
      netDebtToEbitdaTtm: null,
      equityBook: { value: over.equity ?? 8_000_000_000, accn: "a" },
      totalDebt: { value: over.debt ?? 2_000_000_000, accn: "a" },
      cashAndSti: { value: 1_000_000_000, accn: "a" },
    },
    margins: { fcfPct: { latestPct: 10, qoqBp: null, yoyBp: null, accn: "a" } },
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

test("ROIC computed from NOPAT over invested capital", () => {
  // NOPAT = 2B × 0.79 = 1.58B; invested = 8B + 2B − 1B = 9B → 17.6%
  const v = computeEconomicView(50, metrics(), null);
  assert.equal(v.roicPct, 17.6);
});

test("street growth takes the conservative min of revenue and EPS growth", () => {
  const v = computeEconomicView(50, metrics(), 11_200_000_000, 4); // rev +12%, eps +4%
  assert.equal(v.streetGrowthPct, 4);
  assert.equal(v.growthProxy, "min(revenue, eps)");
});

test("unprofitable + no EPS estimate → revenue growth halved, not trusted", () => {
  const m = metrics();
  (m.ttm as { netIncome: number | null }).netIncome = -200_000_000;
  const v = computeEconomicView(50, m, 11_200_000_000, null); // rev +12%, no eps
  assert.equal(v.streetGrowthPct, 6); // 12 × 0.5
  assert.ok(v.growthProxy!.includes("penalized"));
});

test("risk tiers move the discount rate, and markers stack", () => {
  // default metrics: $50 × 100M = $5B cap, fcf margin 10 → base 10%
  assert.equal(computeEconomicView(50, metrics(), null).discountRatePctUsed, 10);
  // mega-cap, profitable, low leverage → 8%
  assert.equal(computeEconomicView(1_500, metrics(), null).discountRatePctUsed, 8);
  // small cap (<$5B) → 12%
  assert.equal(computeEconomicView(20, metrics(), null).discountRatePctUsed, 12);
  // small cap + thin FCF margin → penalties stack to 14%
  const risky = metrics();
  (risky.margins as { fcfPct: { latestPct: number } }).fcfPct.latestPct = 2;
  assert.equal(computeEconomicView(20, risky, null).discountRatePctUsed, 14);
});

test("cyclical peak: EPV and implied growth use min(TTM, 5y average)", () => {
  const m = metrics();
  // Peak year: TTM EBIT 2B, but 5y average only 1B → EPV must use 1B.
  (m.ttm as Record<string, number | null>).ebitAvg5y = 1_000_000_000;
  (m.ttm as Record<string, number | null>).fcfAvg5y = 500_000_000; // TTM fcf 1B
  const v = computeEconomicView(50, m, null);
  // 1B × 0.79 / 0.10 = 7.9B − 1B debt = 6.9B / 100M = $69 (was $148 on TTM)
  assert.equal(v.epvPerShare, 69);
});

test("net-cash company: invested capital floored at PP&E, ROIC stays meaningful", () => {
  const m = metrics({ equity: 10_000_000_000, debt: 0 });
  (m.balance as Record<string, unknown>).cashAndSti = { value: 12_000_000_000, accn: "a" }; // cash > E+D
  (m.balance as Record<string, unknown>).ppe = { value: 4_000_000_000, accn: "a" };
  const v = computeEconomicView(50, m, null);
  // invested = max(10+0−12, 4) = 4B → ROIC = 1.58B/4B = 39.5%, not negative
  assert.equal(v.roicPct, 39.5);
});

test("no positive FCF → implied growth incomputable; EPV falls back through EBIT", () => {
  const v = computeEconomicView(50, metrics({ fcf: -100_000_000 }), null);
  assert.equal(v.impliedGrowthPct, null);
  assert.equal(v.epvPerShare, 148); // EBIT branch still works
  const v2 = computeEconomicView(50, metrics({ fcf: -100_000_000, ebit: -50_000_000 }), null);
  assert.equal(v2.epvPerShare, null);
});
