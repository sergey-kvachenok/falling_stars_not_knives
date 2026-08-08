import { generateJson } from "../analyst/provider.js";
import { loadPredictions } from "../scoring/predictions.js";
import { readState, writeState } from "../lib/state.js";
import type { NewsItem } from "./rss.js";

// AI news read for watchlist names. Headlines are UNVERIFIED third-party
// claims — the model summarizes them and relates them to the thesis and
// kill-switches it already committed to for this company. The short-term
// pressure call is labeled what it is: headline sentiment, not valuation.
// Every call is recorded in state for later grading.

// Operational classification ONLY — no price-direction calls. Headlines are
// priced into the market within milliseconds; a nightly batch "predicting"
// short-term moves from them is stale-signal theater and would pollute the
// calibration data with random-walk noise. What a nightly listener CAN do:
// detect whether news structurally bears on the recorded thesis and
// kill-switches.
const NEWS_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING", description: "2-3 sentences summarizing what the headlines collectively claim" },
    thesisImpact: {
      type: "STRING",
      enum: ["noise", "thesis_preserved", "thesis_challenged", "killswitch_trigger"],
      description:
        "noise = commentary/rating churn; thesis_preserved = normal operations; thesis_challenged = margin/regulatory/customer warnings; killswitch_trigger = a headline directly indicates a recorded kill-switch tripped",
    },
    impactRationale: { type: "STRING", description: "One sentence: why, naming the driving headline" },
    killSwitchWatch: {
      type: "STRING",
      description: "Which recorded kill-switch this news bears on and how, or 'none'",
    },
  },
  required: ["summary", "thesisImpact", "impactRationale", "killSwitchWatch"],
} as const;

export interface NewsRead {
  summary: string;
  thesisImpact: "noise" | "thesis_preserved" | "thesis_challenged" | "killswitch_trigger";
  impactRationale: string;
  killSwitchWatch: string;
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
- You are a passive thesis monitor, NOT a market-timer. Never reason about short-term price
  direction — the market priced these headlines within milliseconds of publication.
- The ONE decisive question: does any headline directly indicate that a recorded kill-switch
  below has been tripped? If yes → killswitch_trigger, and killSwitchWatch must quote which.
- "noise" is a common and honest answer — analyst rating churn, listicles, and routine
  commentary are noise even when their tone is dramatic.

PRIOR THESIS (${prior?.runDate ?? "unknown date"}): ${prior?.thesis ?? "none recorded"}
Classification then: ${prior?.classification ?? "unknown"}${baseRateLine(prior?.classification)}
RECORDED KILL-SWITCHES:
${falsifiers.length > 0 ? falsifiers.join("\n") : "none recorded"}

HEADLINES (last 48h):
${items.map((i) => `- "${i.title}" (${i.source}, ${i.pubDate})${i.snippet ? `\n  snippet: ${i.snippet}` : ""}`).join("\n")}`;

  try {
    const read = await generateJson<NewsRead>(prompt, NEWS_SCHEMA, { temperature: 0.3 });
    // Record classifications (not price calls) — later gradeable structurally:
    // did killswitch_trigger reads precede actual falsifier fires?
    const log = readState<object[]>("newsCalls", []);
    writeState("newsCalls", [
      ...log.slice(-499),
      { date: new Date().toISOString().slice(0, 10), ticker, impact: read.thesisImpact },
    ]);
    return read;
  } catch (err) {
    console.warn(`news analysis ${ticker} failed: ${(err as Error).message}`);
    return null; // links-only message still goes out
  }
}

/** Empirical prior from our own graded outcomes — context only, cited when n≥10. */
function baseRateLine(classification?: string): string {
  if (!classification) return "";
  const drift = readState<Record<string, { n: number; avgPct: number }>>("classDrift", {});
  const b = drift[classification];
  return b && b.n >= 10
    ? `\nEmpirical base rate (our graded sample): ${classification} drops averaged ${b.avgPct > 0 ? "+" : ""}${b.avgPct}% vs SPY at 30-90d (n=${b.n}).`
    : "";
}

const IMPACT_LABEL: Record<NewsRead["thesisImpact"], string> = {
  noise: "➖ noise",
  thesis_preserved: "✅ thesis preserved",
  thesis_challenged: "⚠️ thesis challenged",
  killswitch_trigger: "🚨 KILL-SWITCH TRIGGER",
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
  lines.push(`<i>Headlines are unverified claims. This is thesis monitoring, not a trading signal.</i>`);
  return lines.join("\n");
}
