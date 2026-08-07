import { config } from "../config.js";
import { generateJson } from "./provider.js";
import { buildRankingPrompt } from "./prompts.js";
import { RANKING_SCHEMA, type Ranking } from "./schemas.js";
import type { AnalysisRecord } from "./analyze.js";

export interface RankResult {
  ranking: Ranking;
  stable: boolean; // reversed-order check (PLAN.md §7.7)
  overlapWithReversed: number;
}

function verdictSummary(a: AnalysisRecord): string {
  const v = a.verdict;
  if (!v) return `classification: ${a.classification.primary} (validation_failed — no verdict)`;
  return [
    `cause: ${v.dropCause.primary}${v.dropCause.secondary !== "none" ? `+${v.dropCause.secondary}` : ""}` +
      ` (vote agreement ${Math.round(a.classification.voteAgreement * 100)}%)` +
      `${v.insufficientEvidence ? " — INSUFFICIENT EVIDENCE" : ""}`,
    `thesis: ${v.oneLineThesis}`,
    v.anomalies.length > 0 ? `anomalies: ${v.anomalies.join("; ")}` : "anomalies: none",
    `guidance: ${v.guidanceRead.change} (${v.guidanceRead.timingVsDemand})`,
    v.reconciliation.length > 0
      ? `possible discrepancies: ${v.reconciliation.map((r) => r.discrepancy).join("; ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Pass B (PLAN.md §7.7): one ranking call over all verdicts, run twice with
 * reversed input order to measure position bias. Unstable = top sets differ
 * by more than 2 names — flagged in the report footer, not fatal.
 */
export async function rankVerdicts(analyses: AnalysisRecord[]): Promise<RankResult> {
  const topN = Math.min(config.output.topN, analyses.length);
  const items = analyses.map((a) => ({ ticker: a.ticker, summary: verdictSummary(a) }));

  const forward = await generateJson<Ranking>(buildRankingPrompt(items, topN), RANKING_SCHEMA, {
    temperature: 0.2,
  });
  const reversed = await generateJson<Ranking>(
    buildRankingPrompt([...items].reverse(), topN),
    RANKING_SCHEMA,
    { temperature: 0.2 },
  );

  const fwdSet = new Set(forward.ranked.slice(0, topN).map((r) => r.ticker));
  const revSet = new Set(reversed.ranked.slice(0, topN).map((r) => r.ticker));
  const overlap = [...fwdSet].filter((t) => revSet.has(t)).length;
  const stable = fwdSet.size - overlap <= 2;

  // Keep only tickers that actually exist in the input (schema can't enforce this).
  const known = new Set(items.map((i) => i.ticker));
  const ranked = forward.ranked.filter((r) => known.has(r.ticker)).slice(0, topN);

  return { ranking: { ranked, notes: forward.notes }, stable, overlapWithReversed: overlap };
}
