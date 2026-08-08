import assert from "node:assert/strict";
import { test } from "node:test";
import { digestGate } from "./quality.js";
import type { TickerBundle } from "../bundle/build.js";
import type { Verdict } from "../analyst/schemas.js";

const scenario = (h: "1" | "3", c: string, weight: number, multiple: number) => ({
  horizonYears: h,
  scenarioCase: c,
  narrativeWeight: weight,
  drivers: ["d"],
  valuationAnchor: { metric: "P/E" as const, multiple, assumedMetricValueUsd: 1_000_000_000, rationale: "r" },
  falsifier: "Q3 revenue growth below 3% year-over-year printed",
});

function bundle(over: { price?: number; netDebt?: number; fcf?: number; sanity?: "high" | "degraded" } = {}): TickerBundle {
  return {
    ticker: "T",
    cik: 1,
    builtAt: "",
    company: { name: "T Co", sic: "1", sicDescription: "", isDomesticFiler: true },
    drop: { price: over.price ?? 50 },
    documents: { recent8Ks: [], latestQuarterly: null },
    metrics: {
      dilution: { sharesOutstanding: { value: 100_000_000, accn: "a" }, yoyChangePct: null },
      balance: { netDebt: over.netDebt ?? -100_000_000, netDebtToEbitdaTtm: null },
      ttm: { fcf: over.fcf ?? 500_000_000 },
    } as unknown as TickerBundle["metrics"],
    sanity: { confidence: over.sanity ?? "high", flags: [] },
    facts: {},
  };
}

function verdict(moat: Verdict["moat"]["assessment"] = "narrow"): Verdict {
  return {
    insufficientEvidence: false,
    dropCause: { primary: "sentiment", secondary: "none", rationale: "", sources: ["revenue"] },
    oneLineThesis: "t",
    changeSincePrior: "first look",
    moat: { assessment: moat, rationale: "r" },
    keyFacts: [],
    managementLanguage: { observations: [], sources: [] },
    guidanceRead: { change: "maintained", timingVsDemand: "not_applicable", evidence: "", source: "" },
    reconciliation: [],
    anomalies: [],
    // fair value = 10× $1B / 100M shares = $100 across all scenarios
    scenarios: (["1", "3"] as const).flatMap((h) =>
      ["bear", "base", "bull"].map((c) => scenario(h, c, 1 / 3, 10)),
    ),
  };
}

test("healthy + 50% undervalued passes", () => {
  const g = digestGate(bundle({ price: 50 }), verdict()); // fair $100
  assert.equal(g.pass, true, g.reasons.join(";"));
  assert.equal(g.fairValue, 100);
  assert.equal(g.undervaluationPct, 50);
});

test("only 10% undervalued fails the 20% bar", () => {
  const g = digestGate(bundle({ price: 90 }), verdict());
  assert.equal(g.pass, false);
  assert.ok(g.reasons.some((r) => r.includes("below fair value")));
});

test("negative free cash flow fails", () => {
  const g = digestGate(bundle({ fcf: -50_000_000 }), verdict());
  assert.ok(g.reasons.some((r) => r.includes("free cash flow")));
});

test("fair value far above street target fails the winner's-curse guard", () => {
  const b = bundle({ price: 50 });
  b.drop!.analystTargetPrice = 40; // fair $100 = 2.5× street
  const g = digestGate(b, verdict());
  assert.ok(g.reasons.some((r) => r.includes("street target")), g.reasons.join(";"));
});

test("no moat fails; degraded metrics fail", () => {
  assert.ok(digestGate(bundle(), verdict("none")).reasons.some((r) => r.startsWith("moat")));
  assert.ok(digestGate(bundle({ sanity: "degraded" }), verdict()).reasons.some((r) => r.includes("degraded")));
});
