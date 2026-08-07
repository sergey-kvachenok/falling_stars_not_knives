import "./lib/env.js";

// Every threshold lives here — no magic numbers in logic (PLAN.md §13).
export const config = {
  screen: {
    minMarketCap: 2_000_000_000,
    minPrice: 5,
    minAvgVolume: 500_000,
    usDomesticOnly: true,
    // Financials/REITs excluded in v1 — their metrics need a different template (PLAN.md §5)
    excludeSectors: ["Financial Services", "Real Estate"],
    triggers: { dayDrop: -0.2, monthDrop: -0.25, from52WeekHigh: -0.4 },
    // Price vs 50-day average below this → worth a chart call to verify the month trigger.
    // The quote sweep has no 1-month field; the 50dma gap is the cheap proxy (PLAN.md §5.1).
    monthPrefilterVs50dma: -0.15,
    maxCandidates: 30,
    cooldownDays: 14,
  },
  edgar: {
    userAgent: process.env.SEC_USER_AGENT ?? "",
    requestsPerSecond: 8,
  },
  cache: {
    // A cache entry untouched this long belongs to a ticker that stopped
    // recurring — delete it; EDGAR re-fetch costs seconds (PLAN.md §6).
    pruneAfterDays: 60,
  },
  llm: {
    apiKey: process.env.GEMINI_API_KEY ?? "",
    // Flash for everything until Phase 4 evaluation proves otherwise (PLAN.md §7.6).
    // flash-lite: the free-tier daily quota on full flash is too small for
    // ~100 requests/day. Upgrade the deep/rank calls only if evaluation
    // demands it (PLAN.md §7.6).
    model: "gemini-3.5-flash-lite",
    classificationVotes: 3,
    maxCitationRetries: 2,
    maxOutputTokens: 8192,
    // Part of the bundle hash — bump on ANY prompt or schema change (PLAN.md §6.2).
    promptVersion: 4,
  },
  memory: {
    // 👎 names stay out of the digest this long unless a new filing appears.
    downvoteSuppressDays: 30,
    // 👍 names are followed up when they file something new, for this long.
    watchlistDays: 90,
    watchlistMaxPerRun: 5,
  },
  output: { topN: 10, horizonsYears: [1, 3] },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    chatId: process.env.TELEGRAM_CHAT_ID ?? "",
  },
  yahoo: {
    quoteChunkSize: 200,
    chunkDelayMs: 250,
    // Backstop against a market-wide crash turning the month check into
    // thousands of chart calls. Overflow is logged, never silent (PLAN.md §11).
    maxChartCalls: 200,
  },
} as const;

export function assertConfig(): void {
  if (!config.edgar.userAgent.includes("@")) {
    throw new Error(
      "SEC_USER_AGENT must contain a contact email (e.g. \"stock-agent you@example.com\"). " +
        "Set it in .env or the environment.",
    );
  }
}
