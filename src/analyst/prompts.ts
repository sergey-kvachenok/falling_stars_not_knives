import type { TickerBundle } from "../bundle/build.js";
import { diffSinceLastLook } from "../compute/lookdiff.js";
import { priorSourceId, type PriorLook } from "./history.js";

// Prompt construction (PLAN.md §7.3–§7.5). Any change here must bump
// config.llm.promptVersion. `anonymize` supports the Phase-4 A/B test that
// measures prior contamination: same bundle, masked identity.

export interface PromptBundle {
  prompt: string;
  validSources: Set<string>;
}

const RULES = `RULES — read carefully:
- Reason ONLY from the bundle below. You have NO other knowledge about this company; anything
  you remember from elsewhere is contaminated and must not be used.
- Every factual claim must cite a source: an accession number (e.g. 0001628280-26-050401) or a
  concept key (e.g. revenue, cfo) exactly as listed under CITABLE SOURCES. Claims with sources
  not in that list will be rejected.
- If the bundle does not explain the drop, say so: set insufficient_evidence. That is an honest,
  expected outcome — many drops have no filing. Never infer a cause to fill the gap.
- Computed metrics are provided; do NOT recalculate or derive new numbers.
- If sanity confidence is "degraded", do not reason from the flagged values.
- Before flagging a narrative-vs-numbers discrepancy, check the benign explanations first:
  seasonality, one-time items, non-cash charges, deferred revenue timing. Only flag what
  survives that checklist.
- Falsifiers must name a concrete, checkable event within 90 days ("Q3 gross margin below 40%",
  "no new 10%+ customer disclosed in the next 10-Q") — never a vibe ("sentiment improves").
- Scenario weights are narrative weights, not calibrated probabilities.
- Valuation anchors are ASSUMPTIONS, not prices: give the metric, the multiple, and the assumed
  absolute USD value of that metric in that scenario at that horizon (e.g. EBITDA 1200000000 —
  full dollars, never millions). Code computes the implied price; never compute one yourself.
- Every scenario MUST carry a priceable anchor unless you set insufficient_evidence. Pick a
  metric the company's financials can support: negative TTM earnings → never P/E (use EV/Sales
  or P/S); negative EBITDA → never EV/EBITDA. metric "none" is only allowed with
  insufficient_evidence.
- Moat: judge the durability of the business from economics visible in the bundle — margin
  levels and stability, pricing power, switching costs implied by the filings. Be stingy:
  "wide" is rare; when the bundle gives no basis, say "unclear", never guess upward.
- When HISTORICAL MULTIPLE RANGES are provided, choose multiples INSIDE them: bear near or
  below p25, base near p50, bull near p75. Going outside the range requires the rationale to
  say why the market's own history no longer applies.
- When a STREET FORWARD ESTIMATE is provided, 1-year sales-based assumed values must engage
  it: agree with it or explicitly argue against it in the rationale — never ignore it.
- The 1y and 3y scenarios must describe ONE coherent trajectory per case: prefer the same
  metric family at both horizons. Never value a low-margin growth company on sales at 1y and
  then on early-stage earnings at 3y — that produces two different companies. A 3y value far
  below the same case's 1y value is only valid if the 1y path already shows the decline.
- The bear case IS the structural-decline case: assume today's post-drop multiple and today's
  growth rate simply persist. A bear that assumes any recovery is a base case wearing a costume.
- Kill-switches for base and bull must be defined against year-over-year growth or independent
  benchmarks — never against management's own guidance; a bar management sets is not a test.
- When scenarios use P/FCF, check capexPctRevenueTtm: rising capital intensity (e.g. a shift
  to owned infrastructure) suppresses FCF conversion — reflect it in the assumed FCF, and
  prefer a capex-aware falsifier.
- FCF in the computed metrics is AFTER subtracting stock-based compensation — dilution is a
  real cost. Never add SBC back; never treat CFO as owner cash flow.
- You may go BELOW the historical multiple band only by filling regimeShiftJustification with
  the specific structural break (lost patent, secular decline, covenant breach) grounded in
  the filings. There is no override for going above the band.`;

export interface PromptOpts {
  anonymize?: boolean;
  /** Prior verdicts for this ticker — analyst memory (citable as prior:<date>). */
  history?: PriorLook[];
}

