import { config } from "../config.js";
import { readState } from "../lib/state.js";

// Loop 3 — self-calibration. The scoring job measures realized-vs-fair error
// on every prediction that reaches its 1-year grading and stores the rolling
// bias here. Once enough samples exist, the measured bias corrects the fair
// values the system displays AND gates on. Until then it is reported, not
// applied — correcting from a handful of samples would be fitting noise.

export interface CalibrationState {
  n: number;
  meanErrorPct: number; // mean of (realized − fair) / fair × 100; negative = fair values ran hot
  medianErrorPct?: number;
  byClassification?: Record<string, { n: number; meanErrorPct: number }>;
  updatedAt: string;
}

export function loadCalibration(): CalibrationState | null {
  const cal = readState<CalibrationState | null>("calibration", null);
  return cal && typeof cal.n === "number" && typeof cal.meanErrorPct === "number" ? cal : null;
}

export interface AdjustedFair {
  raw: number;
  adjusted: number;
  active: boolean; // false = not enough matured samples yet; raw stands
  n: number;
  scope: "class" | "global" | "none"; // which bias scalar applied
}

export function adjustFairValue(
  raw: number,
  cal: CalibrationState | null,
  classification?: string,
): AdjustedFair {
  if (!cal || cal.n < config.calibration.minSamples) {
    return { raw, adjusted: raw, active: false, n: cal?.n ?? 0, scope: "none" };
  }
  // Bias is rarely uniform across drop types — use the per-classification
  // scalar when that class has enough matured samples, global otherwise.
  let errorPct = cal.meanErrorPct;
  let n = cal.n;
  let scope: AdjustedFair["scope"] = "global";
  const bucket = classification ? cal.byClassification?.[classification] : undefined;
  if (bucket && bucket.n >= config.calibration.minSamplesPerClass) {
    errorPct = bucket.meanErrorPct;
    n = bucket.n;
    scope = "class";
  }
  const factor = Math.min(
    config.calibration.maxAdjustFactor,
    Math.max(config.calibration.minAdjustFactor, 1 + errorPct / 100),
  );
  return { raw, adjusted: Math.round(raw * factor * 100) / 100, active: true, n, scope };
}

export interface FastGuardState {
  firedShare: number; // fired / (fired + survived) among graded falsifiers
  n: number;
  updatedAt: string;
}

/** Extra discount demanded when recent kill-switches are firing at a high rate. */
export function fastGuardExtraDiscount(): number {
  const g = readState<FastGuardState | null>("fastguard", null);
  if (!g || g.n < config.calibration.fastGuardMinGraded) return 0;
  return g.firedShare > config.calibration.fastGuardFiredShare
    ? config.calibration.fastGuardExtraDiscount
    : 0;
}
