# How the numbers are calculated

Every figure in the digest and cards comes from one of three sources, in strict order of
trust: **filed data** (SEC XBRL, deterministic code), **market data** (prices, street
consensus), and **bounded AI judgment** (only where no data can answer). This document walks
the full chain. All tunable assumptions live in `src/config.ts`; nothing numeric hides in a
prompt.

## 1. Fundamentals — from SEC filings, in code

Source: `data.sec.gov` XBRL company facts, normalized in `src/edgar/companyfacts.ts`:

- Period identity is (start, end) dates; restatements resolve to the latest-filed value.
- Quarterly values derive from cumulative YTD diffs where companies file YTD-only
  (cash-flow statements), and Q4 = FY − 9M.
- Tag fallback chains handle naming variance (`Revenues` vs
  `RevenueFromContractWithCustomerExcludingAssessedTax`, …).

From the quarterly series (`src/compute/metrics.ts`):

```
TTM x        = sum of the trailing four quarters of x
FCF          = CFO − capex − SBC              (owner cash flow; stock comp is a real
                                               cost paid in dilution — never added back)
ROIC         = EBIT_TTM × (1 − tax) / (equity + debt − cash)
EBIT         = operating income
net debt     = (long-term + current debt) − (cash + short-term investments)
margins      = metric / revenue, with QoQ/YoY basis-point trends
capex %      = capex_TTM / revenue_TTM
```

A sanity layer (`src/compute/sanity.ts`) checks balance-sheet identity, value bounds,
series continuity, and period alignment. Failures mark the company `degraded` — degraded
names never reach the digest.

## 2. Market context — data, not judgment

- **Historical multiple ranges** (`src/compute/multiples.ts`): for each of the last ~6–10
  quarter-ends, `EV_t = close_t × shares_t + netDebt_t` — shares and net debt are taken
  **from the XBRL series of that quarter**, not today's (today's share count at historical
  prices would inflate the historical caps of heavy diluters, making today look falsely
  cheap). Reported as the 25th/50th/75th percentile of the company's OWN trading history
  (needs ≥4 observations); falls back to current values only where the series is missing.
- **Current multiples**: the same arithmetic at today's price — what the market pays now,
  post-drop. The gap between history and today is the re-rating.
- **Street data** (Yahoo): consensus price target, and next-fiscal-year revenue estimate.

## 3. Economics — classical methods, deterministic (`src/compute/economics.ts`)

Assumptions (config.economics): terminal growth g_T = 2.5%, tax = 21%, horizon N = 10 years.
The discount rate is **risk-tiered and STACKING**, not flat: base 10%, −2pts for profitable
low-leverage mega-caps (>$100B), and **+2pts per risk marker** (netDebt/EBITDA > 1.5,
FCF margin < 5%, market cap < $5B), capped at 16% — a cash-burning leveraged micro-cap is
all three risks at once. The rate used is shown with every economic view.

**EPV — earnings power value (Greenwald).** The value if the business never grows, on
**normalized earnings** — `min(TTM, 5-year average)` — so a cyclical at its peak cannot
inflate its own floor with windfall earnings (a floor never stands on a peak):

```
EPV_equity  = min(EBIT_TTM, EBIT_5yAvg) × (1 − tax) / r − netDebt   (fallback: normalized FCF / r)
EPV/share   = EPV_equity / shares
```

The reverse DCF uses the same normalized FCF base, and ROIC's invested capital is floored
at PP&E — net-cash companies otherwise get a tiny/negative denominator and a meaningless
ratio (Equity + Debt − Cash can go negative when cash exceeds both).

**Reverse DCF — market-implied growth (Rappaport).** Take today's market cap as given and
solve (bisection) for the growth rate g that prices it:

```
marketCap = Σ_{t=1..N} FCF₀(1+g)^t / (1+r)^t  +  FCF₀(1+g)^N (1+g_T) / ((r−g_T)(1+r)^N)
```

