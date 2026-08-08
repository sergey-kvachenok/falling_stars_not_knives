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
}

export function adjustFairValue(raw: number, cal: CalibrationState | null): AdjustedFair {
  if (!cal || cal.n < config.calibration.minSamples) {
    return { raw, adjusted: raw, active: false, n: cal?.n ?? 0 };
  }
  const factor = Math.min(
    config.calibration.maxAdjustFactor,
    Math.max(config.calibration.minAdjustFactor, 1 + cal.meanErrorPct / 100),
  );
  return { raw, adjusted: Math.round(raw * factor * 100) / 100, active: true, n: cal.n };
}
