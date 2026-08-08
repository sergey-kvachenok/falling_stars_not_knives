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
  /**
   * Conservative street growth: min(forward revenue growth, forward EPS growth)
   * — the bottom-line estimate embeds margin change, keeping the comparison
   * with implied FCF growth apples-to-apples.
   */
  streetGrowthPct: number | null;
  /** streetGrowthPct − impliedGrowthPct: positive = market more pessimistic than the street. */
  expectationsGapPts: number | null;
  /** Risk-tiered discount rate actually used (%, e.g. 14 for stacked-risk names). */
  discountRatePctUsed: number;
  /** Return on invested capital, TTM — growth destroys value when below the discount rate. */
  roicPct: number | null;
  /** Which street growth proxy fed the gap — "revenue-penalized" marks unprofitable names without a bottom-line estimate. */
  growthProxy: string | null;
}

/**
 * A flat discount rate treats a leveraged small-cap like a mega-cap
 * compounder. Risk markers STACK (+2pts each, capped): a cash-burning
 * leveraged micro-cap is not merely "risky", it is all three at once.
 */
export function riskAdjustedDiscountRate(price: number | null, m: ComputedMetrics): number {
  const base = config.economics.discountRate;
  const shares = m.dilution?.sharesOutstanding?.value ?? null;
  const mcapB = price && shares ? (price * shares) / 1e9 : null;
  const nde = m.balance?.netDebtToEbitdaTtm ?? null;
  const fcfMarginPct = m.margins?.fcfPct?.latestPct ?? null;
  let markers = 0;
  if (nde !== null && nde > 1.5) markers++;
  if (fcfMarginPct !== null && fcfMarginPct < 5) markers++;
  if (mcapB !== null && mcapB < 5) markers++;
  if (markers > 0) return Math.min(base + 0.02 * markers, config.economics.maxDiscountRate);
  const ebit = m.ttm?.ebit ?? null;
  const stable = mcapB !== null && mcapB > 100 && ebit !== null && ebit > 0 && (nde === null || nde < 1.5);
  return stable ? base - 0.02 : base;
}

export function computeEconomicView(
  price: number | null,
  m: ComputedMetrics,
  streetRevenue1yUsd: number | null,
  streetEpsGrowthPct: number | null = null,
): EconomicView {
  const { terminalGrowth, taxRate, fadeYears } = config.economics;
  const discountRate = riskAdjustedDiscountRate(price, m);
  const shares = m.dilution?.sharesOutstanding?.value ?? null;
  const netDebt = m.balance?.netDebt ?? 0;
  // Bundles serialized before the ttm field existed deserialize without it.
  const t = m.ttm ?? { revenue: null, ebitda: null, ebit: null, netIncome: null, fcf: null };

  // Cyclical normalization: TTM earnings at a cycle peak inflate the EPV
  // floor and fake an expectations gap right before the trough. Using
  // min(TTM, 5y average) is universally conservative — a floor should never
  // stand on windfall earnings. (No sector classification to get wrong.)
  const normEbit =
    t.ebit !== null ? (t.ebitAvg5y !== null && t.ebitAvg5y !== undefined ? Math.min(t.ebit, t.ebitAvg5y) : t.ebit) : null;
  const normFcf =
    t.fcf !== null ? (t.fcfAvg5y !== null && t.fcfAvg5y !== undefined ? Math.min(t.fcf, t.fcfAvg5y) : t.fcf) : null;

  // EPV floor on normalized earnings.
  let epvPerShare: number | null = null;
  if (shares && shares > 0) {
    if (normEbit !== null && normEbit > 0) {
      const equityValue = (normEbit * (1 - taxRate)) / discountRate - netDebt;
      epvPerShare = equityValue > 0 ? round2(equityValue / shares) : null;
    } else if (normFcf !== null && normFcf > 0) {
      // FCF is an equity flow (CFO is post-interest) — no net-debt adjustment.
      epvPerShare = round2(normFcf / discountRate / shares);
    }
  }

  // Reverse DCF on normalized FCF — peak cash flow would understate what the
  // price implies, flattering the gap.
  let impliedGrowthPct: number | null = null;
  if (price && price > 0 && shares && shares > 0 && normFcf !== null && normFcf > 0) {
    const marketCap = price * shares;
    const g = solveImpliedGrowth(normFcf, marketCap, discountRate, terminalGrowth, fadeYears);
    impliedGrowthPct = g === null ? null : round1(g * 100);
  }

  // Apples-to-apples: revenue growth alone overstates cash growth when
  // margins won't scale; take the more conservative of revenue and EPS growth.
  // EPS growth is incomputable for unprofitable companies (negative
  // denominator) — falling silently back to revenue would reopen the original
  // trap, so unprofitable names take a 50% haircut on revenue growth instead.
  const streetRevGrowthPct =
    streetRevenue1yUsd && t.revenue && t.revenue > 0 ? round1((streetRevenue1yUsd / t.revenue - 1) * 100) : null;
  const unprofitable = t.netIncome !== null && t.netIncome <= 0;
  let streetGrowthPct: number | null = null;
  let growthProxy: string | null = null;
  if (streetEpsGrowthPct !== null && streetRevGrowthPct !== null) {
    streetGrowthPct = Math.min(streetEpsGrowthPct, streetRevGrowthPct);
    growthProxy = "min(revenue, eps)";
  } else if (streetEpsGrowthPct !== null) {
    streetGrowthPct = streetEpsGrowthPct;
    growthProxy = "eps";
  } else if (streetRevGrowthPct !== null) {
    streetGrowthPct = unprofitable
      ? round1(streetRevGrowthPct * config.economics.unprofitableRevenueHaircut)
      : streetRevGrowthPct;
    growthProxy = unprofitable ? "revenue-penalized (unprofitable, no bottom-line estimate)" : "revenue";
  }

  // ROIC vs cost of capital: growth funded below its cost destroys value.
  // Invested capital is floored at tangible operating assets (PP&E): for
  // net-cash companies, Equity+Debt−Cash goes tiny or negative and the raw
  // ratio turns meaningless — the excess cash isn't what runs the business.
  let roicPct: number | null = null;
  const equity = m.balance?.equityBook?.value ?? null;
  const debt = m.balance?.totalDebt?.value ?? null;
  const cash = m.balance?.cashAndSti?.value ?? null;
  const ppe = m.balance?.ppe?.value ?? null;
  if (normEbit !== null && equity !== null && debt !== null) {
    const invested = Math.max(equity + debt - (cash ?? 0), ppe ?? 0);
    if (invested > 0) roicPct = round1(((normEbit * (1 - taxRate)) / invested) * 100);
  }

  return {
    epvPerShare,
    impliedGrowthPct,
    streetGrowthPct,
    expectationsGapPts:
      impliedGrowthPct !== null && streetGrowthPct !== null ? round1(streetGrowthPct - impliedGrowthPct) : null,
    discountRatePctUsed: round1(discountRate * 100),
    roicPct,
    growthProxy,
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
