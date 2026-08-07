import { mkdirSync, writeFileSync } from "node:fs";
import { assertConfig, config } from "../config.js";
import { getUniverse } from "../screen/universe.js";
import { sweepQuotes } from "../screen/quotes.js";
import { screen, type Candidate } from "../screen/triggers.js";
import { buildBundle, type TickerBundle } from "../bundle/build.js";
import { analyzeWithCache } from "../analyst/service.js";
import type { AnalysisRecord } from "../analyst/analyze.js";
import { rankVerdicts } from "../analyst/rank.js";
import { usage } from "../analyst/provider.js";
import { readState, writeState } from "../lib/state.js";
import { pruneCache } from "../lib/prune.js";
import { pullState, pushState } from "../lib/statesync.js";
import { buildDigest, buildReportHtml, type DigestEntry } from "../deliver/report.js";
import { drainFeedback, sendDigest, sendHeartbeat, sendReport, telegramConfigured } from "../deliver/telegram.js";
import { appendPredictions, loadPredictions, type Prediction } from "../scoring/predictions.js";
import { takeSnapshot } from "../compute/lookdiff.js";
import type { FeedbackEntry } from "../deliver/telegram.js";
import { loadFeedbackDb, upsertCards } from "../lib/db.js";
import { buildExpandedCard } from "../deliver/card.js";

// Nightly entrypoint (PLAN.md §3):
//   screen → cooldown → enrich (with drop context) → analyze → rank → deliver.
// Flags for local testing: --limit N (cap candidates, logged — no silent
// caps), --no-telegram (print digest, write report to disk, send nothing).

interface CooldownState {
  [ticker: string]: { lastDigestDate: string; bundleHash: string };
}

