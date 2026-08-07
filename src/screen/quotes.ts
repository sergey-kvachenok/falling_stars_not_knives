import YahooFinance from "yahoo-finance2";
import { config } from "../config.js";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

export interface QuoteLite {
  symbol: string;
  price: number;
  dayChange: number; // fraction, e.g. -0.21
  marketCap: number;
  avgVolume: number;
  fiftyTwoWeekHigh: number;
  fiftyDayAverage: number | null;
  analystTarget: number | null; // Wall Street consensus (targetMeanPrice)
  quoteType: string;
  market: string;
  currency: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Batch quote sweep over the whole universe — a few dozen requests total
 * (PLAN.md §5.1). Failed chunks are retried once, then logged and skipped;
 * dropped symbol counts are reported, never silent.
 */
export async function sweepQuotes(symbols: string[]): Promise<{ quotes: QuoteLite[]; failed: number }> {
  const quotes: QuoteLite[] = [];
  let failed = 0;
  const size = config.yahoo.quoteChunkSize;
  for (let i = 0; i < symbols.length; i += size) {
    const chunk = symbols.slice(i, i + size);
    let results: unknown[] | undefined;
    for (let attempt = 0; attempt < 2 && !results; attempt++) {
      try {
        results = (await yf.quote(chunk, {}, { validateResult: false })) as unknown[];
      } catch (err) {
        if (attempt === 1) {
          console.warn(`  quote chunk ${i}-${i + chunk.length} failed twice, skipping: ${(err as Error).message}`);
          failed += chunk.length;
        } else {
          await sleep(1500);
        }
      }
    }
    for (const raw of results ?? []) {
      const q = raw as Record<string, unknown>;
      if (typeof q?.symbol !== "string") continue;
      quotes.push({
        symbol: q.symbol,
        price: num(q.regularMarketPrice),
        dayChange: num(q.regularMarketChangePercent) / 100,
        marketCap: num(q.marketCap),
        avgVolume: num(q.averageDailyVolume3Month),
        fiftyTwoWeekHigh: num(q.fiftyTwoWeekHigh),
        fiftyDayAverage: typeof q.fiftyDayAverage === "number" ? q.fiftyDayAverage : null,
        analystTarget: typeof q.targetMeanPrice === "number" ? q.targetMeanPrice : null,
        quoteType: str(q.quoteType),
        market: str(q.market),
        currency: str(q.currency),
      });
    }
    await sleep(config.yahoo.chunkDelayMs);
  }
  return { quotes, failed };
}

/** Trailing ~21-trading-day return, chart-verified (PLAN.md §5.1 step 3). */
export async function monthReturn(symbol: string): Promise<number | null> {
  try {
    const period1 = new Date(Date.now() - 45 * 86_400_000);
    const res = (await yf.chart(symbol, { period1, interval: "1d" }, { validateResult: false })) as {
      quotes?: { close: number | null }[];
    };
    const closes = (res.quotes ?? [])
      .map((b: { close: number | null }) => b.close)
      .filter((c: number | null): c is number => typeof c === "number");
    if (closes.length < 15) return null;
    const ref = closes[Math.max(0, closes.length - 22)]!;
    const last = closes[closes.length - 1]!;
    return last / ref - 1;
  } catch {
    return null;
  }
}

/**
 * Total return from the first close on/after `sinceDate` to the latest close.
 * Returns null when history is unavailable (delisted — trap #7; caller
 * resolves per the PLAN.md §10 rule).
 */
export async function returnSince(symbol: string, sinceDate: string): Promise<number | null> {
  try {
    const res = (await yf.chart(
      symbol,
      { period1: new Date(sinceDate), interval: "1d" },
      { validateResult: false },
    )) as { quotes?: { close: number | null }[] };
    const closes = (res.quotes ?? [])
      .map((b) => b.close)
      .filter((c): c is number => typeof c === "number");
    if (closes.length < 2) return null;
    return closes[closes.length - 1]! / closes[0]! - 1;
  } catch {
    return null;
  }
}

/**
 * Street consensus target — not in the batch quote payload; requires the
 * per-symbol financialData module. Digest names only (≤10 calls/run).
 */
export async function getAnalystTarget(symbol: string): Promise<number | null> {
  try {
    const res = (await yf.quoteSummary(symbol, { modules: ["financialData"] }, { validateResult: false })) as {
      financialData?: { targetMeanPrice?: number };
    };
    const t = res.financialData?.targetMeanPrice;
    return typeof t === "number" && t > 0 ? t : null;
  } catch {
    return null;
  }
}

/** Sector lookup for the financials/REIT exclusion — survivors only, ≤ a few dozen calls. */
export async function getSector(symbol: string): Promise<string | null> {
  try {
    const res = await yf.quoteSummary(symbol, { modules: ["summaryProfile"] }, { validateResult: false });
    return (res as { summaryProfile?: { sector?: string } }).summaryProfile?.sector ?? null;
  } catch {
    return null;
  }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
