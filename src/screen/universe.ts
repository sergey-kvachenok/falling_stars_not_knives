import { config } from "../config.js";
import { fetchJsonCached } from "../lib/cache.js";

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

export interface UniverseEntry {
  cik: number;
  ticker: string;
  title: string;
}

interface RawEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

/**
 * Universe seed: all SEC registrants with a listed ticker (~10k), from EDGAR's
 * daily ticker file (PLAN.md §5.1). One share class per CIK; obvious
 * warrant/unit suffixes dropped — the liquidity floors kill the rest.
 */
export async function getUniverse(): Promise<UniverseEntry[]> {
  const raw = await fetchJsonCached<Record<string, RawEntry>>(
    TICKERS_URL,
    "company_tickers.json",
    24,
    { "User-Agent": config.edgar.userAgent },
  );
  const seenCik = new Set<number>();
  const out: UniverseEntry[] = [];
  for (const entry of Object.values(raw)) {
    if (seenCik.has(entry.cik_str)) continue;
    if (!/^[A-Z]{1,5}(-[A-Z])?$/.test(entry.ticker)) continue;
    seenCik.add(entry.cik_str);
    out.push({ cik: entry.cik_str, ticker: entry.ticker, title: entry.title });
  }
  return out;
}
