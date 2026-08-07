import { mkdirSync, writeFileSync } from "node:fs";
import { assertConfig } from "../config.js";
import { getUniverse } from "./universe.js";
import { sweepQuotes } from "./quotes.js";
import { screen } from "./triggers.js";

// Phase 1 runner (PLAN.md §12): universe → quote sweep → floors + triggers → print.
// No DB, no LLM. Acceptance: run this for 3-4 days and eyeball the survivors.
async function main() {
  assertConfig();
  const t0 = Date.now();

  console.log("1/3 Universe seed from EDGAR…");
  const universe = await getUniverse();
  console.log(`    ${universe.length} tickers`);

  console.log("2/3 Yahoo batch quote sweep…");
  const { quotes, failed } = await sweepQuotes(universe.map((u) => u.ticker));
  console.log(`    ${quotes.length} quotes (${failed} failed)`);

  console.log("3/3 Floors + triggers…");
  const { candidates, stats } = await screen(universe, quotes, failed);

  console.log(`
Funnel: universe ${stats.universe} → quoted ${stats.quoted} → floors ${stats.passedFloors}` +
    ` → month-checked ${stats.monthChecked} → triggered ${stats.triggered}` +
    ` → after sector filter + cap: ${candidates.length}`);
  if (stats.monthCheckSkipped > 0) {
    console.warn(`⚠ ${stats.monthCheckSkipped} names skipped month verification (maxChartCalls cap)`);
  }
  if (stats.sectorExcluded.length > 0) {
    console.log(`Excluded financials/REITs: ${stats.sectorExcluded.join(", ")}`);
  }
  if (stats.overflowDropped.length > 0) {
    console.log(`Dropped over maxCandidates cap: ${stats.overflowDropped.join(", ")}`);
  }

  if (candidates.length === 0) {
    console.log("\nNo candidates today (empty days are normal — PLAN.md trap #8).");
  } else {
    console.log("");
    console.table(
      candidates.map((c) => ({
        ticker: c.ticker,
        company: c.title.slice(0, 28),
        sector: c.sector ?? "?",
        "cap $B": c.marketCapB.toFixed(1),
        price: c.price.toFixed(2),
        "day %": pct(c.dayChange),
        "month %": c.monthChange === null ? "—" : pct(c.monthChange),
        "vs 52wk %": pct(c.fromHigh),
        triggers: c.triggers.join("+"),
      })),
    );
  }

  const date = new Date().toISOString().slice(0, 10);
  mkdirSync(new URL("../../out", import.meta.url).pathname, { recursive: true });
  const outPath = new URL(`../../out/screen-${date}.json`, import.meta.url).pathname;
  writeFileSync(outPath, JSON.stringify({ date, stats, candidates }, null, 2));
  console.log(`\nSaved ${outPath} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

const pct = (x: number) => (x * 100).toFixed(1);

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
