import { generateJson } from "../analyst/provider.js";
import { loadPredictions } from "../scoring/predictions.js";
import { readState, writeState } from "../lib/state.js";
import type { NewsItem } from "./rss.js";

// AI news read for watchlist names. Headlines are UNVERIFIED third-party
// claims — the model summarizes them and relates them to the thesis and
// kill-switches it already committed to for this company. The short-term
// pressure call is labeled what it is: headline sentiment, not valuation.
// Every call is recorded in state for later grading.

const NEWS_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING", description: "2-3 sentences summarizing what the headlines collectively claim" },
    thesisImpact: {
      type: "STRING",
      enum: ["supports_thesis", "challenges_thesis", "approaches_killswitch", "noise"],
    },
    impactRationale: { type: "STRING", description: "One sentence: why, naming the driving headline" },
    killSwitchWatch: {
      type: "STRING",
      description: "Which recorded kill-switch this news bears on and how, or 'none'",
    },
    shortTermPressure: { type: "STRING", enum: ["negative", "neutral", "positive"] },
  },
  required: ["summary", "thesisImpact", "impactRationale", "killSwitchWatch", "shortTermPressure"],
} as const;

export interface NewsRead {
  summary: string;
  thesisImpact: "supports_thesis" | "challenges_thesis" | "approaches_killswitch" | "noise";
  impactRationale: string;
  killSwitchWatch: string;
  shortTermPressure: "negative" | "neutral" | "positive";
}

export async function analyzeNews(ticker: string, items: NewsItem[]): Promise<NewsRead | null> {
  const prior = loadPredictions()
    .filter((p) => p.ticker === ticker)
    .sort((a, b) => a.runDate.localeCompare(b.runDate))
    .at(-1);
  const falsifiers = prior?.scenarios?.map((s) => `- [${s.horizonYears}y ${s.scenarioCase}] ${s.falsifier}`) ?? [];

  const prompt = `You are monitoring news for ${ticker}, a company on the reader's watchlist.

RULES:
- The headlines below are UNVERIFIED third-party claims — treat them as claims, never as facts.
- Your job: summarize what they collectively say, then relate them to the PRIOR THESIS and
  KILL-SWITCHES you previously committed to. "noise" is a common and honest answer.
- shortTermPressure is headline sentiment only — not valuation, not advice. When in doubt: neutral.

PRIOR THESIS (${prior?.runDate ?? "unknown date"}): ${prior?.thesis ?? "none recorded"}
Classification then: ${prior?.classification ?? "unknown"}${baseRateLine(prior?.classification)}
RECORDED KILL-SWITCHES:
${falsifiers.length > 0 ? falsifiers.join("\n") : "none recorded"}

HEADLINES (last 48h):
${items.map((i) => `- "${i.title}" (${i.source}, ${i.pubDate})${i.snippet ? `\n  snippet: ${i.snippet}` : ""}`).join("\n")}`;

  try {
    const read = await generateJson<NewsRead>(prompt, NEWS_SCHEMA, { temperature: 0.3 });
    // Record every call so news reads become gradeable like everything else.
    const log = readState<object[]>("newsCalls", []);
    writeState("newsCalls", [
      ...log.slice(-499),
      { date: new Date().toISOString().slice(0, 10), ticker, pressure: read.shortTermPressure, impact: read.thesisImpact },
    ]);
    return read;
  } catch (err) {
    console.warn(`news analysis ${ticker} failed: ${(err as Error).message}`);
    return null; // links-only message still goes out
  }
}

/** Empirical prior from our own graded outcomes — only cited when n≥10. */
function baseRateLine(classification?: string): string {
  if (!classification) return "";
  const drift = readState<Record<string, { n: number; avgPct: number }>>("classDrift", {});
  const b = drift[classification];
  return b && b.n >= 10
    ? `\nEmpirical base rate (our graded sample): ${classification} drops averaged ${b.avgPct > 0 ? "+" : ""}${b.avgPct}% vs SPY at 30-90d (n=${b.n}) — weigh your pressure call against this.`
    : "";
}

const IMPACT_LABEL: Record<NewsRead["thesisImpact"], string> = {
  supports_thesis: "✅ supports the thesis",
  challenges_thesis: "⚠️ challenges the thesis",
  approaches_killswitch: "🚨 approaches a kill-switch",
  noise: "➖ noise",
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function newsReadHtml(read: NewsRead): string {
  const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const lines = [
    `\n🤖 <b>AI read</b>: ${esc(cut(read.summary, 400))}`,
    `impact: <b>${IMPACT_LABEL[read.thesisImpact]}</b> — ${esc(cut(read.impactRationale, 200))}`,
  ];
  if (read.killSwitchWatch && !/^none$/i.test(read.killSwitchWatch.trim())) {
    lines.push(`kill-switch watch: ${esc(cut(read.killSwitchWatch, 220))}`);
  }
  lines.push(
    `short-term pressure: <b>${read.shortTermPressure}</b> <i>(headline sentiment, low confidence — not valuation, not advice)</i>`,
  );
  return lines.join("\n");
}
