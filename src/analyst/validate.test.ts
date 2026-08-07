import assert from "node:assert/strict";
import { test } from "node:test";
import { majority, bundleHash } from "./analyze.js";
import { validateClassification, validateVerdict } from "./validate.js";
import type { Verdict } from "./schemas.js";
import type { TickerBundle } from "../bundle/build.js";

const VALID = new Set(["0001-26-000001", "revenue", "cfo", "screen"]);

const scenario = (h: "1" | "3", c: string, falsifier: string) => ({
  horizonYears: h,
  scenarioCase: c,
  narrativeWeight: 0.33,
  drivers: ["driver"],
  valuationAnchor: {
    metric: "EV/EBITDA" as const,
    multiple: 10,
    assumedMetricValueUsd: 1_000_000_000,
    rationale: "sector median",
  },
  falsifier,
});

const GOOD_FALSIFIER = "Q3 gross margin printed below 40% in the next 10-Q filing";
const sixScenarios = (["1", "3"] as const).flatMap((h) =>
  ["bear", "base", "bull"].map((c) => scenario(h, c, GOOD_FALSIFIER)),
);

const goodVerdict = (): Verdict => ({
  insufficientEvidence: false,
  dropCause: { primary: "thesis_breaking", secondary: "none", rationale: "guidance cut", sources: ["0001-26-000001"] },
  oneLineThesis: "guidance cut on demand weakness",
  changeSincePrior: "first look",
  moat: { assessment: "narrow" as const, rationale: "high switching costs evident in retention" },
  keyFacts: [{ fact: "revenue fell", source: "revenue" }],
  managementLanguage: { observations: ["hedging"], sources: ["0001-26-000001"] },
  guidanceRead: { change: "lowered", timingVsDemand: "demand", evidence: "we now expect…", source: "0001-26-000001" },
  reconciliation: [],
  anomalies: [],
  scenarios: sixScenarios,
});

test("valid verdict passes", () => {
  assert.equal(validateVerdict(goodVerdict(), VALID).ok, true);
});

test("uncited source is rejected", () => {
  const v = goodVerdict();
  v.keyFacts.push({ fact: "made up", source: "0009-99-999999" });
  const r = validateVerdict(v, VALID);
  assert.equal(r.ok, false);
  assert.deepEqual(r.badSources, ["0009-99-999999"]);
});

test("vague falsifier is rejected", () => {
  const v = goodVerdict();
  v.scenarios[0]!.falsifier = "investor sentiment improves";
  const r = validateVerdict(v, VALID);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes("vague falsifier")));
});

test("incomplete scenario grid is rejected", () => {
  const v = goodVerdict();
  v.scenarios = v.scenarios.slice(0, 4);
  const r = validateVerdict(v, VALID);
  assert.ok(r.problems.some((p) => p.includes("scenarios must cover")));
});

test("reconciliation without a verbatim quote is rejected", () => {
  const v = goodVerdict();
  v.reconciliation.push({ discrepancy: "story vs cash", factSource: "cfo", managementQuote: "n/a", quoteSource: "0001-26-000001" });
  const r = validateVerdict(v, VALID);
  assert.ok(r.problems.some((p) => p.includes("verbatim")));
});

test("classification without sources rejected unless insufficient_evidence", () => {
  const bad = validateClassification(
    { primary: "sentiment", secondary: "none", rationale: "vibes", sources: [] },
    VALID,
  );
  assert.equal(bad.ok, false);
  const ok = validateClassification(
    { primary: "insufficient_evidence", secondary: "none", rationale: "no filing in window", sources: [] },
    VALID,
  );
  assert.equal(ok.ok, true);
});

test("majority vote and agreement", () => {
  assert.deepEqual(majority(["sentiment", "sentiment", "mechanical"]), { winner: "sentiment", agreement: 2 / 3 });
  assert.deepEqual(majority(["a", "a", "a"]), { winner: "a", agreement: 1 });
});

test("bundle hash ignores drop context and builtAt, changes on new filing", () => {
  const base: TickerBundle = {
    ticker: "TEST",
    cik: 1,
    builtAt: "2026-08-07T00:00:00Z",
    company: { name: "Test Co", sic: "1", sicDescription: "Test", isDomesticFiler: true },
    drop: { dayChangePct: -20 },
    documents: {
      recent8Ks: [
        { accession: "0001-26-000001", form: "8-K", filedAt: "2026-08-01", items: ["2.02"], file: "x.htm", kind: "press-release", text: "t", truncated: false, url: "u" },
      ],
      latestQuarterly: null,
    },
    metrics: {} as TickerBundle["metrics"],
    sanity: { confidence: "high", flags: [] },
    facts: { revenue: { tag: "Revenues" } },
  };
  const sameFilingsNextDay: TickerBundle = { ...base, builtAt: "2026-08-08T00:00:00Z", drop: { dayChangePct: -3 } };
  assert.equal(bundleHash(base), bundleHash(sameFilingsNextDay));

  const newFiling: TickerBundle = {
    ...base,
    documents: { ...base.documents, recent8Ks: [{ ...base.documents.recent8Ks[0]!, accession: "0001-26-000002" }] },
  };
  assert.notEqual(bundleHash(base), bundleHash(newFiling));
});
