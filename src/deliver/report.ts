import type { AnalysisRecord } from "../analyst/analyze.js";
import type { TickerBundle } from "../bundle/build.js";
import type { Ranking, Verdict } from "../analyst/schemas.js";
import { impliedPrice } from "../compute/anchors.js";

// Digest + report builders (PLAN.md §9.1). Anomalies lead; summaries follow —
// the reader's alert fatigue is the true failure mode. Every surface carries
// the research-not-advice disclaimer (§16).

const DISCLAIMER = "Research queue, not investment advice.";
const DIGEST_LIMIT = 4096;

export interface DigestEntry {
  ticker: string;
  bundle: TickerBundle;
  analysis: AnalysisRecord;
  justification: string;
  seenNote?: string; // "seen 2026-08-07 👍" — bot memory marker
}

export interface WatchlistLine {
  ticker: string;
  note: string;
}

export function buildDigest(
  entries: DigestEntry[],
  runDate: string,
  rankingStable: boolean,
  watchlist: WatchlistLine[] = [],
): string {
  const lines: string[] = [`<b>Post-drop research queue — ${runDate}</b>`];
  entries.forEach((e, i) => {
    const v = e.analysis.verdict;
    const c = e.analysis.classification;
    const drop = e.bundle.drop;
    const dropStr = drop?.dayChangePct !== undefined && drop.dayChangePct <= -15
      ? `${drop.dayChangePct.toFixed(0)}% day`
      : drop?.monthChangePct
        ? `${drop.monthChangePct.toFixed(0)}% month`
        : drop?.fromHighPct !== undefined
          ? `${drop.fromHighPct.toFixed(0)}% vs 52wk`
          : "?";
    const votes = c.voteAgreement < 1 ? ` ${Math.round(c.voteAgreement * 3)}/3` : "";
    const anomaly = v && v.anomalies.length > 0 ? `\n   ⚡ ${esc(truncate(v.anomalies[0]!, 130))}` : "";
    const degraded = e.bundle.sanity.confidence === "degraded" ? " ⚠metrics" : "";
    const price = drop?.price ? ` $${drop.price.toFixed(2)}` : "";
    const anchors = v ? anchorLine(v, e.bundle) : "";
    const seen = e.seenNote ? ` · <i>${esc(e.seenNote)}</i>` : "";
    const change =
      v && e.seenNote && v.changeSincePrior && !/^first look/i.test(v.changeSincePrior)
        ? `\n   Δ ${esc(truncate(v.changeSincePrior, 130))}`
        : "";
    lines.push(
      `${i + 1}. <b>${esc(e.ticker)}</b>${price} ${dropStr} · ${esc(c.primary)}${votes}${degraded}${seen}` +
        `${anchors}${change}${anomaly}\n   ${esc(truncate(v?.oneLineThesis ?? e.justification, 140))}`,
    );
  });
  if (watchlist.length > 0) {
    lines.push(`<b>Watchlist</b> (👍 names with new filings):`);
    for (const w of watchlist) lines.push(`• <b>${esc(w.ticker)}</b> — ${esc(truncate(w.note, 150))}`);
  }
  if (!rankingStable) lines.push("⚠ ranking unstable under order reversal this run");
  lines.push(`<i>${DISCLAIMER} Full report attached. 👍/👎 = worth your time?</i>`);

  let text = lines.join("\n");
  while (text.length > DIGEST_LIMIT && entries.length > 0) {
    // Should not happen at topN=10 with truncated theses; drop tail lines if it does.
    lines.splice(lines.length - 2, 1);
    text = lines.join("\n");
  }
  return text;
}