**Expectations gap** = conservative street growth − market-implied growth, where street
growth = **min(forward revenue growth, forward EPS growth)** — the bottom-line estimate
embeds margin change, keeping the comparison with implied FCF growth apples-to-apples
(revenue growth alone overstates cash growth when margins won't scale). EPS growth is
incomputable for unprofitable companies (negative denominator); rather than silently
falling back to revenue — the original trap — **unprofitable names without a bottom-line
estimate take a haircut on revenue growth** (`unprofitableRevenueHaircut`, default 50%),
and the proxy used is recorded. The haircut is a last resort and knowingly blunt — EPS
growth is always preferred when computable; forward EBITDA/OCF consensus would be better
still but is not available from free sources.

Known limitations, monitored rather than solved: GAAP expenses R&D immediately, which
depresses ROIC for research-heavy compounders vs capex-heavy industrials; and the stacked
gates (quality + 20% discount + expectations gap + ROIC) may over-tighten — if weeks pass
with zero qualifiers, revisit `requiredDiscountToFair` before concluding the market has
no mispricings.

## 4. AI scenarios — judgment, fenced by validation

The model produces six scenarios (bear/base/bull × 1y/3y), each as *assumptions*:
metric (EV/Sales, EV/EBITDA, P/E, P/S, P/FCF, P/B), multiple, and the assumed absolute USD
metric value at that horizon. Rejected-and-retried unless ALL hold (`src/analyst/validate.ts`):

- every factual claim cites a filing accession number or data field present in the bundle
- multiple inside the company's own historical p25–p75 band (×0.6/×1.6 tolerance);
  going BELOW the band is allowed only with a cited `regimeShiftJustification` naming the
  structural break (secular decline makes history irrelevant) — no upward override exists
- 1y sales assumptions within ±40% of street consensus, and must engage it
- **bear realism**: 1y bear implied price ≤ 1.15 × current price
- **fade**: 3y multiple ≤ 1.1 × 1y multiple (same metric)
- **coherence**: 3y implied ≥ 0.7 × 1y implied per case (one company, one trajectory)
- weights sum to ~1.0 per horizon; metric must be priceable (no P/E on negative earnings)
- kill-switches are concrete 90-day observables; base/bull may not use management guidance
  as the bar

The numeric assumptions are the **median of three independent samples**; drop-cause
classification separately takes the majority of three votes.

## 5. Prices — arithmetic on the assumptions (`src/compute/anchors.ts`)

```
implied/share (EV metrics)  = (multiple × assumedValue − netDebt) / shares
implied/share (P/x metrics) =  multiple × assumedValue / shares
fair value                  = Σ (weight_i × implied_i) / Σ weight_i   over 1y scenarios
entry (per scenario)        = implied / (1 + 15%)^years               (hurdle return)
recommended entry           = fair value × (1 − 20%)                  (required discount)
```

## 6. The digest gate (`src/compute/quality.ts`) — all must hold

1. grounded verdict (not `insufficient_evidence`), clean metrics
2. positive TTM free cash flow
3. low debt: net cash, or (EBITDA > 0 AND netDebt/EBITDA ≤ 2.5) — the ratio is only ever
   computed with a positive denominator, so a negative-EBITDA cash-burner cannot pass
   with a "negative ratio"
4. moat judged narrow or wide
5. price ≥ 20% below fair value
6. fair value ≤ 1.75 × street target (winner's-curse guard)
7. **expectations gap ≥ 5pts, or price below the EPV floor** — the economic test:
   the market must be pricing in materially less than the evidence supports
8. **ROIC ≥ cost of capital, OR owner-FCF margin ≥ 15%** — growth funded below its cost
   destroys value; a cheap compounder of negative spreads is a value trap. The FCF-margin
   bypass exists because GAAP expenses R&D immediately, depressing ROIC for research-heavy
   compounders — converting 15%+ of revenue to owner cash (already after SBC) proves value
   creation regardless of the GAAP formula

At most 5 names; zero qualifiers sends an explicit empty-list message with per-name reasons.

## 7. Accountability and self-calibration (Loop 3 — wired)

Every prediction stores the complete audit trail: fair value (raw and calibration-adjusted),
the bear–bull band, reference price, undervaluation %, the full economic view (implied
growth, gap, EPV, discount rate used), classification, and the prompt version that produced
it. The weekly scoring job grades: kill-switches at 90 days (fired/survived/uncheckable),
drift vs SPY per drop-class at 30/90 days, and at 1 year the realized-vs-fair error.

The measured bias (mean/median error, per-classification breakdown) persists to the
`calibration` state. **Once `calibration.minSamples` (20) predictions have matured, the
correction activates automatically**: `fair × (1 + meanError)`, clamped to ×0.5–×1.5,
labeled with the sample count. **Per-classification scalars apply once a class has ≥10
matured samples** — bias is rarely uniform across mechanical liquidations and sentiment
crashes. Until activation the bias is reported, never applied.

Three stability guards on the loop itself:
- **Tighten-only gating**: the correction may LOWER the fair value the gate uses, never
  raise it — a loosening correction would admit more borderline names, whose failures
  would contract the correction, an oscillating over/under-filtering feedback loop.
  Displays show the true correction in both directions.
- **Fast regime guard**: 1-year price calibration lags a market regime by design;
  kill-switches don't. When >30% of graded kill-switches fired (≥10 graded), the required
  discount widens by 5pts immediately.
- **Corporate actions enter the sample, automatically where possible**: when a ticker's
  price history vanishes, the scorer checks EDGAR — an 8-K Item 1.03
  (bankruptcy/receivership) auto-resolves at $0; a Form 25 delisting flags the name for a
  manual deal price (`npm run resolve -- TICKER DATE PRICE`). Silently dropping dead
  tickers would delete every −100% and flatter the system; the rollup nags until every
  name is resolved.
- **Calibration is market-adjusted**: realized prices are deflated by SPY's return over
  the same window before comparison with fair value — otherwise a bear market reads as
  "our fair values ran hot" and a bull market hides real errors, making the loop react to
  liquidity cycles instead of valuation accuracy.

`npm run verify` prints the full ledger — every prediction, what was claimed, on what
economics, and what actually happened — plus the current calibration status.

## Worked example (RBLX, 2026-08-08, $36.57 — with all corrections applied)

- Owner FCF (after subtracting ~$1B of stock-based compensation) collapses the naive
  numbers: EPV floor **$5.84/share** (was $22.94 on phantom cash)
- Reverse DCF at the risk-tiered 12% rate: $36.57 implies ≈ **25.2%/yr** owner-FCF growth
- RBLX is GAAP-unprofitable with no computable EPS estimate → street revenue growth 41.3%
  takes the haircut → conservative street growth **20.7%**
- Expectations gap = 20.7 − 25.2 = **−4.5pts → disqualified**: the market already pays for
  more growth than the conservative evidence supports
- Contrast AAPL at $220 (8% rate — earned): implies 6.8% vs street 8.5%, gap 1.7pts,
  ROIC 96% → **fairly priced, excluded**. The control case never moves.

*Research queue, not investment advice. Estimates are disciplined arguments, not truths;
the kill-switches and the calibration loop exist because they will sometimes be wrong.*
