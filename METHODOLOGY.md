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
  quarter-ends, `EV_t = close_t × shares_now + netDebt_now`, then
  `multiple_t = EV_t / TTM-metric_t` (or market cap for P/E, P/FCF). Reported as the
  25th/50th/75th percentile of the company's OWN trading history (needs ≥4 observations).
  *Known approximation: current shares and net debt at every historical point.*
- **Current multiples**: the same arithmetic at today's price — what the market pays now,
  post-drop. The gap between history and today is the re-rating.
- **Street data** (Yahoo): consensus price target, and next-fiscal-year revenue estimate.

## 3. Economics — classical methods, deterministic (`src/compute/economics.ts`)

Assumptions (config.economics): terminal growth g_T = 2.5%, tax = 21%, horizon N = 10 years.
The discount rate is **risk-tiered**, not flat: base 10%, −2pts for profitable low-leverage
mega-caps (>$100B), +2pts when any risk marker fires (netDebt/EBITDA > 1.5, FCF margin < 5%,
or market cap < $5B). The rate used is shown with every economic view.

**EPV — earnings power value (Greenwald).** The value if the business never grows:

```
EPV_equity  = EBIT_TTM × (1 − tax) / r − netDebt          (fallback: FCF_TTM / r)
EPV/share   = EPV_equity / shares
```

**Reverse DCF — market-implied growth (Rappaport).** Take today's market cap as given and
solve (bisection) for the growth rate g that prices it:

```
marketCap = Σ_{t=1..N} FCF₀(1+g)^t / (1+r)^t  +  FCF₀(1+g)^N (1+g_T) / ((r−g_T)(1+r)^N)
```

**Expectations gap** = conservative street growth − market-implied growth, where street
growth = **min(forward revenue growth, forward EPS growth)** — the bottom-line estimate
embeds margin change, keeping the comparison with implied FCF growth apples-to-apples
(revenue growth alone overstates cash growth when margins won't scale).

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
3. low debt: net cash, or netDebt/EBITDA ≤ 2.5
4. moat judged narrow or wide
5. price ≥ 20% below fair value
6. fair value ≤ 1.75 × street target (winner's-curse guard)
7. **expectations gap ≥ 5pts, or price below the EPV floor** — the economic test:
   the market must be pricing in materially less than the evidence supports
8. **ROIC ≥ cost of capital** — growth funded below its cost destroys value; a cheap
   compounder of negative spreads is a value trap, not an opportunity

At most 5 names; zero qualifiers sends an explicit empty-list message with per-name reasons.

## 7. Accountability

Every prediction stores its fair value, scenario band, and reference price. The weekly
scoring job grades: kill-switches at 90 days (fired/survived/uncheckable), drift vs SPY per
drop-class at 30/90 days, and at 1 year the realized-vs-fair error — the measured bias is
reported in Sunday rollups and accumulates toward a display correction.

## Worked example (RBLX, 2026-08-08, $36.57)

- FCF_TTM ≈ $1.0B, shares ≈ 700M-equivalent basis, net cash → EPV floor ≈ **$22.94/share**
- Reverse DCF: $36.57 implies ≈ **4.6%/yr** FCF growth
- Street forward revenue growth: **41.3%** → expectations gap **+36.7pts** → economically
  qualified: the price assumes near-stagnation while consensus and filings show rapid growth
- Contrast AAPL at $220: implies 9.9% vs street 12.1% — gap 2.2pts → **fairly priced, excluded**

*Research queue, not investment advice. Estimates are disciplined arguments, not truths;
the kill-switches and the calibration loop exist because they will sometimes be wrong.*
