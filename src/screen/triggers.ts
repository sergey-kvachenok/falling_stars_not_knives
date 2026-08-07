import { config } from "../config.js";
import type { UniverseEntry } from "./universe.js";
import { getSector, monthReturn, type QuoteLite } from "./quotes.js";

export type TriggerName = "dayDrop" | "monthDrop" | "from52WeekHigh";

export interface Candidate {
  ticker: string;
  title: string;
  cik: number;
  price: number;
  marketCapB: number;
  dayChange: number;
  monthChange: number | null;
  fromHigh: number;
  sector: string | null;
  triggers: TriggerName[];
}

export interface ScreenResult {
  candidates: Candidate[];
  stats: {
    universe: number;
    quoted: number;
    quoteFailed: number;
    passedFloors: number;
    monthChecked: number;
    monthCheckSkipped: number;
    triggered: number;
    sectorExcluded: string[];
    overflowDropped: string[];
  };
}

// Severity order per PLAN.md §5: fresh event beats stale state.
const TRIGGER_RANK: Record<TriggerName, number> = { dayDrop: 0, monthDrop: 1, from52WeekHigh: 2 };

export async function screen(
  universe: UniverseEntry[],
  quotes: QuoteLite[],
  quoteFailed: number,
): Promise<ScreenResult> {
  const { screen: cfg } = config;
  const byTicker = new Map(universe.map((u) => [u.ticker, u]));

  const floorPass = quotes.filter(
    (q) =>
      q.quoteType === "EQUITY" &&
      q.market === "us_market" &&
      q.currency === "USD" &&
      q.marketCap > cfg.minMarketCap &&
      q.price > cfg.minPrice &&
      q.avgVolume > cfg.minAvgVolume,
  );

  // Month trigger needs history; only chart-check names the cheap 50dma proxy flags.
  const needsMonthCheck = floorPass.filter(
    (q) => q.fiftyDayAverage && q.price / q.fiftyDayAverage - 1 <= cfg.monthPrefilterVs50dma,
  );
  const monthCheckList = needsMonthCheck.slice(0, config.yahoo.maxChartCalls);
  const monthCheckSkipped = needsMonthCheck.length - monthCheckList.length;
  const monthBySymbol = new Map<string, number | null>();
  for (const q of monthCheckList) {
    monthBySymbol.set(q.symbol, await monthReturn(q.symbol));
  }

  const triggered: Candidate[] = [];
  for (const q of floorPass) {
    const fromHigh = q.fiftyTwoWeekHigh > 0 ? q.price / q.fiftyTwoWeekHigh - 1 : 0;
    const monthChange = monthBySymbol.get(q.symbol) ?? null;
    const hits: TriggerName[] = [];
    if (q.dayChange <= cfg.triggers.dayDrop) hits.push("dayDrop");
    if (monthChange !== null && monthChange <= cfg.triggers.monthDrop) hits.push("monthDrop");
    if (fromHigh <= cfg.triggers.from52WeekHigh) hits.push("from52WeekHigh");
    if (hits.length === 0) continue;
    const uni = byTicker.get(q.symbol);
    triggered.push({
      ticker: q.symbol,
      title: uni?.title ?? "",
      cik: uni?.cik ?? 0,
      price: q.price,
      marketCapB: q.marketCap / 1e9,
      dayChange: q.dayChange,
      monthChange,
      fromHigh,
      sector: null,
      triggers: hits.sort((a, b) => TRIGGER_RANK[a] - TRIGGER_RANK[b]),
    });
  }

  // Sector exclusion (financials/REITs, PLAN.md §5) — trigger-hitters only.
  const sectorExcluded: string[] = [];
  const kept: Candidate[] = [];
  for (const c of triggered) {
    c.sector = await getSector(c.ticker);
    if (c.sector && (cfg.excludeSectors as readonly string[]).includes(c.sector)) {
      sectorExcluded.push(`${c.ticker} (${c.sector})`);
    } else {
      kept.push(c);
    }
  }

  // Rank by drop recency/severity, NOT market cap (PLAN.md §5 rationale).
  kept.sort((a, b) => {
    const ra = TRIGGER_RANK[a.triggers[0]!];
    const rb = TRIGGER_RANK[b.triggers[0]!];
    if (ra !== rb) return ra - rb;
    return severityValue(a) - severityValue(b);
  });
  const candidates = kept.slice(0, cfg.maxCandidates);
  const overflowDropped = kept.slice(cfg.maxCandidates).map((c) => c.ticker);

  return {
    candidates,
    stats: {
      universe: universe.length,
      quoted: quotes.length,
      quoteFailed,
      passedFloors: floorPass.length,
      monthChecked: monthCheckList.length,
      monthCheckSkipped,
      triggered: triggered.length,
      sectorExcluded,
      overflowDropped,
    },
  };
}

function severityValue(c: Candidate): number {
  switch (c.triggers[0]!) {
    case "dayDrop":
      return c.dayChange;
    case "monthDrop":
      return c.monthChange ?? 0;
    case "from52WeekHigh":
      return c.fromHigh;
  }
}