export function buildAnalystPrompt(bundle: TickerBundle, opts: PromptOpts = {}): PromptBundle {
  const validSources = collectValidSources(bundle, opts.history);
  const name = opts.anonymize ? "Company A" : `${bundle.ticker} (${bundle.company.name})`;

  const ranges = bundle.drop?.multipleRanges ?? [];
  const current = bundle.drop?.currentMultiples ?? [];
  const currentByMetric = new Map(current.map((c) => [c.metric, c.value]));
  const rangesSection =
    ranges.length > 0
      ? `\nHISTORICAL MULTIPLE RANGES vs TODAY (current shares/net debt approximation):\n${ranges
          .map(
            (r) =>
              `  - ${r.metric}: p25 ${r.p25} / median ${r.p50} / p75 ${r.p75} (n=${r.n})` +
              (currentByMetric.has(r.metric) ? ` — MARKET PAYS TODAY: ${currentByMetric.get(r.metric)}` : ""),
          )
          .join("\n")}
The gap between history and today IS the re-rating the market just applied — it is information,
not an error to fade. Bear multiples belong AT OR BELOW today's multiple; base between today
and the historical median requires naming what specifically recovers; bull near historical
median-to-p75 requires strong filed evidence.\n`
      : "";
  const streetSection =
    bundle.drop?.streetRevenue1yUsd != null
      ? `STREET FORWARD ESTIMATE: consensus next-FY revenue ≈ $${(bundle.drop.streetRevenue1yUsd / 1e9).toFixed(2)}B.\n`
      : "";
  const eco = bundle.drop?.economics;
  const ecoSection = eco
    ? `ECONOMIC VIEW (deterministic, code-computed — 10% discount, 2.5% terminal):
  EPV floor (value at ZERO growth forever): ${eco.epvPerShare !== null ? `$${eco.epvPerShare}/share` : "not computable (no positive earnings)"}
  FCF growth the CURRENT price implies: ${eco.impliedGrowthPct !== null ? `${eco.impliedGrowthPct}%/yr` : "not computable"}
  Street forward revenue growth: ${eco.streetGrowthPct !== null ? `${eco.streetGrowthPct}%` : "unknown"}
Your scenarios must engage this frame: the bull case must name what the market is missing at
the implied growth rate; if the implied growth already matches or exceeds what the filings
support, say so — that is a fairly-priced company, not an opportunity.\n`
    : "";

  const dropDesc = bundle.drop
    ? `day ${fmtPct(bundle.drop.dayChangePct)}, month ${fmtPct(bundle.drop.monthChangePct)}, ` +
      `vs 52-week high ${fmtPct(bundle.drop.fromHighPct)}, triggers: ${bundle.drop.triggers?.join(", ") ?? "?"}`
    : "screen context not attached — analyze the most recent filings for what changed";

  const docs = [
    ...bundle.documents.recent8Ks,
    ...(bundle.documents.latestQuarterly ? [bundle.documents.latestQuarterly] : []),
  ];
  const docSections = docs
    .map(
      (d) =>
        `--- DOCUMENT [${d.accession}] ${d.form} filed ${d.filedAt}` +
        (d.items.length ? ` items ${d.items.join(",")}` : "") +
        ` (${d.kind}${d.truncated ? ", truncated" : ""}) ---\n` +
        maybeMask(d.text, bundle, opts.anonymize),
    )
    .join("\n\n");

  const no8k = bundle.documents.recent8Ks.length === 0
    ? "\nNOTE: no 8-K was filed in the drop window. The bundle may not explain the drop — weigh insufficient_evidence seriously.\n"
    : "";

  const history = opts.history ?? [];
  const latest = history[history.length - 1];
  const computedDiff =
    latest?.snapshot && !opts.anonymize
      ? diffSinceLastLook(latest.snapshot, latest.runDate, latest.refPrice ?? null, bundle)
      : [];
  const priorSection = history.length === 0
    ? ""
    : `\nPRIOR ANALYSES OF THIS COMPANY (your own earlier verdicts — context, not evidence;
cite prior:<date> ONLY for claims about the prior view, filings/concepts for facts):
${history
  .map(
    (h) =>
      `  - [${priorSourceId(h.runDate)}] ${h.classification}` +
      (h.thesis ? ` — ${h.thesis}` : "") +
      (h.falsifierSummary ? ` (falsifiers at 90d: ${h.falsifierSummary})` : ""),
  )
  .join("\n")}
${computedDiff.length > 0 ? `COMPUTED CHANGES SINCE LAST LOOK (code-derived facts — explain the WHY, do not recompute):
${computedDiff.map((l) => `  - ${l}`).join("\n")}\n` : ""}In changeSincePrior, explain what changed versus the most recent prior look and why — a new
filing, a fired falsifier, a reclassification, a state change listed above — or state plainly
that nothing material changed.\n`;

  const prompt = `You are an equity research analyst. A stock dropped sharply and your job is to
explain WHY it dropped — not whether to buy it. This feeds a research queue for a human; the
valuable outputs are the drop-cause classification, genuine anomalies, and concrete falsifiers.

${RULES}

COMPANY: ${name} — SIC ${bundle.company.sicDescription}
DROP CONTEXT: ${dropDesc}
${rangesSection}${streetSection}${ecoSection}${no8k}${priorSection}
CITABLE SOURCES (the only valid citation values):
${[...validSources].map((s) => `  - ${s}`).join("\n")}

COMPUTED METRICS (deterministic, code-derived — sanity confidence: ${bundle.sanity.confidence}):
${bundle.sanity.flags.map((f) => `  ⚠ ${f}`).join("\n")}
${JSON.stringify(bundle.metrics, null, 1)}

NORMALIZED XBRL SERIES (cite by concept key):
${JSON.stringify(bundle.facts, null, 1)}

FILED DOCUMENTS:
${docSections}`;

  return { prompt, validSources };
}