async function main() {
  assertConfig();
  const args = process.argv.slice(2);
  const noTelegram = args.includes("--no-telegram");
  const limitArg = args.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;
  const runDate = new Date().toISOString().slice(0, 10);
  const t0 = Date.now();

  if (!noTelegram && !telegramConfigured()) {
    console.error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set (use --no-telegram for a local run).");
    process.exit(1);
  }

  // Weekend guard — cron shouldn't fire, but belt and braces.
  const day = new Date().getUTCDay();
  if (day === 0 || day === 6) {
    console.log("Weekend — exiting.");
    return;
  }

  // Durable state (Phase 3): pull from Postgres when DATABASE_URL is set.
  await pullState();

  // 0. Collect pending feedback taps from previous digests (PLAN.md §9.3).
  if (!noTelegram) {
    const fb = await drainFeedback().catch((e) => {
      console.warn(`feedback drain failed: ${(e as Error).message}`);
      return [];
    });
    if (fb.length > 0) console.log(`Collected ${fb.length} feedback tap(s).`);
  }

  // 1. Screen.
  console.log("Screening…");
  const universe = await getUniverse();
  const { quotes, failed } = await sweepQuotes(universe.map((u) => u.ticker));
  const result = await screen(universe, quotes, failed);
  let candidates = result.candidates;
  if (candidates.length > limit) {
    console.log(`--limit ${limit}: dropping ${candidates.length - limit} candidates (${candidates.slice(limit).map((c) => c.ticker).join(", ")})`);
    candidates = candidates.slice(0, limit);
  }
  console.log(`${candidates.length} candidate(s) after screen.`);

  // 2+3. Enrich + analyze, with cooldown (PLAN.md §5): a ticker already
  // digested within cooldownDays is skipped unless a new filing changed its
  // bundle hash.
  const cooldown = readState<CooldownState>("cooldown", {});
  // Bot memory: the reader's last vote per ticker steers what re-surfaces.
  // Webhook mode writes votes to the feedback table; the table wins when present.
  const feedbackLog = (await loadFeedbackDb()) ?? readState<FeedbackEntry[]>("feedback", []);
  const lastVote = new Map<string, FeedbackEntry>();
  for (const f of feedbackLog) lastVote.set(f.ticker, f); // append-order → latest wins
  const allPreds = loadPredictions();
  const predByKey = new Map(allPreds.map((p) => [`${p.ticker}|${p.runDate}`, p]));

  const entries: { candidate: Candidate; bundle: TickerBundle; analysis: AnalysisRecord }[] = [];
  const skipped: string[] = [];
  let cacheHits = 0;

  for (const c of candidates) {
    try {
      const { bundle, skippedReason } = await buildBundle(c.ticker, c.cik, {
        price: c.price,
        analystTargetPrice: c.analystTarget,
        dayChangePct: c.dayChange * 100,
        monthChangePct: c.monthChange === null ? null : c.monthChange * 100,
        fromHighPct: c.fromHigh * 100,
        triggers: c.triggers,
      });
      if (!bundle) {
        skipped.push(`${c.ticker} (${skippedReason})`);
        continue;
      }
      const { record, cacheHit } = await analyzeWithCache(bundle);
      if (cacheHit) cacheHits++;

      const seen = cooldown[c.ticker];
      const inCooldown =
        seen &&
        seen.bundleHash === record.bundleHash &&
        daysBetween(seen.lastDigestDate, runDate) < config.screen.cooldownDays;
      if (inCooldown) {
        skipped.push(`${c.ticker} (cooldown, no new filing)`);
        continue;
      }
      // 👎 suppression: a downvoted name stays out unless a new filing
      // changed its bundle (bot memory).
      const vote = lastVote.get(c.ticker);
      if (vote && !vote.worthMyTime) {
        const fresh = daysBetween(vote.receivedAt.slice(0, 10), runDate) < config.memory.downvoteSuppressDays;
        const hashAtVote = predByKey.get(`${c.ticker}|${vote.runDate}`)?.bundleHash;
        if (fresh && hashAtVote === record.bundleHash) {
          skipped.push(`${c.ticker} (👎 suppressed, no new filing)`);
          continue;
        }
      }
      entries.push({ candidate: c, bundle, analysis: record });
      console.log(`${c.ticker}: ${record.classification.primary}${cacheHit ? " (cached)" : ""}`);
    } catch (err) {
      // One bad ticker must not kill the run.
      skipped.push(`${c.ticker} (error: ${(err as Error).message})`);
      console.error(`${c.ticker} failed: ${(err as Error).message}`);
    }
  }
  if (skipped.length > 0) console.log(`Skipped: ${skipped.join("; ")}`);

  // Health metrics (PLAN.md §11).
  const withVerdicts = entries.filter((e) => e.analysis.verdict);
  const insuffRate = withVerdicts.length
    ? withVerdicts.filter((e) => e.analysis.verdict!.insufficientEvidence).length / withVerdicts.length
    : 0;
  const avgAgreement = entries.length
    ? entries.reduce((s, e) => s + e.analysis.classification.voteAgreement, 0) / entries.length
    : 0;
  const health =
    `${entries.length} analyzed, ${cacheHits} cached | insufficient_evidence ${(insuffRate * 100).toFixed(0)}% | ` +
    `vote agreement ${(avgAgreement * 100).toFixed(0)}% | LLM ${usage.calls} calls ${usage.promptTokens + usage.outputTokens} tokens`;

  // 4. Empty day → heartbeat (silence is ambiguous — trap #8).
  if (entries.length === 0) {
    const msg = `No candidates today (${runDate}). ${skipped.length > 0 ? `Skipped: ${skipped.length}.` : ""} Pipeline healthy.`;
    if (noTelegram) console.log(`[heartbeat] ${msg}`);
    else await sendHeartbeat(msg);
    saveRunSummary(runDate, entries.length, skipped, health, t0);
    await pushState();
    return;
  }

  // 4.5 Watchlist (bot memory): 👍 names that did NOT re-trigger the screen
  // get a follow-up when a new filing changed their bundle.
  const watchlist: { ticker: string; note: string }[] = [];
  const candidateSet = new Set(candidates.map((c) => c.ticker));
  const cikByTicker = new Map(universe.map((u) => [u.ticker, u.cik]));
  const watchCandidates = [...lastVote.values()]
    .filter(
      (f) =>
        f.worthMyTime &&
        !candidateSet.has(f.ticker) &&
        daysBetween(f.receivedAt.slice(0, 10), runDate) < config.memory.watchlistDays,
    )
    .slice(0, config.memory.watchlistMaxPerRun);
  for (const f of watchCandidates) {
    const cik = cikByTicker.get(f.ticker);
    const prior = allPreds.filter((p) => p.ticker === f.ticker).sort((a, b) => a.runDate.localeCompare(b.runDate)).at(-1);
    if (!cik || !prior) continue;
    try {
      const { bundle } = await buildBundle(f.ticker, cik);
      if (!bundle) continue;
      const { record } = await analyzeWithCache(bundle);
      if (record.bundleHash !== prior.bundleHash && record.verdict) {
        watchlist.push({ ticker: f.ticker, note: record.verdict.changeSincePrior || record.verdict.oneLineThesis });
        console.log(`${f.ticker}: watchlist follow-up (new filing since 👍)`);
      }
    } catch (err) {
      console.warn(`watchlist ${f.ticker} failed: ${(err as Error).message}`);
    }
  }

  // 5. Rank.
  console.log("Ranking…");
  const { ranking, stable } = await rankVerdicts(entries.map((e) => e.analysis));
  const byTicker = new Map(entries.map((e) => [e.analysis.ticker, e]));
  const digestEntries: DigestEntry[] = ranking.ranked
    .map((r) => {
      const e = byTicker.get(r.ticker);
      if (!e) return null;
      const prior = allPreds.filter((p) => p.ticker === r.ticker && p.runDate < runDate).at(-1);
      const v = lastVote.get(r.ticker);
      const seenNote = prior ? `seen ${prior.runDate}${v ? (v.worthMyTime ? " 👍" : " 👎") : ""}` : undefined;
      const entry: DigestEntry = { ticker: r.ticker, bundle: e.bundle, analysis: e.analysis, justification: r.justification };
      if (seenNote) entry.seenNote = seenNote;
      return entry;
    })
    .filter((x): x is DigestEntry => x !== null);

  // 6. Deliver.
  const digest = buildDigest(digestEntries, runDate, stable, watchlist);
  const report = buildReportHtml(digestEntries, ranking, runDate, health);
  const reportsDir = new URL("../../out/reports", import.meta.url).pathname;
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(`${reportsDir}/report-${runDate}.html`, report);

  // Precompute expanded cards so the webhook can answer a 👍 instantly.
  const cardsStored = await upsertCards(digestEntries.map(buildExpandedCard)).catch((err) => {
    console.warn(`card upsert failed: ${(err as Error).message}`);
    return false;
  });
  if (cardsStored) console.log(`${digestEntries.length} expanded card(s) stored.`);

  if (noTelegram) {
    console.log("\n--- digest (not sent) ---\n" + digest + "\n--- end digest ---");
    console.log(`Report written to out/reports/report-${runDate}.html`);
  } else {
    await sendDigest(digest, digestEntries.map((e) => ({ ticker: e.ticker, runDate })));
    await sendReport(`report-${runDate}.html`, report, `Full report — ${runDate}`);
    console.log("Digest + report sent.");
  }

  // 7. Persist predictions (PLAN.md §10 — recorded from day one), cooldown, run summary.
  const predictions: Prediction[] = digestEntries
    .filter((e) => e.analysis.verdict)
    .map((e, i) => ({
      ticker: e.ticker,
      runDate,
      rank: i + 1,
      classification: e.analysis.classification.primary,
      thesis: e.analysis.verdict!.oneLineThesis,
      bundleHash: e.analysis.bundleHash,
      refPrice: byTicker.get(e.ticker)?.candidate.price ?? 0,
      scenarios: e.analysis.verdict!.scenarios,
      snapshot: takeSnapshot(e.bundle),
    }));
  appendPredictions(predictions);
  for (const e of digestEntries) {
    cooldown[e.ticker] = { lastDigestDate: runDate, bundleHash: e.analysis.bundleHash };
  }
  writeState("cooldown", cooldown);
  saveRunSummary(runDate, entries.length, skipped, health, t0);
  await pushState();

  // 8. Prune stale cache — bounds disk to a rolling ~60-day window (§6).
  const edgarCacheDir = new URL("../../.cache/edgar", import.meta.url).pathname;
  const pruned = pruneCache(edgarCacheDir, config.cache.pruneAfterDays);
  if (pruned.deleted > 0) console.log(`Pruned ${pruned.deleted} stale cache file(s), freed ${pruned.freedMb}MB.`);

  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(0)}s. ${health}`);
}

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(b) - Date.parse(a)) / 86_400_000;
}

function saveRunSummary(runDate: string, analyzed: number, skipped: string[], health: string, t0: number): void {
  const runs = readState<object[]>("runs", []);
  writeState("runs", [
    ...runs.slice(-90),
    { runDate, analyzed, skipped, health, seconds: Math.round((Date.now() - t0) / 1000) },
  ]);
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
