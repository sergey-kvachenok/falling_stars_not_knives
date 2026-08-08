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

function bundle(
  over: {
    price?: number;
    netDebt?: number;
    nde?: number | null;
    fcf?: number;
    fcfMarginPct?: number | null;
    sanity?: "high" | "degraded";
    economics?: Record<string, unknown>;
  } = {},
): TickerBundle {
  return {
    ticker: "T",
    cik: 1,
    builtAt: "",
    company: { name: "T Co", sic: "1", sicDescription: "", isDomesticFiler: true },
    drop: {
      price: over.price ?? 50,
      ...(over.economics
        ? { economics: over.economics as unknown as import("./economics.js").EconomicView }
        : {}),
    },
    documents: { recent8Ks: [], latestQuarterly: null },
    metrics: {
      dilution: { sharesOutstanding: { value: 100_000_000, accn: "a" }, yoyChangePct: null },
      balance: { netDebt: over.netDebt ?? -100_000_000, netDebtToEbitdaTtm: over.nde ?? null },
      margins: { fcfPct: over.fcfMarginPct != null ? { latestPct: over.fcfMarginPct } : null },
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

test("indebted cash-burner cannot sneak past the debt gate via negative EBITDA", () => {
  // $500M net debt, negative EBITDA → nde is null by construction (metrics
  // only compute the ratio when EBITDA > 0), so the low-debt gate must fail.
  const g = digestGate(bundle({ netDebt: 500_000_000, nde: null }), verdict());
  assert.ok(g.reasons.some((r) => r.includes("debt too high")), g.reasons.join(";"));
});

test("ROIC gate: negative-spread names fail, fat FCF margin bypasses (R&D-heavy compounders)", () => {
  const eco = { roicPct: 5, discountRatePctUsed: 10 };
  const fails = digestGate(bundle({ economics: eco, fcfMarginPct: 8 }), verdict());
  assert.ok(fails.reasons.some((r) => r.includes("growth destroys value")), fails.reasons.join(";"));
  const bypassed = digestGate(bundle({ economics: eco, fcfMarginPct: 22 }), verdict());
  assert.ok(!bypassed.reasons.some((r) => r.includes("growth destroys value")), bypassed.reasons.join(";"));
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
