import "../lib/env.js";
import { pullState, pushState } from "../lib/statesync.js";
import { loadPredictions, savePredictions } from "./predictions.js";

// Corporate-action resolution (survivorship-bias guard):
//   npm run resolve -- TICKER RUN_DATE REALIZED_PRICE ["note"]
// Buyout → the cash offer price. Bankruptcy/delisting-for-cause → 0.
// Excluding these silently would delete every −100% from the calibration
// sample and make the system look better than it is.

async function main() {
  const [ticker, runDate, priceArg, ...noteParts] = process.argv.slice(2);
  const realized = Number(priceArg);
  if (!ticker || !runDate || !Number.isFinite(realized) || realized < 0) {
    console.error('Usage: npm run resolve -- TICKER RUN_DATE REALIZED_PRICE ["acquired at $X" | "bankrupt"]');
    process.exit(1);
  }
  await pullState();
  const preds = loadPredictions();
  const p = preds.find((x) => x.ticker === ticker.toUpperCase() && x.runDate === runDate);
  if (!p) {
    console.error(`No prediction for ${ticker} on ${runDate}. Known: ${preds.map((x) => `${x.ticker}@${x.runDate}`).join(", ")}`);
    process.exit(1);
  }
  p.return1y = p.refPrice > 0 ? Math.round((realized / p.refPrice - 1) * 10000) / 10000 : null;
  if (p.fairValue1y && p.fairValue1y > 0) {
    p.valuationErrorPct = Math.round(((realized - p.fairValue1y) / p.fairValue1y) * 1000) / 10;
  }
  p.resolutionNote = noteParts.join(" ") || `manually resolved at $${realized}`;
  p.updatedAt = new Date().toISOString();
  savePredictions(preds);
  await pushState();
  console.log(
    `${p.ticker} (${p.runDate}) resolved: realized $${realized} vs ref $${p.refPrice} → return ${(p.return1y! * 100).toFixed(1)}%` +
      (p.valuationErrorPct != null ? `, valuation error ${p.valuationErrorPct}%` : "") +
      ` — enters calibration at the next scoring run.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