export function buildReportHtml(
  entries: DigestEntry[],
  ranking: Ranking,
  runDate: string,
  health: string,
): string {
  const sections = entries
    .map((e, i) => {
      const v = e.analysis.verdict;
      const c = e.analysis.classification;
      const m = e.bundle.metrics;
      const drop = e.bundle.drop;
      if (!v) {
        return `<section><h2>${i + 1}. ${esc(e.ticker)}</h2><p>Validation failed — no grounded verdict. Classification: ${esc(c.primary)}.</p></section>`;
      }
      const docs = [
        ...e.bundle.documents.recent8Ks,
        ...(e.bundle.documents.latestQuarterly ? [e.bundle.documents.latestQuarterly] : []),
      ];
      return `<section>
<h2>${i + 1}. ${esc(e.ticker)} — ${esc(e.bundle.company.name)}</h2>
<p class="meta">${esc(e.bundle.company.sicDescription)} · price $${fmt(drop?.price)} · drop: day ${fmt(drop?.dayChangePct)}%, month ${fmt(drop?.monthChangePct)}%, vs 52wk ${fmt(drop?.fromHighPct)}% · sanity: ${e.bundle.sanity.confidence}</p>
${e.bundle.sanity.flags.length ? `<p class="warn">⚠ ${e.bundle.sanity.flags.map(esc).join("<br>⚠ ")}</p>` : ""}
<p><b>Cause:</b> ${esc(c.primary)}${c.secondary !== "none" ? ` + ${esc(c.secondary)}` : ""} (votes ${Math.round(c.voteAgreement * 3)}/3)${v.insufficientEvidence ? " — <b>insufficient evidence</b>" : ""}<br>
<b>Thesis:</b> ${esc(v.oneLineThesis)}<br>
${v.changeSincePrior && !/^first look/i.test(v.changeSincePrior) ? `<b>Since last look:</b> ${esc(v.changeSincePrior)}<br>` : ""}
<b>Why:</b> ${esc(v.dropCause.rationale)} <span class="src">[${v.dropCause.sources.map(esc).join(", ")}]</span></p>
${v.anomalies.length ? `<p><b>⚡ Anomalies:</b> ${v.anomalies.map(esc).join("; ")}</p>` : ""}
<p><b>Guidance:</b> ${esc(v.guidanceRead.change)} (${esc(v.guidanceRead.timingVsDemand)})${v.guidanceRead.evidence ? ` — “${esc(truncate(v.guidanceRead.evidence, 220))}”` : ""}</p>
<p><b>Key facts:</b></p><ul>${v.keyFacts.map((f) => `<li>${esc(f.fact)} <span class="src">[${esc(f.source)}]</span></li>`).join("")}</ul>
${v.managementLanguage.observations.length ? `<p><b>Management language:</b></p><ul>${v.managementLanguage.observations.map((o) => `<li>${esc(o)}</li>`).join("")}</ul>` : ""}
${v.reconciliation.length ? `<p><b>Possible discrepancies (glance list, not findings):</b></p><ul>${v.reconciliation.map((r) => `<li>${esc(r.discrepancy)} — “${esc(truncate(r.managementQuote, 180))}” <span class="src">[${esc(r.factSource)}, ${esc(r.quoteSource)}]</span></li>`).join("")}</ul>` : ""}
<p><b>Metrics</b> (as of ${esc(m.asOfQuarter ?? "?")}): revenue ${fmtB(m.revenue.latestQ?.value)} (QoQ ${fmt(m.revenue.qoqPct)}%, YoY ${fmt(m.revenue.yoyPct)}%), gross ${fmt(m.margins.grossPct?.latestPct)}%, op ${fmt(m.margins.operatingPct?.latestPct)}%, FCF ${fmt(m.margins.fcfPct?.latestPct)}%, netDebt/EBITDA ${fmt(m.balance.netDebtToEbitdaTtm)}, shares YoY ${fmt(m.dilution.yoyChangePct)}%</p>
<table><tr><th>Horizon</th><th>Case</th><th>Weight*</th><th>Drivers</th><th>Anchor assumption</th><th>Implied/share†</th><th>Falsifier (90d)</th></tr>
${v.scenarios.map((s) => {
  const a = s.valuationAnchor;
  const p = impliedPrice(a, m);
  const assumption = a.metric === "none" ? "—" : `${(a.multiple)}× ${esc(a.metric)} on ${fmtB(a.assumedMetricValueUsd)} — ${esc(truncate(a.rationale, 90))}`;
  return `<tr><td>${s.horizonYears}y</td><td>${esc(s.scenarioCase)}</td><td>${(s.narrativeWeight * 100).toFixed(0)}%</td><td>${s.drivers.map(esc).join("; ")}</td><td>${assumption}</td><td>${p === null ? "—" : `$${p}`}</td><td>${esc(s.falsifier)}</td></tr>`;
}).join("")}
</table>
<p class="src">† implied from the stated assumption at current net debt and share count — an anchor, not a price target.</p>
<p class="src">Documents: ${docs.map((d) => `<a href="${esc(d.url)}">${esc(d.form)} ${esc(d.filedAt)}</a>`).join(" · ")}</p>
</section>`;
    })
    .join("\n");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Post-drop report ${runDate}</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;line-height:1.45;color:#1a1a1a}
h1{font-size:1.4rem} h2{font-size:1.15rem;border-top:2px solid #ddd;padding-top:1rem;margin-top:2rem}
table{border-collapse:collapse;width:100%;font-size:.85rem} td,th{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top}
.meta{color:#555;font-size:.9rem} .src{color:#777;font-size:.8rem} .warn{color:#a33}
.disclaimer{background:#fff6e0;border:1px solid #e0c060;padding:.6rem 1rem;font-size:.9rem}
</style></head><body>
<h1>Post-drop research queue — ${runDate}</h1>
<p class="disclaimer"><b>${DISCLAIMER}</b> This is a queue of names warranting human investigation.
Scenario weights are narrative weights, not calibrated probabilities. Every claim cites its
source filing (accession number) or XBRL concept.</p>
<p class="meta">${esc(ranking.notes)}</p>
${sections}
<p class="meta">Pipeline health: ${esc(health)}</p>
</body></html>`;
}

/** 1-year bear/base/bull implied anchor values for the digest line. */
function anchorLine(v: Verdict, bundle: TickerBundle): string {
  const byCase = new Map(v.scenarios.filter((s) => s.horizonYears === "1").map((s) => [s.scenarioCase, s]));
  const parts: string[] = [];
  for (const c of ["bear", "base", "bull"] as const) {
    const s = byCase.get(c);
    const p = s ? impliedPrice(s.valuationAnchor, bundle.metrics) : null;
    parts.push(`${c} ${p === null ? "—" : `$${p >= 100 ? p.toFixed(0) : p.toFixed(2)}`}`);
  }
  if (parts.every((p) => p.endsWith("—"))) return "";
  return `\n   1y anchors: ${parts.join(" / ")} <i>(not targets)</i>`;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const fmt = (x: number | null | undefined): string => (x === null || x === undefined ? "—" : x.toFixed(1));
const fmtB = (x: number | null | undefined): string =>
  x === null || x === undefined ? "—" : `$${(x / 1e9).toFixed(2)}B`;
