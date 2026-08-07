import { config } from "../config.js";
import { generateJson } from "./provider.js";
import { VERDICT_SCHEMA, type Verdict } from "./schemas.js";
import { validateVerdict } from "./validate.js";
import { collectValidSources } from "./prompts.js";
import type { TickerBundle } from "../bundle/build.js";

// Improvement #3: median-of-three valuations. The deep pass produces one
// draw of scenario assumptions; sampling the valuation three times on a
// compact numbers-only prompt and taking per-scenario medians kills outlier
// draws — same self-consistency trick that stabilized classification.
// Text (drivers, falsifiers) comes from the first valid sample; only the
// numbers are median-merged.

const VALUATION_SCHEMA = {
  type: "OBJECT",
  properties: { scenarios: (VERDICT_SCHEMA.properties as Record<string, unknown>).scenarios },
  required: ["scenarios"],
} as const;

type Scenarios = Verdict["scenarios"];

export async function valuationEnsemble(bundle: TickerBundle, verdict: Verdict): Promise<Scenarios> {
  const prompt = buildValuationPrompt(bundle, verdict);
  const validSources = collectValidSources(bundle);
  const samples: Scenarios[] = [verdict.scenarios]; // deep-pass draw counts as sample 1

  for (let i = 1; i < config.llm.valuationSamples; i++) {
    try {
      const res = await generateJson<{ scenarios: Scenarios }>(prompt, VALUATION_SCHEMA, { temperature: 0.9 });
      const check = validateVerdict({ ...verdict, scenarios: res.scenarios }, validSources, bundle.metrics, bundle.drop);
      const scenarioProblems = check.problems.filter((p) => !p.includes("keyFacts"));
      if (scenarioProblems.length === 0) samples.push(res.scenarios);
    } catch {
      // a failed sample just shrinks the ensemble
    }
  }
  if (samples.length === 1) return verdict.scenarios;

  return verdict.scenarios.map((base) => {
    const peers = samples
      .map((s) => s.find((x) => x.horizonYears === base.horizonYears && x.scenarioCase === base.scenarioCase))
      .filter((x): x is Scenarios[number] => x !== undefined && x.valuationAnchor.metric === base.valuationAnchor.metric);
    if (peers.length < 2) return base;
    return {
      ...base,
      narrativeWeight: median(peers.map((p) => p.narrativeWeight)),
      valuationAnchor: {
        ...base.valuationAnchor,
        multiple: median(peers.map((p) => p.valuationAnchor.multiple)),
        assumedMetricValueUsd: median(peers.map((p) => p.valuationAnchor.assumedMetricValueUsd)),
      },
    };
  });
}

function buildValuationPrompt(bundle: TickerBundle, verdict: Verdict): string {
  const ranges = bundle.drop?.multipleRanges ?? [];
  return `You are re-deriving ONLY the valuation scenarios for ${bundle.ticker} (${bundle.company.name}).
Context (already established): drop cause ${verdict.dropCause.primary}; thesis: ${verdict.oneLineThesis}
Guidance read: ${verdict.guidanceRead.change} (${verdict.guidanceRead.timingVsDemand}) — "${verdict.guidanceRead.evidence.slice(0, 200)}"

COMPUTED METRICS: ${JSON.stringify(bundle.metrics)}
${ranges.length > 0 ? `HISTORICAL MULTIPLE RANGES (stay inside; bear≈p25, base≈p50, bull≈p75):\n${ranges.map((r) => `  ${r.metric}: p25 ${r.p25} / p50 ${r.p50} / p75 ${r.p75}`).join("\n")}` : ""}
${bundle.drop?.streetRevenue1yUsd ? `STREET next-FY revenue consensus: ${bundle.drop.streetRevenue1yUsd}` : ""}

RULES: multiples from the ranges above when present; assumed metric values in absolute USD;
1y sales assumptions must engage the street consensus; negative-earnings companies never use
P/E; every scenario priceable; falsifiers must be concrete 90-day observables.
Produce bear/base/bull at 1y and 3y (exactly 6).`;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return Math.round(m * 10000) / 10000;
};
