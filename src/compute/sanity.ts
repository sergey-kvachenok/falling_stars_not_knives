import type { FactsByConcept } from "../edgar/companyfacts.js";
import type { ComputedMetrics } from "./metrics.js";

// ---------------------------------------------------------------------------
// Sanity layer (PLAN.md §7.1). A wrongly computed metric presented to the LLM
// as ground truth is worse than a missing one — citation validation will bless
// claims derived from it. Failures don't drop the ticker; they set a
// `degraded` confidence flag that travels in the bundle and is stated in the
// prompt. Expect 10–20% of candidates to trip at least one check.
// ---------------------------------------------------------------------------

export interface SanityResult {
  confidence: "high" | "degraded";
  flags: string[];
}

const BALANCE_TOLERANCE = 0.02; // |A − (L+E)| / A
const REVENUE_JUMP_SUSPECT = 0.5; // |QoQ| beyond this → continuity check
const QUARTER_GAP_DAYS_MAX = 100;

export function sanityCheck(series: FactsByConcept, metrics: ComputedMetrics): SanityResult {
  const flags: string[] = [];

  // 1. Balance-sheet identity: assets ≈ liabilities + equity.
  const assets = latestInstant(series, "assets");
  const liabilities = latestInstant(series, "liabilities");
  const equity = latestInstant(series, "equity");
  if (assets && liabilities && equity && assets.end === liabilities.end && assets.end === equity.end) {
    const gap = Math.abs(assets.val - (liabilities.val + equity.val)) / Math.abs(assets.val);
    if (gap > BALANCE_TOLERANCE) {
      flags.push(
        `balance-identity: assets vs liabilities+equity differ by ${(gap * 100).toFixed(1)}% at ${assets.end}` +
          ` (likely minority interest under a different tag, or extraction error)`,
      );
    }
  }

  // 2. Sign/magnitude bounds.
  const gross = metrics.margins.grossPct?.latestPct;
  if (gross !== undefined && gross !== null && (gross > 100 || gross < -100)) {
    flags.push(`margin-bounds: gross margin ${gross}% is outside [-100, 100]`);
  }
  const revQ = metrics.revenue.latestQ?.value;
  if (revQ !== undefined && revQ !== null && revQ < 0) {
    flags.push(`sign: latest quarterly revenue is negative (${revQ})`);
  }

  // 3. Series continuity: a huge QoQ revenue jump is more often a phantom
  //    discontinuity (tag switch, period misalignment) than a finding.
  //    Only the recent window matters — ancient tag switches shouldn't
  //    degrade a company whose current data is clean.
  const rev = (series.revenue?.quarterly ?? []).slice(-8);
  for (let i = 1; i < rev.length; i++) {
    const prev = rev[i - 1]!;
    const cur = rev[i]!;
    if (prev.val !== 0 && Math.abs(cur.val - prev.val) / Math.abs(prev.val) > REVENUE_JUMP_SUSPECT) {
      flags.push(
        `continuity: revenue moved ${prev.val} → ${cur.val} between ${prev.end} and ${cur.end} (>50% QoQ; verify before treating as a finding)`,
      );
    }
  }

  // 4. Period alignment: consecutive revenue quarters should be ~90 days apart.
  for (let i = 1; i < rev.length; i++) {
    const gapDays = Math.round((Date.parse(rev[i]!.end) - Date.parse(rev[i - 1]!.end)) / 86_400_000);
    if (gapDays > QUARTER_GAP_DAYS_MAX) {
      flags.push(
        `alignment: gap of ${gapDays} days between quarters ending ${rev[i - 1]!.end} and ${rev[i]!.end} (missing quarter in series)`,
      );
    }
  }

  // 5. Coverage: core concepts that resolved to no tag at all.
  for (const name of ["revenue", "operatingIncome", "cfo", "assets"]) {
    if (!series[name]?.tag) flags.push(`coverage: no XBRL tag matched for '${name}'`);
  }

  return { confidence: flags.length === 0 ? "high" : "degraded", flags };
}

function latestInstant(series: FactsByConcept, name: string) {
  const pts = series[name]?.instant ?? [];
  return pts[pts.length - 1];
}
