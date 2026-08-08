import type { Classification, Verdict } from "./schemas.js";
import { impliedPrice, ttmActualFor } from "../compute/anchors.js";
import type { ComputedMetrics } from "../compute/metrics.js";
import type { TickerBundle } from "../bundle/build.js";

// Citation validation (PLAN.md §7.5): the model has seen these tickers
// thousands of times in training and will import priors. Every cited source
// must exist in the bundle; claims that don't survive are grounds for a
// retry, and after the retry cap the ticker is recorded as validation_failed.

export interface ValidationResult {
  ok: boolean;
  badSources: string[];
  problems: string[];
}

export function validateClassification(c: Classification, valid: Set<string>): ValidationResult {
  const badSources = c.sources.filter((s) => !valid.has(s));
  const problems: string[] = [];
  if (c.primary !== "insufficient_evidence" && c.sources.length === 0) {
    problems.push("a cause classification must cite at least one source");
  }
  return { ok: badSources.length === 0 && problems.length === 0, badSources, problems };
}

const VAGUE_FALSIFIER = /sentiment|momentum|investor confidence|market recovers|stock (price )?(recovers|rebounds)/i;

export function validateVerdict(
  v: Verdict,
  valid: Set<string>,
  metrics?: ComputedMetrics,
  drop?: TickerBundle["drop"],
): ValidationResult {
  const cited: string[] = [
    ...v.dropCause.sources,
    ...v.keyFacts.map((f) => f.source),
    ...v.managementLanguage.sources,
    ...v.reconciliation.flatMap((r) => [r.factSource, r.quoteSource]),
  ];
  if (v.guidanceRead.change !== "none_given" && v.guidanceRead.source) {
    cited.push(v.guidanceRead.source);
  }
  const badSources = [...new Set(cited.filter((s) => !valid.has(s)))];

  const problems: string[] = [];
  if (!v.insufficientEvidence && v.keyFacts.length === 0) {
    problems.push("keyFacts is empty but insufficientEvidence is false");
  }
  const combos = new Set(v.scenarios.map((s) => `${s.horizonYears}-${s.scenarioCase}`));
  const expected = ["1-bear", "1-base", "1-bull", "3-bear", "3-base", "3-bull"];
  if (combos.size !== 6 || !expected.every((e) => combos.has(e))) {
    problems.push(`scenarios must cover exactly bear/base/bull at 1y and 3y (got ${[...combos].join(", ")})`);
  }
  for (const s of v.scenarios) {
    if (VAGUE_FALSIFIER.test(s.falsifier) || s.falsifier.length < 20) {
      problems.push(`vague falsifier for ${s.horizonYears}y ${s.scenarioCase}: "${s.falsifier}"`);
    }
    // Management's own guidance is a bar management sets — clearing it tests
    // nothing. Base/bull kill-switches need independent benchmarks.
    if (
      (s.scenarioCase === "base" || s.scenarioCase === "bull") &&
      /guidance|management'?s? (guide|outlook|forecast|target)/i.test(s.falsifier)
    ) {
      problems.push(
        `${s.horizonYears}y ${s.scenarioCase} kill-switch uses management guidance as the bar — tie it to year-over-year growth or an independent benchmark instead`,
      );
    }
    const a = s.valuationAnchor;
    // A card without numbers is useless: every scenario must price unless the
    // verdict is insufficient_evidence (shares availability permitting).
    const canPrice = metrics?.dilution.sharesOutstanding?.value;
    if (!v.insufficientEvidence && canPrice) {
      if (a.metric === "none") {
        problems.push(
          `scenario ${s.horizonYears}y ${s.scenarioCase} has metric "none" — pick a priceable metric (EV/Sales or P/S always works)`,
        );
      } else if (metrics && impliedPrice(a, metrics) === null) {
        problems.push(
          `anchor for ${s.horizonYears}y ${s.scenarioCase} does not price (${a.multiple}× ${a.metric}) — choose a metric the financials support`,
        );
      }
    }
    if (a.metric !== "none") {
      if (a.multiple <= 0 || a.multiple > 500) {
        problems.push(`implausible multiple ${a.multiple} for ${s.horizonYears}y ${s.scenarioCase}`);
      }
      // Anchor assumptions must stay tethered to reality: within 0.1×–10× of
      // the TTM actual when one exists.
      const actual = metrics ? ttmActualFor(a.metric, metrics) : null;
      if (actual !== null && actual > 0) {
        const ratio = a.assumedMetricValueUsd / actual;
        if (ratio < 0.1 || ratio > 10) {
          problems.push(
            `assumed ${a.metric} value ${a.assumedMetricValueUsd} is ${ratio.toFixed(1)}× the TTM actual (${actual}) for ${s.horizonYears}y ${s.scenarioCase} — check units (absolute USD, not millions)`,
          );
        }
      }
      // Empirical bound #1: the multiple must live near the company's own
      // historical range when one exists.
      const range = drop?.multipleRanges?.find((r) => r.metric === a.metric);
      if (range && (a.multiple < range.p25 * 0.6 || a.multiple > range.p75 * 1.6)) {
        problems.push(
          `multiple ${a.multiple}× ${a.metric} for ${s.horizonYears}y ${s.scenarioCase} is far outside the historical range (p25 ${range.p25} – p75 ${range.p75}) — stay inside it or pick a different metric`,
        );
      }
      // Empirical bound #2: 1y sales assumptions must stay near street consensus.
      const street = drop?.streetRevenue1yUsd;
      if (
        street &&
        s.horizonYears === "1" &&
        (a.metric === "EV/Sales" || a.metric === "P/S") &&
        (a.assumedMetricValueUsd < street * 0.6 || a.assumedMetricValueUsd > street * 1.4)
      ) {
        problems.push(
          `1y assumed revenue ${a.assumedMetricValueUsd} strays >40% from street consensus (${street}) for ${s.scenarioCase} — align with it or argue against it with a tighter number`,
        );
      }
    }
  }
  for (const r of v.reconciliation) {
    if (r.managementQuote.trim().length < 15) {
      problems.push("reconciliation entry lacks a verbatim management quote");
    }
  }

  // Bear realism: a bear case above today's price claims riskless upside.
  // The market's price IS a plausible bear for a just-crashed stock.
  const price = drop?.price;
  if (metrics && price && !v.insufficientEvidence) {
    const bear1 = v.scenarios.find((s) => s.horizonYears === "1" && s.scenarioCase === "bear");
    const bearImplied = bear1 ? impliedPrice(bear1.valuationAnchor, metrics) : null;
    if (bearImplied !== null && bearImplied > price * 1.15) {
      problems.push(
        `1y bear implies $${bearImplied} — ${Math.round((bearImplied / price - 1) * 100)}% ABOVE the current $${price.toFixed(2)}. ` +
          `A bear case must be genuinely bearish: multiple at or below today's, fundamentals missing expectations.`,
      );
    }
  }

  // Narrative weights must be a distribution, not free-floating enthusiasm.
  for (const h of ["1", "3"] as const) {
    const sum = v.scenarios.filter((s) => s.horizonYears === h).reduce((a, s) => a + s.narrativeWeight, 0);
    if (sum < 0.85 || sum > 1.15) {
      problems.push(`${h}y scenario weights sum to ${sum.toFixed(2)} — they must sum to ~1.0`);
    }
  }

  // Multiple fade: businesses mature and multiples compress — a 3y multiple
  // above the 1y multiple (same metric, same case) assumes re-expansion on
  // top of growth, double-counting the bull thesis.
  for (const cs of ["bear", "base", "bull"]) {
    const s1 = v.scenarios.find((s) => s.horizonYears === "1" && s.scenarioCase === cs);
    const s3 = v.scenarios.find((s) => s.horizonYears === "3" && s.scenarioCase === cs);
    if (
      s1 &&
      s3 &&
      s1.valuationAnchor.metric !== "none" &&
      s1.valuationAnchor.metric === s3.valuationAnchor.metric &&
      s3.valuationAnchor.multiple > s1.valuationAnchor.multiple * 1.1
    ) {
      problems.push(
        `${cs}: 3y multiple ${s3.valuationAnchor.multiple}× exceeds 1y ${s1.valuationAnchor.multiple}× — multiples fade as businesses mature; growth belongs in the metric value, not the multiple`,
      );
    }
  }

  // Cross-horizon coherence: the 1y and 3y paths must describe the same
  // company. Metric-switching (EV/Sales at 1y, P/E on early earnings at 3y)
  // produced a 3y base at a third of the 1y base — each plausible alone,
  // nonsense together. Rule: implied(3y) ≥ 0.7 × implied(1y) per case;
  // genuine decline stories must show up in BOTH horizons.
  if (metrics && !v.insufficientEvidence) {
    for (const cs of ["bear", "base", "bull"]) {
      const s1 = v.scenarios.find((s) => s.horizonYears === "1" && s.scenarioCase === cs);
      const s3 = v.scenarios.find((s) => s.horizonYears === "3" && s.scenarioCase === cs);
      const p1 = s1 ? impliedPrice(s1.valuationAnchor, metrics) : null;
      const p3 = s3 ? impliedPrice(s3.valuationAnchor, metrics) : null;
      if (p1 !== null && p3 !== null && p3 < p1 * 0.7) {
        problems.push(
          `incoherent trajectory for "${cs}": 3y implies $${p3} but 1y implies $${p1} — the horizons must tell one story. ` +
            `Use the same metric family across horizons, or if the business genuinely shrinks by year 3, lower the 1y value too.`,
        );
      }
    }
  }
  return { ok: badSources.length === 0 && problems.length === 0, badSources, problems };
}

export function retryFeedback(result: ValidationResult): string {
  const parts: string[] = [];
  if (result.badSources.length > 0) {
    parts.push(
      `VALIDATION ERROR — these cited sources are NOT in the bundle: ${result.badSources.join(", ")}. ` +
        `Cite only values from CITABLE SOURCES, exactly as written.`,
    );
  }
  if (result.problems.length > 0) {
    parts.push(`VALIDATION ERROR — ${result.problems.join("; ")}.`);
  }
  parts.push("Re-emit the complete corrected JSON.");
  return parts.join("\n");
}
