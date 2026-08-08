import { assertConfig, config } from "../config.js";
import { pullState } from "../lib/statesync.js";
import { loadCalibration, adjustFairValue } from "../compute/calibration.js";
import { loadPredictions } from "./predictions.js";

// Verification report (`npm run verify`): the complete audit trail of every
// prediction — what was claimed, on what economics, and what actually
// happened. This is how "does it work?" gets answered with data.

async function main() {
  assertConfig();
  await pullState();
  const preds = loadPredictions();
  if (preds.length === 0) {
    console.log("No predictions recorded yet.");
    return;
  }

  console.log(`${preds.length} prediction(s) on record\n`);
  const rows = preds
    .sort((a, b) => a.runDate.localeCompare(b.runDate))
    .map((p) => {
      const graded = p.valuationErrorPct != null;
      const falsifiers = p.falsifierGrades
        ? `${p.falsifierGrades.filter((g) => g.status === "fired").length}F/${p.falsifierGrades.filter((g) => g.status === "survived").length}S/${p.falsifierGrades.filter((g) => g.status === "uncheckable").length}U`
        : "—";
      return {
        date: p.runDate,
        ticker: p.ticker,
        class: p.classification,
        "v#": p.promptVersion ?? "?",
        price: p.refPrice,
        fair: p.fairValue1y ?? null,
        "underv%": p.undervaluationPct ?? null,
        "gap pts": p.economics?.expectationsGapPts ?? null,
        "drift30%": p.drift30 != null ? Math.round(p.drift30 * 1000) / 10 : null,
        "drift90%": p.drift90 != null ? Math.round(p.drift90 * 1000) / 10 : null,
        "ret1y%": p.return1y != null ? Math.round(p.return1y * 1000) / 10 : null,
        "err%": graded ? p.valuationErrorPct : null,
        falsifiers,
        note: p.resolutionNote ?? "",
      };
    });
  console.table(rows);

  const cal = loadCalibration();
  if (!cal) {
    console.log("\nCalibration: no matured predictions yet (first grades at 90 days, valuation errors at 1 year).");
  } else {
    console.log(`\nCalibration (n=${cal.n}, updated ${cal.updatedAt}):`);
    console.log(`  mean error ${cal.meanErrorPct > 0 ? "+" : ""}${cal.meanErrorPct}% | median ${cal.medianErrorPct ?? "?"}%`);
    for (const [cls, b] of Object.entries(cal.byClassification ?? {})) {
      console.log(`  ${cls}: ${b.meanErrorPct > 0 ? "+" : ""}${Math.round(b.meanErrorPct * 10) / 10}% (n=${b.n})`);
    }
    const demo = adjustFairValue(100, cal);
    console.log(
      demo.active
        ? `  CORRECTION ACTIVE: a raw fair value of $100 is displayed and gated as $${demo.adjusted}`
        : `  correction dormant: ${cal.n}/${config.calibration.minSamples} matured samples needed to activate`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
