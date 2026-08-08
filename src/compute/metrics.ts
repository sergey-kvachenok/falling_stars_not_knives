import type { FactsByConcept, QuarterPoint } from "../edgar/companyfacts.js";

// ---------------------------------------------------------------------------
// Deterministic metrics (PLAN.md §7.1/§7.2). The LLM never calculates —
// everything here is computed in code, unit-testable, and carries the
// accession number it derived from. Values are levels AND deltas: the model
// is handed the diff, not a wall of statements.
// ---------------------------------------------------------------------------

export interface MetricValue {
  value: number;
  accn: string;
}

export interface ComputedMetrics {
  asOfQuarter: string | null; // end date of latest quarter with revenue
  revenue: {
    latestQ: MetricValue | null;
    qoqPct: number | null;
    yoyPct: number | null;
    /** YoY growth this quarter minus YoY growth prior quarter, in points. */
    decelerationPts: number | null;
  };
  margins: {
    grossPct: TrendValue | null;
    operatingPct: TrendValue | null;
    fcfPct: TrendValue | null;
  };
  cashFlow: {
    fcfLatestQ: MetricValue | null; // CFO − capex
    cfoTtm: number | null;
    capexTtm: number | null;
    /** Capex as % of revenue, TTM — rising values suppress FCF conversion. */
    capexPctRevenueTtm: number | null;
  };
  /** Trailing-twelve-month absolutes — inputs for scenario anchor math (§8). */
  ttm: {
    revenue: number | null;
    ebitda: number | null;
    netIncome: number | null;
    fcf: number | null;
  };
  balance: {
    cashAndSti: MetricValue | null;
    totalDebt: MetricValue | null;
    equityBook: MetricValue | null;
    netDebt: number | null;
    netDebtToEbitdaTtm: number | null;
    interestCoverageTtm: number | null; // EBIT(ttm) / interest expense(ttm)
    cashRunwayQuarters: number | null; // only when FCF negative
  };
  dilution: {
    sharesOutstanding: MetricValue | null;
    yoyChangePct: number | null;
  };
  workingCapital: {
    inventoryQoqPct: number | null;
    revenueQoqPct: number | null; // repeated here for the divergence read
  };
  provenance: Record<string, { tag: string | null; latestAccn: string | null }>;
}

interface TrendValue {
  latestPct: number;
  qoqBp: number | null;
  yoyBp: number | null;
  accn: string;
}

export function computeMetrics(series: FactsByConcept): ComputedMetrics {
  const rev = quarterly(series, "revenue");
  const netInc = quarterly(series, "netIncome");
  const cost = quarterly(series, "costOfRevenue");
  const gross = quarterly(series, "grossProfit");
  const opInc = quarterly(series, "operatingIncome");
  const da = quarterly(series, "depreciationAmortization");
  const cfo = quarterly(series, "cfo");
  const capex = quarterly(series, "capex");
  const interest = quarterly(series, "interestExpense");

  const latestRev = last(rev);
  const revQoq = growth(rev, 1);
  const revYoy = growth(rev, 4);
  const revYoyPrior = growth(rev.slice(0, -1), 4);

  // Gross profit: direct tag, else revenue − cost of revenue (aligned by quarter end).
  const grossByEnd = gross.length > 0 ? gross : subtractAligned(rev, cost);

  const fcf = subtractAligned(cfo, capex);
  const ebitdaQ = addAligned(opInc, da);

  const cashPts = series.cash?.instant ?? [];
  const stiPts = series.shortTermInvestments?.instant ?? [];
  const ltdPts = series.longTermDebt?.instant ?? [];
  const cdPts = series.currentDebt?.instant ?? [];
  const sharesPts = series.sharesOutstanding?.instant ?? [];

  const latestCash = lastInstant(cashPts);
  const latestSti = lastInstant(stiPts);
  const cashAndSti = latestCash
    ? { value: latestCash.val + (alignedInstant(stiPts, latestCash.end)?.val ?? 0), accn: latestCash.accn }
    : null;
  const latestLtd = lastInstant(ltdPts);
  const totalDebt = latestLtd
    ? { value: latestLtd.val + (alignedInstant(cdPts, latestLtd.end)?.val ?? 0), accn: latestLtd.accn }
    : null;
  const netDebt = totalDebt && cashAndSti ? totalDebt.value - cashAndSti.value : null;

  const ebitdaTtm = ttm(ebitdaQ);
  const ebitTtm = ttm(opInc);
  const interestTtm = ttm(interest);
  const cfoTtm = ttm(cfo);
  const fcfLatest = last(fcf);

  // Runway: liquid assets over average recent burn — only meaningful when burning.
  let runway: number | null = null;
  if (cashAndSti && fcf.length >= 2) {
    const recent = fcf.slice(-2).map((p) => p.val);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (avg < 0) runway = round1(cashAndSti.value / -avg);
  }

  // dei shares are missing for dual-class filers (dimensioned facts are
  // omitted from companyfacts) — fall back to weighted diluted shares.
  const weightedShares = quarterly(series, "weightedSharesDiluted");
  const latestSharesPt = lastInstant(sharesPts);
  const latestWeighted = last(weightedShares);
  const latestShares =
    latestSharesPt ?? (latestWeighted ? { end: latestWeighted.end, val: latestWeighted.val, accn: latestWeighted.accn } : undefined);
  const sharesYoy = latestSharesPt ? instantYoy(sharesPts) : growth(weightedShares, 4);

  const invPts = series.inventory?.instant ?? [];
  const invQoq =
    invPts.length >= 2 ? pctChange(invPts[invPts.length - 2]!.val, invPts[invPts.length - 1]!.val) : null;

  const provenance: ComputedMetrics["provenance"] = {};
  for (const [name, s] of Object.entries(series)) {
    const latest = last(s.quarterly)?.accn ?? lastInstant(s.instant)?.accn ?? null;
    provenance[name] = { tag: s.tag, latestAccn: latest };
  }

  return {
    asOfQuarter: latestRev?.end ?? null,
    revenue: {
      latestQ: latestRev ? { value: latestRev.val, accn: latestRev.accn } : null,
      qoqPct: revQoq,
      yoyPct: revYoy,
      decelerationPts: revYoy !== null && revYoyPrior !== null ? round1(revYoy - revYoyPrior) : null,
    },
    margins: {
      grossPct: marginTrend(grossByEnd, rev),
      operatingPct: marginTrend(opInc, rev),
      fcfPct: marginTrend(fcf, rev),
    },
    cashFlow: {
      fcfLatestQ: fcfLatest ? { value: fcfLatest.val, accn: fcfLatest.accn } : null,
      cfoTtm,
      capexTtm: ttm(capex),
      capexPctRevenueTtm: (() => {
        const capexT = ttm(capex);
        const revT = ttm(rev);
        return capexT !== null && revT !== null && revT > 0 ? round1((capexT / revT) * 100) : null;
      })(),
    },
    ttm: {
      revenue: ttm(rev),
      ebitda: ebitdaTtm,
      netIncome: ttm(netInc),
      fcf: ttm(fcf),
    },
    balance: {
      cashAndSti,
      totalDebt,
      equityBook: (() => {
        const eq = lastInstant(series.equity?.instant ?? []);
        return eq ? { value: eq.val, accn: eq.accn } : null;
      })(),
      netDebt,
      netDebtToEbitdaTtm:
        netDebt !== null && ebitdaTtm !== null && ebitdaTtm > 0 ? round1(netDebt / ebitdaTtm) : null,
      interestCoverageTtm:
        ebitTtm !== null && interestTtm !== null && interestTtm > 0 ? round1(ebitTtm / interestTtm) : null,
      cashRunwayQuarters: runway,
    },
    dilution: {
      sharesOutstanding: latestShares ? { value: latestShares.val, accn: latestShares.accn } : null,
      yoyChangePct: sharesYoy,
    },
    workingCapital: {
      inventoryQoqPct: invQoq,
      revenueQoqPct: revQoq,
    },
    provenance,
  };
}

