import { assertConfig } from "../config.js";
import { getUniverse } from "../screen/universe.js";
import { returnSince } from "../screen/quotes.js";
import { buildBundle } from "../bundle/build.js";
import { readState } from "../lib/state.js";
import { pullState, pushState } from "../lib/statesync.js";
import { drainFeedback, sendHeartbeat, telegramConfigured } from "../deliver/telegram.js";
import type { FeedbackEntry } from "../deliver/telegram.js";
import { gradeFalsifiers } from "./falsifier.js";
import { loadPredictions, savePredictions, type Prediction } from "./predictions.js";

// Weekly scoring job (PLAN.md §10). Grades three things, fastest first:
//  1. falsifier resolution at 90d (steers prompt iteration)
//  2. classification drift vs SPY at 30/90d (weak-label validation:
//     thesis_breaking should keep underperforming, mechanical/sentiment
//     should mean-revert)
//  3. returns at 1y/3y (recorded for honesty, not steering)
// Plus the 👍 rate — the actual product metric.

const MS_DAY = 86_400_000;

async function main() {
  assertConfig();
  const noTelegram = process.argv.includes("--no-telegram");
  const today = new Date().toISOString().slice(0, 10);

  await pullState();
  if (!noTelegram && telegramConfigured()) {
    await drainFeedback().catch(() => []);
  }

  const predictions = loadPredictions();
  if (predictions.length === 0) {
    console.log("No predictions recorded yet — nothing to score.");
    return;
  }

  const universe = await getUniverse();
  const cikByTicker = new Map(universe.map((u) => [u.ticker, u.cik]));
  const lines: string[] = [];
  let graded = 0;

  for (const p of predictions) {
    const ageDays = (Date.now() - Date.parse(p.runDate)) / MS_DAY;
    let touched = false;

    const needsDrift =
      (ageDays >= 30 && p.drift30 === undefined) || (ageDays >= 90 && p.drift90 === undefined);
    if (needsDrift) {
      const [stock, spy] = await Promise.all([returnSince(p.ticker, p.runDate), returnSince("SPY", p.runDate)]);
      if (stock === null) {
        // Delisted or unavailable (trap #7) — resolve, never leave silent.
        p.resolutionNote = p.resolutionNote ?? "price history unavailable (delisted/acquired?) — resolve manually";
        lines.push(`${p.ticker} (${p.runDate}): price history gone — needs manual resolution`);
      } else if (spy !== null) {
        const drift = stock - spy;
        if (ageDays >= 30 && p.drift30 === undefined) p.drift30 = round4(drift);
        if (ageDays >= 90 && p.drift90 === undefined) p.drift90 = round4(drift);
      }
      touched = true;
    }

    if (ageDays >= 90 && !p.falsifierGrades && !p.resolutionNote) {
      const cik = cikByTicker.get(p.ticker);
      if (cik) {
        try {
          const { bundle } = await buildBundle(p.ticker, cik);
          if (bundle) {
            p.falsifierGrades = await gradeFalsifiers(p, bundle);
            graded++;
            const fired = p.falsifierGrades.filter((g) => g.status === "fired").length;
            const uncheckable = p.falsifierGrades.filter((g) => g.status === "uncheckable").length;
            lines.push(`${p.ticker} (${p.runDate}): falsifiers ${fired} fired, ${uncheckable} uncheckable`);
          }
        } catch (err) {
          console.warn(`${p.ticker}: falsifier grading failed — ${(err as Error).message}`);
        }
      }
      touched = true;
    }

    if (ageDays >= 365 && p.return1y === undefined) {
      p.return1y = round4((await returnSince(p.ticker, p.runDate)) ?? NaN) || null;
      // Calibration (#4): realized price vs the fair value claimed a year ago.
      if (p.return1y !== null && p.fairValue1y) {
        const realized = p.refPrice * (1 + p.return1y);
        p.valuationErrorPct = round4(((realized - p.fairValue1y) / p.fairValue1y) * 100);
      }
      touched = true;
    }
    if (ageDays >= 1095 && p.return3y === undefined) {
      p.return3y = round4((await returnSince(p.ticker, p.runDate)) ?? NaN) || null;
      touched = true;
    }
    if (touched) p.updatedAt = new Date().toISOString();
  }
  savePredictions(predictions);

  // Per-class drift rollup — meaningful only once samples accumulate (§10.2).
  const byClass = new Map<string, number[]>();
  for (const p of predictions) {
    const d = p.drift90 ?? p.drift30;
    if (d !== undefined && d !== null) {
      byClass.set(p.classification, [...(byClass.get(p.classification) ?? []), d]);
    }
  }
  const driftSummary = [...byClass.entries()]
    .map(([cls, ds]) => `${cls}: ${(avg(ds) * 100).toFixed(1)}% avg drift vs SPY (n=${ds.length})`)
    .join("\n");

  const { loadFeedbackDb } = await import("../lib/db.js");
  const feedback = (await loadFeedbackDb().catch(() => null)) ?? readState<FeedbackEntry[]>("feedback", []);
  const upRate = feedback.length
    ? `${Math.round((feedback.filter((f) => f.worthMyTime).length / feedback.length) * 100)}% 👍 of ${feedback.length} taps`
    : "no feedback taps yet";

  const uncheckableTotal = predictions
    .flatMap((p) => p.falsifierGrades ?? [])
    .filter((g) => g.status === "uncheckable").length;
  const gradedTotal = predictions.flatMap((p) => p.falsifierGrades ?? []).length;

  // Fast regime guard input: kill-switch fire rate among decided grades.
  // Fires within 90 days, unlike the 1-year price calibration — the early
  // warning that the current regime is harsher than the scenarios assume.
  const decided = predictions
    .flatMap((p) => p.falsifierGrades ?? [])
    .filter((g) => g.status === "fired" || g.status === "survived");
  if (decided.length > 0) {
    const firedShare = decided.filter((g) => g.status === "fired").length / decided.length;
    const { writeState: ws } = await import("../lib/state.js");
    ws("fastguard", { firedShare: Math.round(firedShare * 1000) / 1000, n: decided.length, updatedAt: today });
  }

  // Unresolved corporate actions bias calibration upward if ignored — nag.
  const unresolved = predictions.filter((p) => p.resolutionNote?.includes("manual")).length;

  // Calibration rollup (#4): systematic fair-value bias and band hit-rate,
  // persisted so the digest can apply a measured correction once n is large.
  const calibrated = predictions.filter((p) => p.valuationErrorPct != null);
  let calibrationLine = "";
  if (calibrated.length > 0) {
    const meanErr = avg(calibrated.map((p) => p.valuationErrorPct!));
    const sortedErrs = calibrated.map((p) => p.valuationErrorPct!).sort((a, b) => a - b);
    const medianErr = sortedErrs[Math.floor(sortedErrs.length / 2)]!;
    const byClassification: Record<string, { n: number; meanErrorPct: number }> = {};
    for (const p of calibrated) {
      const cls = p.classification;
      const bucket = (byClassification[cls] ??= { n: 0, meanErrorPct: 0 });
      bucket.meanErrorPct = (bucket.meanErrorPct * bucket.n + p.valuationErrorPct!) / (bucket.n + 1);
      bucket.n++;
    }
    const inBand = calibrated.filter((p) => {
      const realized = p.refPrice * (1 + (p.return1y ?? 0));
      return p.implied1y?.bear != null && p.implied1y?.bull != null
        ? realized >= p.implied1y.bear && realized <= p.implied1y.bull
        : false;
    }).length;
    calibrationLine =
      `valuation calibration (n=${calibrated.length}): realized ${meanErr > 0 ? "+" : ""}${meanErr.toFixed(0)}% vs fair on average; ` +
      `${inBand}/${calibrated.length} landed inside the bear–bull band`;
    const { writeState } = await import("../lib/state.js");
    writeState("calibration", {
      n: calibrated.length,
      meanErrorPct: Math.round(meanErr * 10) / 10,
      medianErrorPct: Math.round(medianErr * 10) / 10,
      byClassification,
      updatedAt: today,
    });
  }

  const summary = [
    `<b>Scoring rollup — ${today}</b>`,
    `predictions tracked: ${predictions.length} | graded this run: ${graded}`,
    driftSummary || "drift: no predictions ≥30 days old yet",
    gradedTotal > 0 ? `falsifiers: ${gradedTotal} graded, ${uncheckableTotal} uncheckable (target <25%)` : "",
    unresolved > 0
      ? `⚠ ${unresolved} prediction(s) need manual corporate-action resolution (npm run resolve) — unresolved names bias calibration upward`
      : "",
    calibrationLine,
    `feedback: ${upRate}`,
    ...lines.slice(0, 10),
    "<i>Research queue, not investment advice.</i>",
  ]
    .filter(Boolean)
    .join("\n");

  console.log(summary.replace(/<[^>]+>/g, ""));
  if (!noTelegram && telegramConfigured()) await sendHeartbeat(summary);
  await pushState();
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round4 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10_000) / 10_000 : NaN);

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
