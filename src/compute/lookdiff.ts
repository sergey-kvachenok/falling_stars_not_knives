import type { TickerBundle } from "../bundle/build.js";
import type { LookSnapshot } from "../scoring/predictions.js";
import type { ComputedMetrics } from "./metrics.js";

// Recurring-ticker state diff: when the agent sees a ticker again, WHAT
// changed between the two looks is computed here, deterministically; the
// model's changeSincePrior explains WHY. (LLM never calculates — §7.1.)

export function takeSnapshot(bundle: TickerBundle): LookSnapshot {
  const m = bundle.metrics;
  return {
    asOfQuarter: m.asOfQuarter,
    revenueTtm: m.ttm.revenue,
    grossPct: m.margins.grossPct?.latestPct ?? null,
    opPct: m.margins.operatingPct?.latestPct ?? null,
    netDebt: m.balance.netDebt,
    shares: m.dilution.sharesOutstanding?.value ?? null,
    accessions: [
      ...bundle.documents.recent8Ks.map((d) => d.accession),
      ...(bundle.documents.latestQuarterly ? [bundle.documents.latestQuarterly.accession] : []),
    ],
  };
}

export function diffSinceLastLook(
  prior: LookSnapshot,
  priorDate: string,
  priorPrice: number | null,
  bundle: TickerBundle,
): string[] {
  const cur = takeSnapshot(bundle);
  const lines: string[] = [];

  const newAccessions = cur.accessions.filter((a) => !prior.accessions.includes(a));
  if (newAccessions.length > 0) {
    lines.push(`new filings since ${priorDate}: ${newAccessions.join(", ")}`);
  }
  if (prior.asOfQuarter && cur.asOfQuarter && cur.asOfQuarter !== prior.asOfQuarter) {
    lines.push(`reported quarter rolled ${prior.asOfQuarter} → ${cur.asOfQuarter}`);
  }
  const price = bundle.drop?.price;
  if (priorPrice && price) {
    lines.push(`price ${pct((price - priorPrice) / priorPrice)} since ${priorDate} ($${priorPrice.toFixed(2)} → $${price.toFixed(2)})`);
  }
  num(lines, "TTM revenue", prior.revenueTtm, cur.revenueTtm, (d) => pct(d));
  bp(lines, "gross margin", prior.grossPct, cur.grossPct);
  bp(lines, "operating margin", prior.opPct, cur.opPct);
  num(lines, "net debt", prior.netDebt, cur.netDebt, (d) => pct(d));
  num(lines, "share count", prior.shares, cur.shares, (d) => pct(d));

  return lines.length > 0 ? lines : [`no computed state change since ${priorDate} (same filings, same quarter)`];
}

function num(
  lines: string[],
  label: string,
  from: number | null,
  to: number | null,
  fmt: (delta: number) => string,
): void {
  if (from === null || to === null || from === 0 || from === to) return;
  const delta = (to - from) / Math.abs(from);
  if (Math.abs(delta) < 0.005) return;
  lines.push(`${label} ${fmt(delta)}`);
}

function bp(lines: string[], label: string, from: number | null, to: number | null): void {
  if (from === null || to === null) return;
  const deltaBp = Math.round((to - from) * 100);
  if (Math.abs(deltaBp) < 10) return;
  lines.push(`${label} ${deltaBp > 0 ? "+" : ""}${deltaBp}bp (${from}% → ${to}%)`);
}

const pct = (d: number) => `${d > 0 ? "+" : ""}${(d * 100).toFixed(1)}%`;
