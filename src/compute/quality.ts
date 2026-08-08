import { weightedAnchorPrice } from "./anchors.js";
import { adjustFairValue, loadCalibration } from "./calibration.js";
import { config } from "../config.js";
import type { TickerBundle } from "../bundle/build.js";
import type { Verdict } from "../analyst/schemas.js";

// Digest admission gate ("don't pull shit into the list"): only healthy,
// meaningfully undervalued names get in. Deterministic gates run on computed
// metrics; the moat gate uses the LLM's judgment. Every exclusion carries its
// reason — no silent drops (PLAN.md §11).

export interface GateResult {
  pass: boolean;
  fairValue: number | null; // raw blended anchor
  /** Calibration-corrected fair value — what the gate and displays actually use once Loop 3 is active. */
  fairValueAdjusted: number | null;
  calibrationActive: boolean;
  undervaluationPct: number | null; // (effective fair − price) / effective fair × 100
  reasons: string[]; // why excluded (empty when pass)
}

export function digestGate(bundle: TickerBundle, verdict: Verdict | null): GateResult {
  const reasons: string[] = [];
  const m = bundle.metrics;
  const price = bundle.drop?.price ?? null;

  if (!verdict) {
    return {
      pass: false,
      fairValue: null,
      fairValueAdjusted: null,
      calibrationActive: false,
      undervaluationPct: null,
      reasons: ["no grounded verdict"],
    };
  }
  if (verdict.insufficientEvidence) reasons.push("insufficient evidence — fair value has no filing basis");

  const fairValue = weightedAnchorPrice(verdict.scenarios, m, "1");
  // Loop 3: once enough predictions matured, the measured bias corrects the
  // fair value BEFORE gating — the system spends its own track record.
  const cal = loadCalibration();
  const adj = fairValue !== null ? adjustFairValue(fairValue, cal) : null;
  const effectiveFair = adj?.adjusted ?? fairValue;
  let undervaluationPct: number | null = null;
  if (effectiveFair === null) {
    reasons.push("scenarios did not price — no fair value");
  } else if (price === null) {
    reasons.push("no current price");
  } else {
    undervaluationPct = Math.round(((effectiveFair - price) / effectiveFair) * 1000) / 10;
    if (price > effectiveFair * (1 - config.valuation.requiredDiscountToFair)) {
      const calNote = adj?.active ? " (calibration-adjusted)" : "";
      reasons.push(
        undervaluationPct < 0
          ? `price ${Math.abs(undervaluationPct)}% ABOVE fair value${calNote}`
          : `only ${undervaluationPct}% below fair value${calNote} (need ≥ ${config.valuation.requiredDiscountToFair * 100}%)`,
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

  // Economic qualification (expectations investing): the market must be
  // implying meaningfully LESS growth than the street expects — otherwise
  // the "undervaluation" is only our multiple math disagreeing with the
  // market's. Price below the EPV floor (worth more with zero growth) also
  // qualifies.
  const eco = bundle.drop?.economics;
  if (eco && price !== null) {
    const belowEpv = eco.epvPerShare !== null && price < eco.epvPerShare;
    const gapOk = eco.expectationsGapPts !== null && eco.expectationsGapPts >= config.economics.minExpectationsGapPts;
    if (!belowEpv && !gapOk) {
      reasons.push(
        eco.expectationsGapPts !== null
          ? `no expectations gap: market implies ${eco.impliedGrowthPct}%/yr vs street ${eco.streetGrowthPct}% (gap ${eco.expectationsGapPts}pts, need ≥${config.economics.minExpectationsGapPts}) and price above EPV floor`
          : `economic view incomputable (no positive FCF/earnings to capitalize) — cannot verify the discount economically`,
      );
    }
  }

  // Value-creation test: growth funded below its cost of capital destroys
  // value — a cheap-looking compounder of negative spreads is a trap.
  // Bypass: GAAP expenses R&D immediately, so research-heavy compounders show
  // depressed ROIC; a fat owner-FCF margin (already after SBC) proves value
  // creation regardless of the GAAP formula.
  const fcfMarginPct = m.margins?.fcfPct?.latestPct ?? null;
  const fcfBypass = fcfMarginPct !== null && fcfMarginPct >= config.quality.roicBypassFcfMarginPct;
  if (eco?.roicPct != null && eco.roicPct < eco.discountRatePctUsed && !fcfBypass) {
    reasons.push(
      `ROIC ${eco.roicPct}% below cost of capital ${eco.discountRatePctUsed}% — growth destroys value here (no FCF-margin bypass: ${fcfMarginPct ?? "?"}% < ${config.quality.roicBypassFcfMarginPct}%)`,
    );
  }

  // Winner's-curse guard: when our fair value dwarfs the street's, the
  // likeliest explanation is our assumptions, not a market-wide blind spot.
  const street = bundle.drop?.analystTargetPrice;
  if (effectiveFair !== null && street && street > 0 && effectiveFair > street * 1.75) {
    reasons.push(
      `AI fair value $${effectiveFair} is ${(effectiveFair / street).toFixed(1)}× the street target $${street} — optimism unsupported by consensus`,
    );
  }

  // Degraded metrics can't certify health.
  if (bundle.sanity.confidence === "degraded") reasons.push("metrics confidence degraded");

  return {
    pass: reasons.length === 0,
    fairValue,
    fairValueAdjusted: adj?.active ? adj.adjusted : null,
    calibrationActive: adj?.active ?? false,
    undervaluationPct,
    reasons,
  };
}

const fmtB = (x: number | null): string => (x === null ? "unknown" : `$${(x / 1e9).toFixed(2)}B`);
