import type { Classification, Verdict } from "./schemas.js";
import { impliedPrice, ttmActualFor } from "../compute/anchors.js";
import type { ComputedMetrics } from "../compute/metrics.js";

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

export function validateVerdict(v: Verdict, valid: Set<string>, metrics?: ComputedMetrics): ValidationResult {
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
    }
  }
  for (const r of v.reconciliation) {
    if (r.managementQuote.trim().length < 15) {
      problems.push("reconciliation entry lacks a verbatim management quote");
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
