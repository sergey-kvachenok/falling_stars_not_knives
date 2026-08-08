import { entryPrice, impliedPrice, weightedAnchorPrice } from "../compute/anchors.js";
import { adjustFairValue, loadCalibration } from "../compute/calibration.js";
import { config } from "../config.js";
import type { CardRow } from "../lib/db.js";
import type { DigestEntry } from "./report.js";

// Expanded ticker card (Telegram HTML) — precomputed by the nightly pipeline
// and stored in the cards table; the webhook sends it the instant a 👍 lands,
// appending the live price and its discount/premium to the blended anchor.
// Telegram messages cap at 4096 chars; the card stays well under.

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const $ = (p: number | null): string => (p === null ? "—" : `$${p >= 100 ? p.toFixed(0) : p.toFixed(2)}`);

export function buildExpandedCard(e: DigestEntry): CardRow {
  const v = e.analysis.verdict;
  const m = e.bundle.metrics;
  const c = e.analysis.classification;
  const refPrice = e.bundle.drop?.price ?? null;
  const weightedAnchor1y = v ? weightedAnchorPrice(v.scenarios, m, "1") : null;

  const parts: string[] = [
    `<b>${esc(e.ticker)} — ${esc(cut(e.bundle.company.name, 40))}</b>`,
    `<i>${esc(c.primary)}${c.secondary !== "none" ? `+${esc(c.secondary)}` : ""} (${Math.round(c.voteAgreement * 3)}/3)` +
      `${e.seenNote ? ` · ${esc(e.seenNote)}` : ""}${e.bundle.sanity.confidence === "degraded" ? " · ⚠metrics degraded" : ""}</i>`,
  ];

  if (v) {
    // 💰 Fair value, street target, and the discount at analysis time.
    // "Fair value" = the weight-blended scenario anchor — an estimate built
    // from stated assumptions, not an advice-grade valuation.
    const street = e.bundle.drop?.analystTargetPrice ?? null;
    const discount =
      refPrice && weightedAnchor1y ? ` (${pctVs(refPrice, weightedAnchor1y)} vs fair)` : "";
    const adj = weightedAnchor1y !== null ? adjustFairValue(weightedAnchor1y, loadCalibration()) : null;
    const fairForEntry = adj?.active ? adj.adjusted : weightedAnchor1y;
    const entryRec =
      fairForEntry !== null
        ? Math.round(fairForEntry * (1 - config.valuation.requiredDiscountToFair) * 100) / 100
        : null;
    const eco = e.bundle.drop?.economics;
    parts.push(
      `\n💰 <b>Valuation</b>`,
      `AI fair value (blended 1y anchor): <b>${$(weightedAnchor1y)}</b>` +
        (adj?.active ? ` → <b>${$(adj.adjusted)}</b> after calibration (n=${adj.n})` : ""),
      `analyst consensus: ${$(street)}`,
      `recommended entry price: ≤ <b>${$(entryRec)}</b>`,
      `price at analysis: ${$(refPrice)}${discount}`,
      ...(eco
        ? [
            `EPV floor (zero-growth value): ${$(eco.epvPerShare)}`,
            `market-implied growth: ${eco.impliedGrowthPct ?? "?"}%/yr · street expects ${eco.streetGrowthPct ?? "?"}%` +
              (eco.expectationsGapPts !== null ? ` · gap ${eco.expectationsGapPts > 0 ? "+" : ""}${eco.expectationsGapPts}pts` : ""),
          ]
        : []),
    );

    // 🎯 Scenarios: estimated price at horizon + best entry for the hurdle return.
    const hurdle = config.valuation.entryHurdleRatePerYear;
    parts.push(`\n🎯 <b>Scenarios</b> <i>(est. price at horizon → entry for ≥${Math.round(hurdle * 100)}%/yr)</i>`);
    for (const s of v.scenarios) {
      const p = impliedPrice(s.valuationAnchor, m);
      const entry = entryPrice(p, Number(s.horizonYears), hurdle);
      const a = s.valuationAnchor;
      // Analyses cached before prompt v4 carry string anchors — skip the suffix.
      const anchorStr = a?.metric && a.metric !== "none" && a.multiple ? ` @ ${a.multiple}× ${esc(a.metric)}` : "";
      parts.push(
        `${s.horizonYears}y ${s.scenarioCase} (${Math.round(s.narrativeWeight * 100)}%): est. ${$(p)}${anchorStr}` +
          `${entry !== null ? ` → entry ≤ <b>${$(entry)}</b>` : ""}\n` +
          `   kill-switch: ${esc(cut(s.falsifier, 110))}`,
      );
    }
    if (v.insufficientEvidence) {
      parts.push(`<i>insufficient evidence — scenario pricing has no filing basis; treat with extra suspicion</i>`);
    }

    // 🔍 Analysis — the analytical content as its own distinct section.
    parts.push(`\n🔍 <b>Analysis</b>`, esc(cut(v.oneLineThesis, 200)));
    if (v.changeSincePrior && !/^first look/i.test(v.changeSincePrior)) {
      parts.push(`Δ since last look: ${esc(cut(v.changeSincePrior, 220))}`);
    }
    if (v.anomalies.length > 0) parts.push(`⚡ ${v.anomalies.map((a) => esc(cut(a, 140))).join("\n⚡ ")}`);
    for (const f of v.keyFacts.slice(0, 4)) parts.push(`• ${esc(cut(f.fact, 140))} <i>[${esc(f.source)}]</i>`);
    if (v.managementLanguage.observations.length > 0) {
      parts.push(`mgmt language: ${esc(cut(v.managementLanguage.observations[0]!, 160))}`);
    }
    parts.push(
      `guidance: ${esc(v.guidanceRead.change)} (${esc(v.guidanceRead.timingVsDemand)})`,
      `\n<i>Research queue, not investment advice.</i>`,
    );
  } else {
    parts.push(`No grounded verdict (validation failed) — see the nightly report.`);
  }

  return {
    ticker: e.ticker,
    runDate: new Date().toISOString().slice(0, 10),
    refPrice,
    weightedAnchor1y,
    html: cut(parts.join("\n"), 3800),
  };
}

export function pctVs(price: number, anchor: number): string {
  const d = (price / anchor - 1) * 100;
  return `${d > 0 ? "+" : ""}${d.toFixed(0)}%`;
}
