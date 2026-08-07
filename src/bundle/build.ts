import { getCompanyFacts } from "../edgar/companyfacts.js";
import { fetch8KPressRelease, fetchMdaSection, type FetchedDocument } from "../edgar/documents.js";
import { filingsSince, getSubmissions, latestFiling } from "../edgar/submissions.js";
import { computeMetrics, type ComputedMetrics } from "../compute/metrics.js";
import { sanityCheck, type SanityResult } from "../compute/sanity.js";

// How far back to look for the 8-K that explains the drop (PLAN.md §4.1),
// and how many recent 8-Ks to include (consecutive releases enable the
// guidance old-vs-new diff in Phase 4).
const DROP_WINDOW_DAYS = 45;
const MAX_8KS = 2;

export interface TickerBundle {
  ticker: string;
  cik: number;
  builtAt: string;
  company: {
    name: string;
    sic: string;
    sicDescription: string;
    isDomesticFiler: boolean;
  };
  /** Screen context — informational; excluded from the bundle hash (PLAN.md §6.2). */
  drop?: {
    price?: number;
    dayChangePct?: number;
    monthChangePct?: number | null;
    fromHighPct?: number;
    analystTargetPrice?: number | null; // street consensus, shown for contrast only
    triggers?: string[];
    /** Company's own historical multiple percentiles — bounds the AI's multiples. */
    multipleRanges?: import("../compute/multiples.js").MultipleRange[];
    /** Street next-FY revenue consensus — anchors assumed values. */
    streetRevenue1yUsd?: number | null;
  };
  documents: {
    /** Empty = no filing explains the drop window. That absence is itself a signal. */
    recent8Ks: FetchedDocument[];
    latestQuarterly: FetchedDocument | null; // 10-Q, or 10-K if more recent
  };
  metrics: ComputedMetrics;
  sanity: SanityResult;
  facts: Record<string, unknown>; // normalized series — the citation targets
}

export interface BuildResult {
  bundle: TickerBundle | null;
  skippedReason?: string;
}

export async function buildBundle(
  ticker: string,
  cik: number,
  drop?: TickerBundle["drop"],
): Promise<BuildResult> {
  const profile = await getSubmissions(cik);

  // ADRs leak through the Yahoo pre-filter (seen in Phase 1: KXIAY) —
  // this is the authoritative domestic-filer check (PLAN.md §5.1 step 4).
  if (!profile.isDomesticFiler) {
    return { bundle: null, skippedReason: `foreign filer (${profile.name})` };
  }

  const { series } = await getCompanyFacts(cik);
  const metrics = computeMetrics(series);
  const sanity = sanityCheck(series, metrics);

  const sinceIso = new Date(Date.now() - DROP_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const recent8Ks: FetchedDocument[] = [];
  for (const filing of filingsSince(profile, "8-K", sinceIso).slice(0, MAX_8KS)) {
    const doc = await fetch8KPressRelease(cik, filing);
    if (doc) recent8Ks.push(doc);
  }

  const tenQ = latestFiling(profile, "10-Q");
  const tenK = latestFiling(profile, "10-K");
  const quarterly =
    tenQ && (!tenK || tenQ.filedAt > tenK.filedAt) ? tenQ : (tenK ?? tenQ);
  const latestQuarterly = quarterly ? await fetchMdaSection(cik, quarterly) : null;

  const bundle: TickerBundle = {
    ticker,
    cik,
    builtAt: new Date().toISOString(),
    company: {
      name: profile.name,
      sic: profile.sic,
      sicDescription: profile.sicDescription,
      isDomesticFiler: profile.isDomesticFiler,
    },
    drop,
    documents: { recent8Ks, latestQuarterly },
    metrics,
    sanity,
    facts: Object.fromEntries(
      Object.entries(series).map(([name, s]) => [
        name,
        { tag: s.tag, quarterly: s.quarterly, annual: s.annual, instant: s.instant },
      ]),
    ),
  };
  return { bundle };
}
