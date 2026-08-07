import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConceptSeries, FactsByConcept } from "../edgar/companyfacts.js";
import { computeMetrics } from "./metrics.js";
import { sanityCheck } from "./sanity.js";

const q = (end: string, val: number): { start: string; end: string; val: number; accn: string; derived: "direct" } => ({
  start: end.slice(0, 8) + "01",
  end,
  val,
  accn: "acc-1",
  derived: "direct",
});

const inst = (end: string, val: number) => ({ end, val, accn: "acc-1" });

function makeSeries(overrides: Partial<Record<string, Partial<ConceptSeries>>> = {}): FactsByConcept {
  const base: FactsByConcept = {
    revenue: {
      concept: "revenue",
      tag: "Revenues",
      quarterly: [q("2025-06-30", 100), q("2025-09-30", 100), q("2025-12-31", 105), q("2026-03-31", 108), q("2026-06-30", 110)],
      annual: [],
      instant: [],
    },
    operatingIncome: {
      concept: "operatingIncome",
      tag: "OperatingIncomeLoss",
      quarterly: [q("2025-09-30", 20), q("2025-12-31", 21), q("2026-03-31", 20), q("2026-06-30", 22)],
      annual: [],
      instant: [],
    },
    cfo: {
      concept: "cfo",
      tag: "NetCashProvidedByUsedInOperatingActivities",
      quarterly: [q("2026-03-31", 25), q("2026-06-30", 26)],
      annual: [],
      instant: [],
    },
    assets: { concept: "assets", tag: "Assets", quarterly: [], annual: [], instant: [inst("2026-06-30", 1000)] },
    liabilities: { concept: "liabilities", tag: "Liabilities", quarterly: [], annual: [], instant: [inst("2026-06-30", 600)] },
    equity: { concept: "equity", tag: "StockholdersEquity", quarterly: [], annual: [], instant: [inst("2026-06-30", 400)] },
  };
  for (const [name, patch] of Object.entries(overrides)) {
    base[name] = { ...(base[name] ?? { concept: name, tag: null, quarterly: [], annual: [], instant: [] }), ...patch } as ConceptSeries;
  }
  return base;
}

test("clean input → high confidence, no flags", () => {
  const series = makeSeries();
  const result = sanityCheck(series, computeMetrics(series));
  assert.equal(result.confidence, "high");
  assert.deepEqual(result.flags, []);
});

test("balance identity violation is flagged", () => {
  const series = makeSeries({ equity: { instant: [inst("2026-06-30", 300)] } }); // 600+300 ≠ 1000
  const result = sanityCheck(series, computeMetrics(series));
  assert.equal(result.confidence, "degraded");
  assert.ok(result.flags.some((f) => f.startsWith("balance-identity")));
});

test("phantom revenue discontinuity is flagged, not treated as a finding", () => {
  const series = makeSeries({
    revenue: { quarterly: [q("2025-09-30", 100), q("2025-12-31", 105), q("2026-03-31", 320), q("2026-06-30", 330)] },
  });
  const result = sanityCheck(series, computeMetrics(series));
  assert.equal(result.confidence, "degraded");
  assert.ok(result.flags.some((f) => f.startsWith("continuity")));
});

test("missing quarter in series is flagged as alignment gap", () => {
  const series = makeSeries({
    revenue: { quarterly: [q("2025-09-30", 100), q("2026-03-31", 108), q("2026-06-30", 110)] },
  });
  const result = sanityCheck(series, computeMetrics(series));
  assert.ok(result.flags.some((f) => f.startsWith("alignment")));
});

test("unresolved core concept is flagged as coverage miss", () => {
  const series = makeSeries({ cfo: { tag: null, quarterly: [] } });
  const result = sanityCheck(series, computeMetrics(series));
  assert.ok(result.flags.some((f) => f.includes("'cfo'")));
});

test("metrics: revenue growth, margins, and dilution compute correctly", () => {
  const series = makeSeries({
    sharesOutstanding: {
      concept: "sharesOutstanding",
      tag: "EntityCommonStockSharesOutstanding",
      quarterly: [],
      annual: [],
      instant: [inst("2025-06-30", 100_000_000), inst("2026-06-30", 110_000_000)],
    },
  });
  const m = computeMetrics(series);
  assert.equal(m.asOfQuarter, "2026-06-30");
  assert.equal(m.revenue.qoqPct, 1.9); // 108 → 110
  assert.equal(m.revenue.yoyPct, 10); // 100 → 110
  assert.equal(m.margins.operatingPct?.latestPct, 20); // 22/110
  assert.equal(m.dilution.yoyChangePct, 10); // 100M → 110M shares
});