// --- helpers ---------------------------------------------------------------

function quarterly(series: FactsByConcept, name: string): QuarterPoint[] {
  return series[name]?.quarterly ?? [];
}

const last = <T>(arr: T[]): T | undefined => arr[arr.length - 1];
const lastInstant = (pts: { end: string; val: number; accn: string }[]) => last(pts);

function growth(pts: QuarterPoint[], lag: number): number | null {
  if (pts.length < lag + 1) return null;
  const cur = pts[pts.length - 1]!;
  const ref = pts[pts.length - 1 - lag]!;
  return pctChange(ref.val, cur.val);
}

function pctChange(from: number, to: number): number | null {
  if (from === 0) return null;
  return round1(((to - from) / Math.abs(from)) * 100);
}

/** a − b, matched by quarter end date; quarters missing in either side are dropped. */
export function subtractAligned(a: QuarterPoint[], b: QuarterPoint[]): QuarterPoint[] {
  const bByEnd = new Map(b.map((p) => [p.end, p]));
  return a
    .filter((p) => bByEnd.has(p.end))
    .map((p) => ({ ...p, val: p.val - bByEnd.get(p.end)!.val }));
}

export function addAligned(a: QuarterPoint[], b: QuarterPoint[]): QuarterPoint[] {
  const bByEnd = new Map(b.map((p) => [p.end, p]));
  return a
    .filter((p) => bByEnd.has(p.end))
    .map((p) => ({ ...p, val: p.val + bByEnd.get(p.end)!.val }));
}

function marginTrend(numer: QuarterPoint[], denom: QuarterPoint[]): TrendValue | null {
  const dByEnd = new Map(denom.map((p) => [p.end, p]));
  const pts = numer
    .filter((p) => dByEnd.has(p.end) && dByEnd.get(p.end)!.val !== 0)
    .map((p) => ({ end: p.end, accn: p.accn, pct: (p.val / dByEnd.get(p.end)!.val) * 100 }));
  const cur = last(pts);
  if (!cur) return null;
  const prev = pts[pts.length - 2];
  const yearAgo = pts[pts.length - 5];
  return {
    latestPct: round1(cur.pct),
    qoqBp: prev ? Math.round((cur.pct - prev.pct) * 100) : null,
    yoyBp: yearAgo ? Math.round((cur.pct - yearAgo.pct) * 100) : null,
    accn: cur.accn,
  };
}

function ttm(pts: QuarterPoint[]): number | null {
  if (pts.length < 4) return null;
  return pts.slice(-4).reduce((sum, p) => sum + p.val, 0);
}

function alignedInstant(
  pts: { end: string; val: number; accn: string }[],
  end: string,
): { end: string; val: number; accn: string } | undefined {
  return pts.find((p) => p.end === end);
}

function instantYoy(pts: { end: string; val: number; accn: string }[]): number | null {
  const cur = last(pts);
  if (!cur) return null;
  const target = Date.parse(cur.end) - 365 * 86_400_000;
  let best: { end: string; val: number } | null = null;
  let bestDist = Infinity;
  for (const p of pts) {
    const dist = Math.abs(Date.parse(p.end) - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  if (!best || bestDist > 60 * 86_400_000) return null;
  return pctChange(best.val, cur.val);
}

const round1 = (x: number): number => Math.round(x * 10) / 10;
