import { config } from "../config.js";
import type { ComputedMetrics } from "./metrics.js";

// Classical valuation economics, computed deterministically — the answer to
// "more math than real economy":
//
//   EPV (Greenwald earnings power value) — what the business is worth if it
//   NEVER grows: normalized EBIT after tax, capitalized at the discount
//   rate, minus net debt. A floor with economic meaning.
//
//   Reverse DCF (Rappaport/Mauboussin expectations investing) — take the
//   CURRENT price as given and solve for the FCF growth the market is
//   implying. No forecast involved; the judgment question becomes "do the
//   filings support more growth than the market implies?"
//
// All assumptions are fixed and visible in config.economics — arguable, and
// therefore in config rather than inside a model's head.

export interface EconomicView {
  /** Zero-growth value per share; null when there are no positive earnings to capitalize. */
  epvPerShare: number | null;
  /** FCF growth rate (%/yr over the fade horizon) implied by the current price. */
  impliedGrowthPct: number | null;
  /** Street forward revenue growth (next-FY consensus vs TTM), %. */
  streetGrowthPct: number | null;
  /** streetGrowthPct − impliedGrowthPct: positive = market more pessimistic than the street. */
  expectationsGapPts: number | null;
}

export function computeEconomicView(
  price: number | null,
  m: ComputedMetrics,
  streetRevenue1yUsd: number | null,
): EconomicView {
  const { discountRate, terminalGrowth, taxRate, fadeYears } = config.economics;
  const shares = m.dilution.sharesOutstanding?.value ?? null;
  const netDebt = m.balance.netDebt ?? 0;

  // EPV floor.
  let epvPerShare: number | null = null;
  if (shares && shares > 0) {
    if (m.ttm.ebit !== null && m.ttm.ebit > 0) {
      const equityValue = (m.ttm.ebit * (1 - taxRate)) / discountRate - netDebt;
      epvPerShare = equityValue > 0 ? round2(equityValue / shares) : null;
    } else if (m.ttm.fcf !== null && m.ttm.fcf > 0) {
      // FCF is an equity flow (CFO is post-interest) — no net-debt adjustment.
      epvPerShare = round2(m.ttm.fcf / discountRate / shares);
    }
  }

  // Reverse DCF on TTM FCF.
  let impliedGrowthPct: number | null = null;
  if (price && price > 0 && shares && shares > 0 && m.ttm.fcf !== null && m.ttm.fcf > 0) {
    const marketCap = price * shares;
    const g = solveImpliedGrowth(m.ttm.fcf, marketCap, discountRate, terminalGrowth, fadeYears);
    impliedGrowthPct = g === null ? null : round1(g * 100);
  }

  const streetGrowthPct =
    streetRevenue1yUsd && m.ttm.revenue && m.ttm.revenue > 0
      ? round1((streetRevenue1yUsd / m.ttm.revenue - 1) * 100)
      : null;

  return {
    epvPerShare,
    impliedGrowthPct,
    streetGrowthPct,
    expectationsGapPts:
      impliedGrowthPct !== null && streetGrowthPct !== null ? round1(streetGrowthPct - impliedGrowthPct) : null,
  };
}

/** PV of fcf0 growing at g for `years`, then a Gordon terminal at gT. */
export function presentValue(fcf0: number, g: number, r: number, gT: number, years: number): number {
  let pv = 0;
  let f = fcf0;
  for (let t = 1; t <= years; t++) {
    f *= 1 + g;
    pv += f / Math.pow(1 + r, t);
  }
  const terminal = (f * (1 + gT)) / (r - gT) / Math.pow(1 + r, years);
  return pv + terminal;
}

/** Bisection: PV is monotonic in g, so solve PV(g) = marketCap. */
export function solveImpliedGrowth(
  fcf0: number,
  marketCap: number,
  r: number,
  gT: number,
  years: number,
): number | null {
  let lo = -0.9;
  let hi = 1.0;
  if (presentValue(fcf0, lo, r, gT, years) > marketCap) return lo; // priced below any plausible path
  if (presentValue(fcf0, hi, r, gT, years) < marketCap) return null; // implies >100%/yr — meaningless
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (presentValue(fcf0, mid, r, gT, years) < marketCap) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;
const round2 = (x: number): number => Math.round(x * 100) / 100;
