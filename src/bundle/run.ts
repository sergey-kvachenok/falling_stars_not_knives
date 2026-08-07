import { mkdirSync, writeFileSync } from "node:fs";
import { assertConfig } from "../config.js";
import { getUniverse } from "../screen/universe.js";
import { buildBundle } from "./build.js";

// Phase 2 runner (PLAN.md §12): `npm run bundle -- SEDG APP WING …`
// Builds bundles for hand-picked tickers and prints a metric summary for
// manual verification against the actual filings.
async function main() {
  assertConfig();
  const tickers = process.argv.slice(2).map((t) => t.toUpperCase());
  if (tickers.length === 0) {
    console.error("Usage: npm run bundle -- TICKER [TICKER…]");
    process.exit(1);
  }

  const universe = await getUniverse();
  const cikByTicker = new Map(universe.map((u) => [u.ticker, u.cik]));
  const outDir = new URL("../../out/bundles", import.meta.url).pathname;
  mkdirSync(outDir, { recursive: true });

  for (const ticker of tickers) {
    const cik = cikByTicker.get(ticker);
    console.log(`\n=== ${ticker} ${cik ? `(CIK ${cik})` : ""} ===`);
    if (!cik) {
      console.log("  not in EDGAR ticker map — skipped");
      continue;
    }
    try {
      const { bundle, skippedReason } = await buildBundle(ticker, cik);
      if (!bundle) {
        console.log(`  skipped: ${skippedReason}`);
        continue;
      }
      const path = `${outDir}/${ticker}.json`;
      writeFileSync(path, JSON.stringify(bundle, null, 2));

      const m = bundle.metrics;
      console.log(`  ${bundle.company.name} — SIC ${bundle.company.sic} ${bundle.company.sicDescription}`);
      console.log(`  as of quarter: ${m.asOfQuarter ?? "?"}   sanity: ${bundle.sanity.confidence}`);
      for (const flag of bundle.sanity.flags) console.log(`    ⚠ ${flag}`);
      console.log(
        `  revenue: ${fmtB(m.revenue.latestQ?.value)} (QoQ ${fmt(m.revenue.qoqPct)}%, YoY ${fmt(m.revenue.yoyPct)}%, decel ${fmt(m.revenue.decelerationPts)}pts)`,
      );
      console.log(
        `  margins: gross ${fmt(m.margins.grossPct?.latestPct)}% (${fmt(m.margins.grossPct?.qoqBp)}bp QoQ), op ${fmt(m.margins.operatingPct?.latestPct)}%, fcf ${fmt(m.margins.fcfPct?.latestPct)}%`,
      );
      console.log(
        `  balance: cash+STI ${fmtB(m.balance.cashAndSti?.value)}, debt ${fmtB(m.balance.totalDebt?.value)}, netDebt/EBITDA ${fmt(m.balance.netDebtToEbitdaTtm)}, runway ${fmt(m.balance.cashRunwayQuarters)}q`,
      );
      console.log(
        `  dilution: shares YoY ${fmt(m.dilution.yoyChangePct)}%   inventory QoQ ${fmt(m.workingCapital.inventoryQoqPct)}% vs revenue QoQ ${fmt(m.workingCapital.revenueQoqPct)}%`,
      );
      console.log(
        `  docs: ${bundle.documents.recent8Ks.length} recent 8-K(s)` +
          bundle.documents.recent8Ks.map((d) => ` [${d.filedAt} items ${d.items.join(",") || "—"} ${d.kind}]`).join("") +
          `, quarterly: ${bundle.documents.latestQuarterly ? `${bundle.documents.latestQuarterly.form} ${bundle.documents.latestQuarterly.filedAt}${bundle.documents.latestQuarterly.truncated ? " (section truncated/fallback)" : ""}` : "none"}`,
      );
      const missing = Object.entries(m.provenance).filter(([, p]) => !p.tag).map(([n]) => n);
      if (missing.length > 0) console.log(`  no tag matched: ${missing.join(", ")}`);
      console.log(`  saved ${path}`);
    } catch (err) {
      console.error(`  FAILED: ${(err as Error).message}`);
    }
  }
}

const fmt = (x: number | null | undefined): string => (x === null || x === undefined ? "—" : String(x));
const fmtB = (x: number | null | undefined): string =>
  x === null || x === undefined ? "—" : `$${(x / 1e9).toFixed(2)}B`;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