export function buildClassificationPrompt(bundle: TickerBundle, opts: { anonymize?: boolean } = {}): PromptBundle {
  // Cheaper triage variant: metrics + 8-K text only, no MD&A, no full series.
  const trimmed: TickerBundle = {
    ...bundle,
    documents: { recent8Ks: bundle.documents.recent8Ks, latestQuarterly: null },
    facts: {},
  };
  const { prompt, validSources } = buildAnalystPrompt(trimmed, opts);
  return {
    prompt:
      prompt +
      `\n\nTASK: classify the primary (and optional secondary) cause of the drop. Output the classification JSON only.`,
    validSources: collectValidSources(bundle),
  };
}

export function buildRankingPrompt(
  verdicts: { ticker: string; summary: string }[],
  topN: number,
): string {
  return `You are ranking analyst verdicts for a research queue. Pick the ${topN} names most
worth a human's personal investigation tonight and order them. Prioritize: (1) genuine anomalies
and narrative-vs-numbers disagreement, (2) mechanical/sentiment drops of businesses whose
computed metrics stayed healthy, (3) cases where evidence is strong either way. Deprioritize:
thesis-breaking drops fairly explained by deteriorating fundamentals, and anything resting on
degraded metrics or insufficient evidence UNLESS the name is large and the absence of an
explanation is itself the anomaly. Do not rank on predicted returns.

VERDICTS (order is arbitrary — do not let position influence rank):
${verdicts.map((v, i) => `[${i + 1}] ${v.ticker}\n${v.summary}`).join("\n\n")}`;
}

export function collectValidSources(bundle: TickerBundle, history?: PriorLook[]): Set<string> {
  const ids = new Set<string>();
  for (const d of bundle.documents.recent8Ks) ids.add(d.accession);
  if (bundle.documents.latestQuarterly) ids.add(bundle.documents.latestQuarterly.accession);
  for (const concept of Object.keys(bundle.facts)) ids.add(concept);
  ids.add("screen"); // the drop context itself
  for (const h of history ?? []) ids.add(priorSourceId(h.runDate));
  return ids;
}

function maybeMask(text: string, bundle: TickerBundle, anonymize?: boolean): string {
  if (!anonymize) return text;
  const names = [bundle.ticker, bundle.company.name, ...bundle.company.name.split(/[\s,]+/).filter((w) => w.length > 3)];
  let out = text;
  for (const n of names) {
    out = out.replace(new RegExp(escapeRe(n), "gi"), "Company A");
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fmtPct = (x: number | null | undefined) => (x === null || x === undefined ? "?" : `${x.toFixed(1)}%`);
