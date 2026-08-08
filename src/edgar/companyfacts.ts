import { CONCEPTS, type ConceptDef } from "./concepts.js";
import { cik10, edgarGetJson } from "./http.js";

// ---------------------------------------------------------------------------
// companyfacts normalization — the messiest part of the build (PLAN.md §4.1).
// Rules encoded here:
//   * Period identity is (start, end) DATES, never fy/fp or array position —
//     fy/fp describe the report a fact came from, not the fact's own period.
//   * Restatements: the same period can appear in several filings; the fact
//     with the latest `filed` date wins.
//   * Q4 is never filed separately: quarterly values are derived from YTD
//     diffs (cash-flow statements are usually YTD-only in 10-Qs) and from
//     FY − 9M for the fourth quarter.
// ---------------------------------------------------------------------------

export interface RawFact {
  start?: string;
  end: string;
  val: number;
  accn: string;
  form: string;
  filed: string;
  fy?: number;
  fp?: string;
  frame?: string;
}

export interface QuarterPoint {
  start: string;
  end: string;
  val: number;
  accn: string;
  derived: "direct" | "ytd-diff";
}

export interface InstantPoint {
  end: string;
  val: number;
  accn: string;
}

export interface ConceptSeries {
  concept: string;
  tag: string | null; // which fallback tag matched; null = concept missing
  quarterly: QuarterPoint[]; // oldest → newest; duration concepts only
  annual: QuarterPoint[]; // FY duration facts, oldest → newest
  instant: InstantPoint[]; // oldest → newest; instant concepts only
}

export type FactsByConcept = Record<string, ConceptSeries>;

interface RawCompanyFacts {
  entityName: string;
  facts: Record<string, Record<string, { units: Record<string, RawFact[]> }>>;
}

// ~5 years + one for YoY math: long enough for through-cycle performance
// (CAGR, margin trajectory, FCF consistency) and full-cycle multiple bands.
const KEEP_QUARTERS = 21;

export async function getCompanyFacts(cik: number): Promise<{ entityName: string; series: FactsByConcept }> {
  const id = cik10(cik);
  const raw = await edgarGetJson<RawCompanyFacts>(
    `https://data.sec.gov/api/xbrl/companyfacts/CIK${id}.json`,
    { cacheKey: `companyfacts-${id}.json`, ttlHours: 24 },
  );
  const series: FactsByConcept = {};
  for (const def of CONCEPTS) {
    series[def.name] = extractConcept(raw, def);
  }
  return { entityName: raw.entityName, series };
}

export function extractConcept(raw: RawCompanyFacts, def: ConceptDef): ConceptSeries {
  const taxonomy = raw.facts[def.taxonomy] ?? {};
  // Pick the fallback tag with the most recent data; tie-break by point count.
  // Single-tag selection keeps a series from silently mixing tags (PLAN.md §7.1).
  let best: { tag: string; facts: RawFact[] } | null = null;
  for (const tag of def.tags) {
    const units = taxonomy[tag]?.units ?? {};
    const unitKey = Object.keys(units).find((u) => u === def.unit) ?? Object.keys(units)[0];
    const facts = unitKey ? (units[unitKey] ?? []) : [];
    if (facts.length === 0) continue;
    if (!best || latestEnd(facts) > latestEnd(best.facts)) {
      best = { tag, facts };
    }
  }
  if (!best) {
    return { concept: def.name, tag: null, quarterly: [], annual: [], instant: [] };
  }
  if (def.kind === "instant") {
    return {
      concept: def.name,
      tag: best.tag,
      quarterly: [],
      annual: [],
      instant: normalizeInstant(best.facts).slice(-KEEP_QUARTERS),
    };
  }
  const { quarterly, annual } = normalizeDuration(best.facts);
  return {
    concept: def.name,
    tag: best.tag,
    quarterly: quarterly.slice(-KEEP_QUARTERS),
    annual: annual.slice(-6),
    instant: [],
  };
}

function latestEnd(facts: RawFact[]): string {
  return facts.reduce((max, f) => (f.end > max ? f.end : max), "");
}

export function normalizeInstant(facts: RawFact[]): InstantPoint[] {
  const byEnd = new Map<string, RawFact>();
  for (const f of facts) {
    const prev = byEnd.get(f.end);
    if (!prev || f.filed > prev.filed) byEnd.set(f.end, f);
  }
  return [...byEnd.values()]
    .sort((a, b) => a.end.localeCompare(b.end))
    .map((f) => ({ end: f.end, val: f.val, accn: f.accn }));
}

/**
 * Duration normalization. Facts arrive as a mix of discrete quarters
 * (~91 days), cumulative YTD (~182/~273 days), and fiscal years (~365 days).
 * Strategy: dedupe by (start, end) keeping latest-filed, take discrete
 * quarters directly, then fill gaps by diffing consecutive cumulative facts
 * that share a fiscal-year start (Q4 = FY − 9M falls out of the same rule).
 */
export function normalizeDuration(facts: RawFact[]): { quarterly: QuarterPoint[]; annual: QuarterPoint[] } {
  const byPeriod = new Map<string, RawFact>();
  for (const f of facts) {
    if (!f.start) continue;
    const key = `${f.start}|${f.end}`;
    const prev = byPeriod.get(key);
    if (!prev || f.filed > prev.filed) byPeriod.set(key, f);
  }
  const all = [...byPeriod.values()];

  const days = (f: RawFact) =>
    Math.round((Date.parse(f.end) - Date.parse(f.start!)) / 86_400_000);

  const quarters = new Map<string, QuarterPoint>(); // key: end date
  const annual: QuarterPoint[] = [];

  for (const f of all) {
    const d = days(f);
    if (d >= 80 && d <= 100) {
      quarters.set(f.end, { start: f.start!, end: f.end, val: f.val, accn: f.accn, derived: "direct" });
    } else if (d >= 350 && d <= 380) {
      annual.push({ start: f.start!, end: f.end, val: f.val, accn: f.accn, derived: "direct" });
    }
  }

  // Group cumulative facts by fiscal-year start; diff consecutive checkpoints.
  const byStart = new Map<string, RawFact[]>();
  for (const f of all) {
    const d = days(f);
    if (d < 80 || d > 380) continue;
    const group = byStart.get(f.start!) ?? [];
    group.push(f);
    byStart.set(f.start!, group);
  }
  for (const group of byStart.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.end.localeCompare(b.end));
    for (let i = 1; i < group.length; i++) {
      const prev = group[i - 1]!;
      const cur = group[i]!;
      const segDays = Math.round((Date.parse(cur.end) - Date.parse(prev.end)) / 86_400_000);
      if (segDays < 80 || segDays > 100) continue; // only clean quarter segments
      if (quarters.has(cur.end)) continue; // direct value wins
      const segStart = new Date(Date.parse(prev.end) + 86_400_000).toISOString().slice(0, 10);
      quarters.set(cur.end, {
        start: segStart,
        end: cur.end,
        val: cur.val - prev.val,
        accn: cur.accn,
        derived: "ytd-diff",
      });
    }
  }

  return {
    quarterly: [...quarters.values()].sort((a, b) => a.end.localeCompare(b.end)),
    annual: annual.sort((a, b) => a.end.localeCompare(b.end)),
  };
}
