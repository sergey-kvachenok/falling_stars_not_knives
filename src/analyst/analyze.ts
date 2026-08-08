import { createHash } from "node:crypto";
import { config } from "../config.js";
import type { TickerBundle } from "../bundle/build.js";
import { generateJson } from "./provider.js";
import { buildAnalystPrompt, buildClassificationPrompt } from "./prompts.js";
import { CLASSIFICATION_SCHEMA, VERDICT_SCHEMA, type Classification, type Verdict } from "./schemas.js";
import { retryFeedback, validateClassification, validateVerdict } from "./validate.js";

export interface AnalysisRecord {
  ticker: string;
  bundleHash: string;
  promptVersion: number;
  model: string;
  createdAt: string;
  classification: {
    primary: string;
    secondary: string;
    voteAgreement: number; // majority size / total votes
    votes: Classification[];
  };
  verdict: Verdict | null;
  status: "ok" | "validation_failed";
  validationErrors?: string[];
}

/**
 * Stable bundle hash (PLAN.md §6.2): ticker + accession set + facts
 * fingerprint + prompt/schema version. Prices, drop %, and run date are in
 * the bundle but NOT the hash — a recurring ticker with no new filing reuses
 * its cached analysis.
 */
export function bundleHash(bundle: TickerBundle, extra = ""): string {
  const accessions = [
    ...bundle.documents.recent8Ks.map((d) => d.accession),
    ...(bundle.documents.latestQuarterly ? [bundle.documents.latestQuarterly.accession] : []),
  ].sort();
  const factsFingerprint = createHash("sha256").update(JSON.stringify(bundle.facts)).digest("hex");
  return createHash("sha256")
    .update([bundle.ticker, accessions.join(","), factsFingerprint, `v${config.llm.promptVersion}`, extra].join("|"))
    .digest("hex")
    .slice(0, 24);
}

/** 3-vote self-consistency classification (PLAN.md §7.3). */
export async function classifyWithVotes(
  bundle: TickerBundle,
  opts: { anonymize?: boolean } = {},
): Promise<AnalysisRecord["classification"]> {
  const { prompt, validSources } = buildClassificationPrompt(bundle, opts);
  const votes: Classification[] = [];
  for (let i = 0; i < config.llm.classificationVotes; i++) {
    let p = prompt;
    for (let attempt = 0; ; attempt++) {
      const c = await generateJson<Classification>(p, CLASSIFICATION_SCHEMA, { temperature: 1.0 });
      const check = validateClassification(c, validSources);
      if (check.ok) {
        votes.push(c);
        break;
      }
      if (attempt >= config.llm.maxCitationRetries) {
        votes.push({ ...c, primary: "insufficient_evidence", rationale: `vote discarded: ${check.badSources.join(",")}` });
        break;
      }
      p = prompt + "\n\n" + retryFeedback(check);
    }
  }
  const { winner, agreement } = majority(votes.map((v) => v.primary));
  const withWinner = votes.find((v) => v.primary === winner)!;
  return { primary: winner, secondary: withWinner.secondary, voteAgreement: agreement, votes };
}

export function majority(labels: string[]): { winner: string; agreement: number } {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  let winner = labels[0] ?? "insufficient_evidence";
  let max = 0;
  for (const [label, n] of counts) {
    if (n > max) {
      winner = label;
      max = n;
    }
  }
  return { winner, agreement: labels.length > 0 ? max / labels.length : 0 };
}

/** Deep pass with citation validation and a hard retry cap (PLAN.md §7.5). */
export async function deepAnalyze(
  bundle: TickerBundle,
  opts: {
    anonymize?: boolean;
    history?: import("./history.js").PriorLook[];
    objections?: import("../lib/db.js").UserArgument[];
  } = {},
): Promise<{ verdict: Verdict | null; errors: string[] }> {
  const { prompt, validSources } = buildAnalystPrompt(bundle, opts);
  let p = prompt;
  let lastErrors: string[] = [];
  for (let attempt = 0; attempt <= config.llm.maxCitationRetries; attempt++) {
    const v = await generateJson<Verdict>(p, VERDICT_SCHEMA, { temperature: 0.4 });
    const check = validateVerdict(v, validSources, bundle.metrics, bundle.drop);
    if (check.ok) return { verdict: v, errors: [] };
    lastErrors = [...check.badSources.map((s) => `bad source: ${s}`), ...check.problems];
    p = prompt + "\n\n" + retryFeedback(check);
  }
  // One persistently hallucinating ticker must not wedge the run (trap #11).
  return { verdict: null, errors: lastErrors };
}

export async function analyzeBundle(
  bundle: TickerBundle,
  opts: { anonymize?: boolean; objections?: import("../lib/db.js").UserArgument[] } = {},
): Promise<AnalysisRecord> {
  // Classification votes stay memory-free: three INDEPENDENT reads of the
  // evidence measure ambiguity — anchoring them on a prior verdict would
  // corrupt the vote-agreement health metric. Memory enters the deep pass.
  const classification = await classifyWithVotes(bundle, opts);
  const history = opts.anonymize ? [] : (await import("./history.js")).getTickerHistory(bundle.ticker);
  const { verdict, errors } = await deepAnalyze(bundle, { ...opts, history, objections: opts.objections });
  if (verdict && !verdict.insufficientEvidence) {
    // Median-of-three valuation numbers (compact re-samples; see valuation.ts).
    try {
      verdict.scenarios = await (await import("./valuation.js")).valuationEnsemble(bundle, verdict);
    } catch (err) {
      console.warn(`  valuation ensemble failed, keeping single draw: ${(err as Error).message}`);
    }
  }
  return {
    ticker: bundle.ticker,
    bundleHash: bundleHash(bundle),
    promptVersion: config.llm.promptVersion,
    model: config.llm.model,
    createdAt: new Date().toISOString(),
    classification,
    verdict,
    status: verdict ? "ok" : "validation_failed",
    ...(errors.length > 0 ? { validationErrors: errors } : {}),
  };
}
