import { subtractAligned, addAligned, type ComputedMetrics } from "./metrics.js";
import type { FactsByConcept, QuarterPoint } from "../edgar/companyfacts.js";

// Historical multiple ranges — improvement #1 for fair-value trust: the
// multiple is no longer the AI's opinion. The company's own recent trading
// history says what the market actually pays for it; bear/base/bull map to
// the 25th/50th/75th percentile of that range, and validation rejects
// multiples that leave it without justification.
//
// Approximation, stated openly: EV uses CURRENT shares and net debt at every
// historical point (dilution drift is ignored). Good enough to bound a
// multiple; not a backtest.

export interface MultipleRange {
  metric: "EV/Sales" | "EV/EBITDA" | "P/E" | "P/FCF";
  p25: number;
  p50: number;
  p75: number;
  n: number; // observation count (quarter-ends with data)
}

export interface Bar {
  date: string; // YYYY-MM-DD
  close: number;
}

export function historicalMultipleRanges(
  closes: Bar[],
  m: ComputedMetrics,
  facts: FactsByConcept,
): MultipleRange[] {
  const sharesNow = m.dilution.sharesOutstanding?.value;
  if (!sharesNow || sharesNow <= 0 || closes.length === 0) return [];
  const netDebtNow = m.balance.netDebt ?? 0;

  // Time-correct share count and net debt: using TODAY's shares at historical
  // prices inflates the historical market cap of heavy diluters, making their
  // historical multiples look higher and today's look "cheap" by comparison.
  const sharesInstant = facts["sharesOutstanding"]?.instant ?? [];
  const weightedQ = facts["weightedSharesDiluted"]?.quarterly ?? [];
  const inst = (name: string) => facts[name]?.instant ?? [];
  const sharesAt = (end: string): number =>
    nearestInstant(sharesInstant, end) ??
    nearestInstant(weightedQ.map((q) => ({ end: q.end, val: q.val })), end) ??
    sharesNow;
  const netDebtAt = (end: string): number => {
    const ltd = nearestInstant(inst("longTermDebt"), end);
    const cd = nearestInstant(inst("currentDebt"), end);
    const cash = nearestInstant(inst("cash"), end);
    const sti = nearestInstant(inst("shortTermInvestments"), end);
    if (ltd === null && cash === null) return netDebtNow; // no balance history — fall back
    return (ltd ?? 0) + (cd ?? 0) - (cash ?? 0) - (sti ?? 0);
  };

  const q = (name: string): QuarterPoint[] => facts[name]?.quarterly ?? [];
  const fcfQ = subtractAligned(q("cfo"), q("capex"));
  const ebitdaQ = addAligned(q("operatingIncome"), q("depreciationAmortization"));

  const defs: { metric: MultipleRange["metric"]; series: { end: string; ttm: number }[]; ev: boolean }[] = [
    { metric: "EV/Sales", series: ttmSeries(q("revenue")), ev: true },
    { metric: "EV/EBITDA", series: ttmSeries(ebitdaQ), ev: true },
    { metric: "P/E", series: ttmSeries(q("netIncome")), ev: false },
    { metric: "P/FCF", series: ttmSeries(fcfQ), ev: false },
  ];

  const ranges: MultipleRange[] = [];
  for (const def of defs) {
    const ratios: number[] = [];
    for (const point of def.series) {
      if (point.ttm <= 0) continue; // negative denominators make no multiple
      const close = nearestClose(closes, point.end);
      if (close === null) continue;
      const value = close * sharesAt(point.end) + (def.ev ? netDebtAt(point.end) : 0);
      ratios.push(value / point.ttm);
    }
    if (ratios.length >= 4) {
      ratios.sort((a, b) => a - b);
      ranges.push({
        metric: def.metric,
        p25: round1(percentile(ratios, 0.25)),
        p50: round1(percentile(ratios, 0.5)),
        p75: round1(percentile(ratios, 0.75)),
        n: ratios.length,
      });
    }
  }
  return ranges;
}

/**
 * The multiples the market pays TODAY, post-drop — the live re-rating is
 * information the model must confront: bear multiples belong at or below it.
 */
export function currentMultiples(price: number, m: ComputedMetrics): { metric: MultipleRange["metric"]; value: number }[] {
  const shares = m.dilution.sharesOutstanding?.value;
  if (!shares || shares <= 0 || price <= 0) return [];
  const netDebt = m.balance.netDebt ?? 0;
  const cap = price * shares;
  const out: { metric: MultipleRange["metric"]; value: number }[] = [];
  const push = (metric: MultipleRange["metric"], denom: number | null, ev: boolean) => {
    if (denom !== null && denom > 0) out.push({ metric, value: Math.round(((cap + (ev ? netDebt : 0)) / denom) * 10) / 10 });
  };
  push("EV/Sales", m.ttm.revenue, true);
  push("EV/EBITDA", m.ttm.ebitda, true);
  push("P/E", m.ttm.netIncome, false);
  push("P/FCF", m.ttm.fcf, false);
  return out;
}

/** Trailing-four-quarter sums at each quarter end. */
export function ttmSeries(pts: QuarterPoint[]): { end: string; ttm: number }[] {
  const out: { end: string; ttm: number }[] = [];
  for (let i = 3; i < pts.length; i++) {
    out.push({ end: pts[i]!.end, ttm: pts.slice(i - 3, i + 1).reduce((s, p) => s + p.val, 0) });
  }
  return out;
}

function nearestInstant(
  pts: { end: string; val: number }[],
  date: string,
  maxDays = 135,
): number | null {
  const target = Date.parse(date);
  let best: number | null = null;
  let bestDist = maxDays * 86_400_000;
  for (const p of pts) {
    const dist = Math.abs(Date.parse(p.end) - target);
    if (dist < bestDist) {
      best = p.val;
      bestDist = dist;
    }
  }
  return best;
}

function nearestClose(closes: Bar[], date: string): number | null {
  const target = Date.parse(date);
  let best: number | null = null;
  let bestDist = 46 * 86_400_000; // must be within ~45 days
  for (const b of closes) {
    const dist = Math.abs(Date.parse(b.date) - target);
    if (dist < bestDist) {
      best = b.close;
      bestDist = dist;
    }
  }
  return best;
}

export function percentile(sorted: number[], p: number): number {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

const round1 = (x: number): number => Math.round(x * 10) / 10;
