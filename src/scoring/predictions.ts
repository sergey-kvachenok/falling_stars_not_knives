import { readState, writeState } from "../lib/state.js";
import type { Verdict } from "../analyst/schemas.js";

// Predictions ledger (PLAN.md §10) — recorded from day one so no data is
// lost before the loop matures. File-backed until Phase 3.

export interface LookSnapshot {
  asOfQuarter: string | null;
  revenueTtm: number | null;
  grossPct: number | null;
  opPct: number | null;
  netDebt: number | null;
  shares: number | null;
  accessions: string[];
}

export interface FalsifierGrade {
  scenario: string; // "1y bear" etc.
  falsifier: string;
  status: "fired" | "survived" | "uncheckable";
  evidence: string;
}

export interface Prediction {
  ticker: string;
  runDate: string;
  rank: number;
  classification: string;
  thesis?: string;
  bundleHash: string;
  refPrice: number;
  scenarios: Verdict["scenarios"];
  /** Compact state snapshot — lets a later look diff the two states in code. */
  snapshot?: LookSnapshot;
  /** Valuation at record time — calibration inputs (improvement #4). */
  fairValue1y?: number | null;
  implied1y?: { bear: number | null; base: number | null; bull: number | null };
  /** Everything needed to audit the decision later (Loop 3 verification). */
  undervaluationPct?: number | null;
  economics?: import("../compute/economics.js").EconomicView;
  promptVersion?: number;
  /** Fair value after calibration adjustment, when the correction was active. */
  fairValue1yAdjusted?: number | null;
  /** Realized-vs-fair error at 1y, percent; filled by the scoring job. */
  valuationErrorPct?: number | null;
  // Filled in by the scoring job as the prediction ages:
  drift30?: number | null; // return vs SPY, fraction
  drift90?: number | null;
  return1y?: number | null;
  return3y?: number | null;
  falsifierGrades?: FalsifierGrade[];
  resolutionNote?: string; // "acquired", "delisted", …
  updatedAt?: string;
}

export function loadPredictions(): Prediction[] {
  return readState<Prediction[]>("predictions", []);
}

export function savePredictions(all: Prediction[]): void {
  writeState("predictions", all);
}

export function appendPredictions(fresh: Prediction[]): void {
  const all = loadPredictions();
  // One prediction per (ticker, runDate) — a same-day re-run replaces.
  const key = (p: Prediction) => `${p.ticker}|${p.runDate}`;
  const freshKeys = new Set(fresh.map(key));
  savePredictions([...all.filter((p) => !freshKeys.has(key(p))), ...fresh]);
}
