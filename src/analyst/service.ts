import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { TickerBundle } from "../bundle/build.js";
import { analyzeBundle, bundleHash, type AnalysisRecord } from "./analyze.js";

// Shared by the CLI runner and the nightly pipeline: file-based analysis
// cache keyed by the stable bundle hash (PLAN.md §6.2). A recurring ticker
// with no new filing costs zero LLM calls.

const ANALYSES_DIR = new URL("../../out/analyses", import.meta.url).pathname;

export interface AnalyzeOutcome {
  record: AnalysisRecord;
  cacheHit: boolean;
}

export async function analyzeWithCache(
  bundle: TickerBundle,
  opts: { anonymize?: boolean; force?: boolean } = {},
): Promise<AnalyzeOutcome> {
  mkdirSync(ANALYSES_DIR, { recursive: true });
  const hash = bundleHash(bundle);
  const cachePath = `${ANALYSES_DIR}/${bundle.ticker}-${hash}${opts.anonymize ? "-anon" : ""}.json`;
  if (!opts.force && existsSync(cachePath)) {
    return { record: JSON.parse(readFileSync(cachePath, "utf8")) as AnalysisRecord, cacheHit: true };
  }
  const record = await analyzeBundle(bundle, opts);
  writeFileSync(cachePath, JSON.stringify(record, null, 2));
  return { record, cacheHit: false };
}
