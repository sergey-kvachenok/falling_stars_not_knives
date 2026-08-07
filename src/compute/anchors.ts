import type { ComputedMetrics } from "./metrics.js";

// Scenario anchor math (PLAN.md §8). The model supplies the ASSUMPTIONS
// (metric, multiple, assumed metric value for that scenario); this module
// does the ARITHMETIC — implied per-share value from net debt and share
// count. The LLM never computes prices (§7.1).

export type AnchorMetric = "EV/EBITDA" | "EV/Sales" | "P/E" | "P/S" | "P/FCF" | "P/B" | "none";

export interface ValuationAnchor {
  metric: AnchorMetric;
  multiple: number;
  /** The metric's assumed absolute USD value in that scenario (e.g. EBITDA of 1.2e9). */
  assumedMetricValueUsd: number;
  rationale: string;
}

/**
 * Implied per-share price, or null when inputs are missing or the result is
 * non-positive. Uses CURRENT net debt and share count — dilution and
 * deleveraging between now and the horizon are knowingly ignored; the number
 * is an anchor, not a target.
 */
export function impliedPrice(anchor: ValuationAnchor, m: ComputedMetrics): number | null {
  const shares = m.dilution.sharesOutstanding?.value;
  if (!shares || shares <= 0 || anchor.metric === "none" || anchor.multiple <= 0) return null;
  const netDebt = m.balance.netDebt ?? 0;
  const v = anchor.multiple * anchor.assumedMetricValueUsd;
  let equityValue: number;
  switch (anchor.metric) {
    case "EV/EBITDA":
    case "EV/Sales":
      equityValue = v - netDebt;
      break;
    case "P/E":
    case "P/S":
    case "P/FCF":
    case "P/B":
      equityValue = v;
      break;
    default:
      return null;
  }
  const price = equityValue / shares;
  return price > 0 ? Math.round(price * 100) / 100 : null;
}

/**
 * Weight-blended implied price across one horizon's scenarios — the single
 * "anchor value" the digest compares the live price against. Weights are the
 * model's narrative weights, normalized over scenarios that priced.
 */
export function weightedAnchorPrice(
  scenarios: { horizonYears: string; narrativeWeight: number; valuationAnchor: ValuationAnchor }[],
  m: ComputedMetrics,
  horizon: "1" | "3",
): number | null {
  let weightSum = 0;
  let priceSum = 0;
  for (const s of scenarios) {
    if (s.horizonYears !== horizon) continue;
    const p = impliedPrice(s.valuationAnchor, m);
    if (p === null || s.narrativeWeight <= 0) continue;
    weightSum += s.narrativeWeight;
    priceSum += s.narrativeWeight * p;
  }
  return weightSum > 0 ? Math.round((priceSum / weightSum) * 100) / 100 : null;
}

/**
 * Best entry price for a scenario: the price today at which reaching the
 * scenario's estimated price by its horizon returns ≥ hurdle per year.
 */
export function entryPrice(estimated: number | null, horizonYears: number, hurdlePerYear: number): number | null {
  if (estimated === null || estimated <= 0) return null;
  const entry = estimated / Math.pow(1 + hurdlePerYear, horizonYears);
  return Math.round(entry * 100) / 100;
}

/** TTM actual for the anchor's metric — used to sanity-bound the assumption. */
export function ttmActualFor(metric: AnchorMetric, m: ComputedMetrics): number | null {
  switch (metric) {
    case "EV/EBITDA":
      return m.ttm.ebitda;
    case "EV/Sales":
    case "P/S":
      return m.ttm.revenue;
    case "P/E":
      return m.ttm.netIncome;
    case "P/FCF":
      return m.ttm.fcf;
    case "P/B":
      return m.balance.equityBook?.value ?? null;
    default:
      return null;
  }
}
