import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { assertConfig, config } from "../config.js";
import type { TickerBundle } from "../bundle/build.js";
import type { AnalysisRecord } from "./analyze.js";
import { analyzeWithCache } from "./service.js";
import { rankVerdicts } from "./rank.js";
import { usage } from "./provider.js";

// Phase 4 runner (PLAN.md §12): `npm run analyze -- [TICKER…] [--anon] [--force]`
// Reads bundles from out/bundles/, analyzes with a file-based cache keyed by
// the stable bundle hash, then ranks. Runs offline against Phase-2 JSON so
// prompts iterate without touching EDGAR.

const BUNDLES_DIR = new URL("../../out/bundles", import.meta.url).pathname;
const ANALYSES_DIR = new URL("../../out/analyses", import.meta.url).pathname;

async function main() {
  assertConfig();
  if (!config.llm.apiKey) {
    console.error("GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey and add it to .env");
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const anonymize = args.includes("--anon");
  const force = args.includes("--force");
  const tickers = args.filter((a) => !a.startsWith("--")).map((t) => t.toUpperCase());

  const available = existsSync(BUNDLES_DIR)
    ? readdirSync(BUNDLES_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""))
    : [];
  const targets = tickers.length > 0 ? tickers : available;
  if (targets.length === 0) {
    console.error("No bundles found — run `npm run bundle -- TICKER…` first.");
    process.exit(1);
  }
  mkdirSync(ANALYSES_DIR, { recursive: true });

  const analyses: AnalysisRecord[] = [];
  let cacheHits = 0;
  for (const ticker of targets) {
    const bundlePath = `${BUNDLES_DIR}/${ticker}.json`;
    if (!existsSync(bundlePath)) {
      console.warn(`No bundle for ${ticker} — skipped`);
      continue;
    }
    const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as TickerBundle;

    console.log(`${ticker}: analyzing${anonymize ? " (anonymized)" : ""}…`);
    try {
      const { record, cacheHit } = await analyzeWithCache(bundle, { anonymize, force });
      analyses.push(record);
      if (cacheHit) {
        cacheHits++;
        console.log(`  cache hit (${record.bundleHash})`);
        continue;
      }
      const v = record.verdict;
      console.log(
        `  ${record.classification.primary}` +
          `${record.classification.secondary !== "none" ? `+${record.classification.secondary}` : ""}` +
          ` (votes ${Math.round(record.classification.voteAgreement * 3)}/3)` +
          `${v?.insufficientEvidence ? " [insufficient evidence]" : ""}` +
          `${record.status === "validation_failed" ? " [VALIDATION FAILED]" : ""}`,
      );
      if (v) {
        console.log(`  thesis: ${v.oneLineThesis}`);
        if (v.anomalies.length > 0) console.log(`  anomalies: ${v.anomalies.join("; ")}`);
      }
    } catch (err) {
      console.error(`  FAILED: ${(err as Error).message}`);
    }
  }

  if (analyses.length > 1) {
    console.log("\nRanking…");
    const { ranking, stable, overlapWithReversed } = await rankVerdicts(analyses);
    console.log(stable ? "(ranking stable under order reversal)" : `⚠ ranking UNSTABLE — only ${overlapWithReversed} names overlap under order reversal`);
    ranking.ranked.forEach((r, i) => console.log(`  ${i + 1}. ${r.ticker} — ${r.justification}`));
    if (ranking.notes) console.log(`  notes: ${ranking.notes}`);
    writeFileSync(
      `${ANALYSES_DIR}/ranking-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify({ ranking, stable, overlapWithReversed, analyses: analyses.map((a) => a.ticker) }, null, 2),
    );
  }

  // Health metrics (PLAN.md §11) — the numbers that tell you if the analyst is noise.
  const withVerdicts = analyses.filter((a) => a.verdict);
  const insuffRate = withVerdicts.length
    ? withVerdicts.filter((a) => a.verdict!.insufficientEvidence).length / withVerdicts.length
    : 0;
  const avgAgreement = analyses.length
    ? analyses.reduce((s, a) => s + a.classification.voteAgreement, 0) / analyses.length
    : 0;
  const failed = analyses.filter((a) => a.status === "validation_failed").length;
  console.log(
    `\nHealth: insufficient_evidence ${(insuffRate * 100).toFixed(0)}% | vote agreement ${(avgAgreement * 100).toFixed(0)}% | validation_failed ${failed}/${analyses.length} | cache hits ${cacheHits}`,
  );
  console.log(`LLM usage: ${usage.calls} calls, ${usage.promptTokens} prompt + ${usage.outputTokens} output tokens`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
