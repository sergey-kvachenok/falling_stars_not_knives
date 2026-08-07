import { weightedAnchorPrice } from "./anchors.js";
import { config } from "../config.js";
import type { TickerBundle } from "../bundle/build.js";
import type { Verdict } from "../analyst/schemas.js";

// Digest admission gate ("don't pull shit into the list"): only healthy,
// meaningfully undervalued names get in. Deterministic gates run on computed
// metrics; the moat gate uses the LLM's judgment. Every exclusion carries its
// reason — no silent drops (PLAN.md §11).

export interface GateResult {
  pass: boolean;
  fairValue: number | null;
  undervaluationPct: number | null; // (fair − price) / fair × 100
  reasons: string[]; // why excluded (empty when pass)
}

export function digestGate(bundle: TickerBundle, verdict: Verdict | null): GateResult {
  const reasons: string[] = [];
  const m = bundle.metrics;
  const price = bundle.drop?.price ?? null;

  if (!verdict) {
    return { pass: false, fairValue: null, undervaluationPct: null, reasons: ["no grounded verdict"] };
  }
  if (verdict.insufficientEvidence) reasons.push("insufficient evidence — fair value has no filing basis");

  const fairValue = weightedAnchorPrice(verdict.scenarios, m, "1");
  let undervaluationPct: number | null = null;
  if (fairValue === null) {
    reasons.push("scenarios did not price — no fair value");
  } else if (price === null) {
    reasons.push("no current price");
  } else {
    undervaluationPct = Math.round(((fairValue - price) / fairValue) * 1000) / 10;
    if (price > fairValue * (1 - config.valuation.requiredDiscountToFair)) {
      reasons.push(
        undervaluationPct < 0
          ? `price ${Math.abs(undervaluationPct)}% ABOVE fair value`
          : `only ${undervaluationPct}% below fair value (need ≥ ${config.valuation.requiredDiscountToFair * 100}%)`,
      );
    }
  }

  // Health: low debt.
  const nde = m.balance.netDebtToEbitdaTtm;
  const netDebt = m.balance.netDebt;
  const lowDebt = (netDebt !== null && netDebt <= 0) || (nde !== null && nde <= config.quality.maxNetDebtToEbitda);
  if (!lowDebt) {
    reasons.push(`debt too high (netDebt/EBITDA ${nde ?? "unknown"}, net debt ${fmtB(netDebt)})`);
  }

  // Health: real free cash flow.
  if (config.quality.requirePositiveFcfTtm) {
    const fcfTtm = m.ttm.fcf;
    if (fcfTtm === null || fcfTtm <= 0) reasons.push(`no positive TTM free cash flow (${fmtB(fcfTtm)})`);
  }

  // Moat and prospects — the LLM's call.
  if (!(config.quality.acceptedMoats as readonly string[]).includes(verdict.moat?.assessment)) {
    reasons.push(`moat: ${verdict.moat?.assessment ?? "missing"}`);
  }

  // Degraded metrics can't certify health.
  if (bundle.sanity.confidence === "degraded") reasons.push("metrics confidence degraded");

  return { pass: reasons.length === 0, fairValue, undervaluationPct, reasons };
}

const fmtB = (x: number | null): string => (x === null ? "unknown" : `$${(x / 1e9).toFixed(2)}B`);
