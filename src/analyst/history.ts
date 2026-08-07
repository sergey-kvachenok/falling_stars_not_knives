import { loadPredictions } from "../scoring/predictions.js";

// Analyst memory (cross-run): a ticker's prior verdicts, sourced from the
// predictions ledger — the same durable record the scoring loop grades. The
// analyst sees its own earlier take and must say what changed, instead of
// re-deriving the story from scratch every night.

export interface PriorLook {
  runDate: string;
  classification: string;
  thesis?: string;
  falsifierSummary?: string; // "2 fired, 1 uncheckable" once the 90d grading ran
  refPrice?: number;
  snapshot?: import("../scoring/predictions.js").LookSnapshot;
}

export function getTickerHistory(ticker: string, limit = 3): PriorLook[] {
  return loadPredictions()
    .filter((p) => p.ticker === ticker)
    .sort((a, b) => a.runDate.localeCompare(b.runDate))
    .slice(-limit)
    .map((p) => ({
      runDate: p.runDate,
      classification: p.classification,
      refPrice: p.refPrice,
      ...(p.snapshot ? { snapshot: p.snapshot } : {}),
      ...(p.thesis ? { thesis: p.thesis } : {}),
      ...(p.falsifierGrades
        ? {
            falsifierSummary: `${p.falsifierGrades.filter((g) => g.status === "fired").length} fired, ${
              p.falsifierGrades.filter((g) => g.status === "survived").length
            } survived, ${p.falsifierGrades.filter((g) => g.status === "uncheckable").length} uncheckable`,
          }
        : {}),
    }));
}

export const priorSourceId = (runDate: string): string => `prior:${runDate}`;
