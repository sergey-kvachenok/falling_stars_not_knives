import { impliedPrice, weightedAnchorPrice } from "../compute/anchors.js";
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
    // 💰 Prices — anchors, never targets (PLAN.md §8).
    const line = (h: "1" | "3") =>
      ["bear", "base", "bull"]
        .map((cs) => {
          const s = v.scenarios.find((x) => x.horizonYears === h && x.scenarioCase === cs);
          return `${cs} ${$(s ? impliedPrice(s.valuationAnchor, m) : null)}`;
        })
        .join(" / ");
    const discount =
      refPrice && weightedAnchor1y
        ? ` · at analysis ($${refPrice.toFixed(2)}): ${pctVs(refPrice, weightedAnchor1y)} vs anchor`
        : "";
    parts.push(
      `\n💰 <b>Anchors</b> <i>(assumption-implied, not price targets)</i>`,
      `1y: ${line("1")}\n3y: ${line("3")}`,
      `blended 1y anchor: ${$(weightedAnchor1y)}${discount}`,
    );

    // 🎯 Scenarios with per-scenario implied price + falsifier.
    parts.push(`\n🎯 <b>Scenarios</b>`);
    for (const s of v.scenarios) {
      const p = impliedPrice(s.valuationAnchor, m);
      const a = s.valuationAnchor;
      // Analyses cached before prompt v4 carry string anchors — skip the suffix.
      const anchorStr = a?.metric && a.metric !== "none" && a.multiple ? ` @ ${a.multiple}× ${esc(a.metric)}` : "";
      parts.push(
        `${s.horizonYears}y ${s.scenarioCase} (${Math.round(s.narrativeWeight * 100)}%): ${$(p)}${anchorStr}\n` +
          `   kill-switch: ${esc(cut(s.falsifier, 110))}`,
      );
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
