# Post-Drop Equity Research Pipeline — Build Plan v2

> **This document is the brief for an AI coding agent.** Read it fully before writing code.
> Sections marked **RATIONALE** explain *why* a decision was made. Do not "improve" those
> decisions without checking the rationale — several look suboptimal and are not.
>
> v2 changes vs v1: the multi-horizon screen now has a concrete data source (§5.1); the Gemini
> Batch API is dropped (§7.6); document storage is inverted — EDGAR is the permanent store,
> Postgres holds only small derived data (§6); the bundle hash is defined over stable inputs and
> versioned (§6.2); guidance diffing moved from code to LLM extraction (§7.2); a metrics sanity
> layer and per-ticker confidence flag were added (§7.1); financials/REITs are excluded in v1
> (§5); classification is multi-label with 3-vote self-consistency (§7.3); scenario probabilities
> are demoted to narrative weights (§8); the digest carries a "worth my time?" feedback button —
> the project's actual success metric (§9); the scoring loop grades falsifiers and classification
> drift, not just returns (§10); explicit pipeline health metrics were added (§11).

---

## 1. What we are building

A nightly automated pipeline that:

1. Finds US-listed stocks that dropped sharply (screen definition in §5)
2. Pulls their **primary source documents** from SEC EDGAR — the actual filings
3. Computes financial health metrics **deterministically in code**, with sanity checks
4. Has an LLM read the filings and classify *why* each stock dropped
5. Ranks the ~10 most interesting names
6. Produces 1-year and 3-year scenarios for each, each with a 90-day falsifier
7. Delivers a digest to Telegram with per-name feedback buttons

There is **no web frontend**. Output is a Telegram message plus an attached report file.

## 2. What we are NOT building — read this carefully

**This is not a stock-picking system, and must not be described as one.**

An LLM reading public filings has no informational edge on liquid equities. If this were a
profitable signal generator, it would already be arbitraged away.

What it actually is: **a research funnel.** On a given day, 20–80 stocks drop hard. Most are
biotech binary events, dilution, reverse-split shells, or index mechanics. The pipeline's job
is to discard those and surface the 2–3 names a human should personally investigate.

Success = "the names it surfaces are worth my time." — and this is *measured*, via the
feedback buttons in §9, not assumed.
Success ≠ "the names it surfaces went up."

**RATIONALE:** This framing drives real design decisions. It is why the analyst prompt asks
*why did this drop* rather than *is this a buy*, why every scenario must carry a falsifier, and
why the scoring loop (§10) exists. An agent that quietly reframes this as a buy-signal generator
will produce confident, useless output. Do not add BUY/SELL/HOLD ratings, conviction scores, or
price targets presented as predictions.

### The core analytical problem this design works around

**Your fundamental data is older than the drop.**

The most recent 10-Q describes the company *before* whatever happened today. A naive screen for
"high margin + low debt + down 20%" systematically pairs stale good news against fresh bad news.
Every value trap in history clears that screen on day one.

Consequences, all load-bearing:

- The screen includes **multi-horizon drawdowns**, not just single-day drops (§5)
- The analyst's primary output is a **drop-cause classification**, not a health score (§7.3)
- **Many drops have no primary document at all** (downgrades, short reports, FDA panels,
  conference remarks, competitor news). For those, `insufficient_evidence` is a *first-class,
  expected outcome*, not a failure — and its rate is a monitored health metric (§11).

Academic evidence points against naive 1-day reversal: post-earnings-announcement drift means
large negative surprises tend to keep underperforming for weeks to months. We are screening in
the zone where momentum, not reversal, dominates. A further reason the output is a research
queue, not a signal.

### Where the value actually comes from — set expectations accordingly

In order of reliability: (1) the screen, (2) the deterministic metrics, (3) **8-K retrieval** —
"here is the press release that caused the drop, with computed deltas next to it" is genuinely
useful and nearly failure-proof. The LLM classification adds triage value *when a primary
document exists* and honestly reports `insufficient_evidence` when one doesn't. The
narrative-vs-numbers reconciliation is a low-precision bonus (§7.4). Scenario probabilities are
narrative structure, not forecasts (§8). Build and present each layer at its actual reliability
level — the failure mode that kills this product is not a wrong classification, it is a digest
of samey plausible text that the reader stops opening in month three. Bias output toward
**anomaly and disagreement**, not fluent summary.

---

## 3. Architecture

```
GitHub Actions (cron, weeknights after US close)
  └─ pipeline (one Node script, runs to completion, ~20–30 min)
       ├─ 0. calendar    → exit early on market holidays
       ├─ 1. screen      → candidate tickers (universe sweep, §5.1)
       ├─ 2. enrich      → EDGAR filings + XBRL + prices        [heavily cached]
       ├─ 3. compute     → deterministic metrics, deltas, sanity checks
       ├─ 4. analyze     → LLM: classify (3-vote) + assess + scenarios  [cached by bundle hash]
       ├─ 5. rank        → LLM: single pass over all verdicts
       └─ 6. deliver     → Telegram digest (+ feedback buttons) + attached report
                          └─ persist derived data to Postgres

GitHub Actions (cron, weekly)
  └─ scoring job: grade falsifiers at 90d, classification drift at 30/90d, returns at 1y/3y

Tiny webhook receiver (see §9.3) for Telegram feedback button callbacks
```

**Stack**

| Concern | Choice |
|---|---|
| Runtime | Node 22+, TypeScript, ESM |
| Scheduler | GitHub Actions `schedule:` |
| Database | Neon Postgres (free tier) + Drizzle ORM — small derived data only |
| Document cache | On-disk, persisted via `actions/cache` (§6.1) |
| Market data | `yahoo-finance2` (MIT), behind an interface |
| Filings | SEC EDGAR APIs (free, no key) |
| LLM | Gemini Flash, synchronous, behind an interface (§7.6) |
| Delivery | Telegram Bot API |

**RATIONALE — why GitHub Actions and not Vercel:** the job runs once nightly, takes 20–30
minutes, and nobody is waiting on it. Serverless crons time out in minutes and don't retry, so
failures would be silent. Actions gives real cron, no timeout pressure, retained logs, and
failure notifications, for free. There is no frontend to host. Note: if the repo is private,
the job burns ~660 Actions minutes/month of the 2,000 free — fine, but keep the job lean.
A private repo is preferred given Yahoo's personal-use posture (§4.2).

**RATIONALE — why an interface around every external service:** `yahoo-finance2` is an
unofficial client for undocumented endpoints and *will* break without notice. The LLM provider
may change. Both must be swappable in one file.

```ts
interface MarketDataProvider {
  getUniverseQuotes(tickers: string[]): Promise<QuoteLite[]>; // batch quote sweep, §5.1
  getPriceHistory(ticker: string, days: number): Promise<Bar[]>;
}

interface AnalystProvider {
  classify(bundle: TickerBundle): Promise<DropClassification>; // cheap, called 3× per ticker
  analyze(bundle: TickerBundle): Promise<AnalystVerdict>;
  rank(verdicts: AnalystVerdict[]): Promise<RankedPicks>;
}
```

---

## 4. Data sources

### 4.1 SEC EDGAR — the primary source. The heart of the project.

Free. No API key, no registration.

**Mandatory:** every request must send a `User-Agent` header containing a name and contact
email (e.g. `"Jan Kowalski jan@example.com"`). Requests without it get 403.

**Rate limit: 10 requests/second, hard.** Implement a shared token-bucket limiter at 8 req/sec
across the whole process. Exceeding it gets your IP blocked for ~10 minutes.

| Purpose | Endpoint |
|---|---|
| ticker → CIK map | `https://www.sec.gov/files/company_tickers.json` (download once/day, cache) |
| filing index | `https://data.sec.gov/submissions/CIK{cik10}.json` |
| all XBRL facts | `https://data.sec.gov/api/xbrl/companyfacts/CIK{cik10}.json` |
| documents | `https://www.sec.gov/Archives/edgar/data/{cik}/{accession}/{file}` |

`{cik10}` is the CIK zero-padded to 10 digits.

**The single most important insight for this pipeline:**

> When a stock drops on earnings, the document that caused the drop is almost always the
> **8-K** filed with the earnings release — specifically **Item 2.02** and its **EX-99.1 press
> release exhibit**, which is where guidance lives. The 10-Q may not be filed for days or weeks
> afterward.

So enrichment prioritizes recent 8-Ks in the drop window. Fetch the latest 10-Q/10-K too, but
the 8-K is what explains today. **When no 8-K (or other filing) exists in the drop window,
record that fact explicitly in the bundle** — it is the signal that tells the analyst to lean
toward `insufficient_evidence` or `sentiment`/`mechanical` causes.

**XBRL tag fallbacks:** companies do not use identical tags. Revenue may be `Revenues`,
`RevenueFromContractWithCustomerExcludingAssessedTax`, `SalesRevenueNet`, and others. Build a
fallback chain per concept and log which tag matched. Expect to spend real time inspecting
actual `companyfacts` JSON — this is the messiest part of the build. Known specific traps:

- **Fiscal alignment:** Q4 is never filed separately — derive it as FY minus the three 10-Qs.
  Fiscal year-ends vary. Never compare periods by array position; align by (`fy`, `fp`, frame).
- **Amendments/restatements** replace prior facts — prefer the latest fact per period.
- **Tag switches mid-series** create phantom revenue discontinuities. The sanity layer (§7.1)
  must catch these before the model sees them as "deltas."

Each XBRL fact carries `accn` (accession number), `fy`, `fp`, `form`. **Preserve this
provenance** — §7.5 depends on it.

### 4.2 Market data — `yahoo-finance2`

MIT licensed, free, no key. Unofficial and unendorsed by Yahoo; treat breakage as inevitable.
**Verify the installed version's API surface at build time** — do not trust remembered
snippets; the library drifts.

Used for: the universe quote sweep (§5.1), price history for survivors, market cap and volume
floors, exchange/quoteType pre-filtering. **Not** used for fundamentals — those come from XBRL.

**Legal note:** Yahoo's finance endpoints are intended for personal use. This project is a
personal pipeline delivering to one person's Telegram, which is fine. **If this is ever made
public or commercial, market data must be relicensed** (Polygon / FMP / Tiingo / EODHD).

### 4.3 News — tiered, and mostly replaced by code

1. **Primary** — the 8-K and its press release exhibit. *This is the news.*
2. **Regulatory** — Form 4 insider transactions around the drop, 13D/G changes. Free, from the
   same submissions endpoint. Insiders buying into a crash is genuinely informative — and it is
   exactly the kind of anomaly the digest should lead with.
3. **Sector-vs-company detection is done in code, not from headlines:** compare the stock's
   move against its sector ETF and SPY over the same window. Deterministic, free, and more
   reliable than headline inference. Store the result in the bundle as a computed fact.

Third-party headlines are **out of scope for v1**. A model fed headlines produces sentiment
scoring on other people's summaries, not analysis; and the sector question — the one thing
headlines were for — is answered better by the ETF comparison above.

---

## 5. The screen

Candidate = passes **all** liquidity floors **and** at least one drop trigger.

**Liquidity floors** (all configurable in one file):
- Market cap > $2B
- Price > $5
- Average daily volume > 500k
- US domestic filer (files 10-K/10-Q/8-K, not 20-F/6-K)
- **Not a financial/REIT** (exclude SIC codes 6000–6799 in v1)

**Drop triggers** (union — any one qualifies):
- ≤ −20% in one day
- ≤ −25% over one month
- ≤ −40% from 52-week high

**Cooldown:** a ticker analyzed in the last 14 days is re-surfaced **only if a new filing has
appeared since** (check via the submissions index, which you fetch anyway). Otherwise it is
skipped before enrichment.

**Cap:** 30 candidates per run. If more qualify, rank by **drop recency and severity** (1-day
trigger first, then 1-month, then 52-week; tiebreak by magnitude), *not* by market cap.

**RATIONALE — why exclude financials in v1:** net debt/EBITDA for a bank, inventory-vs-revenue
for an insurer, cash runway for a REIT — nonsense metrics computed correctly. Financials need a
different metrics template entirely; deleting them removes the worst garbage-in channel for the
cost of one SIC-code filter. Add a sector template later if wanted.

**RATIONALE — why the cooldown and severity ranking:** "−40% from 52-week high" is a *state*,
not an event. A $2B+ stock in secular decline satisfies it for months; without a cooldown the
digest converges on the same persistent losers daily, and ranking overflow by market cap makes
that worse by privileging stale mega-cap drawdowns. Bundle-hash caching saves the LLM cost of
repeats, but only the cooldown saves the *reader*.

**RATIONALE — why exclude foreign filers in v1:** ADRs file 20-F/6-K on different schedules
with different structure. Roughly doubles filing-parser work for marginal benefit.

### 5.1 Where the universe comes from — this was the missing piece in v1

The multi-horizon triggers require drawdown data for *every* liquid US stock. Yahoo's
predefined `day_losers` screener only covers the single-day trigger. The sweep works like this:

1. **Universe seed:** EDGAR's `company_tickers.json` (~10k US-listed tickers, free, cached daily).
2. **Batch quote sweep:** Yahoo's `quote` endpoint accepts hundreds of symbols per request —
   the whole universe is a few dozen requests. The response includes `marketCap`, price,
   volume, `fiftyTwoWeekHigh`, `regularMarketChangePercent`, exchange, and `quoteType`. This
   single sweep resolves: all liquidity floors, the 1-day trigger, the 52-week trigger, and a
   cheap pre-filter for foreign issuers/funds (drop non-EQUITY quoteTypes and obvious OTC) —
   before spending a single EDGAR request.
3. **1-month trigger:** fetch price history *only* for tickers that pass the floors and are
   within shouting distance of a trigger (e.g. anything ≤ −15% on any horizon visible from the
   quote sweep). This keeps history calls in the dozens, not thousands.
4. **Domestic-filer confirmation:** for the surviving ≤30, confirm 10-K/10-Q form types from
   the EDGAR submissions index (fetched during enrichment anyway).

*Acceptance for this mechanism is Phase 1's whole job — see §12.*

---

## 6. Caching and persistence

**Design principle (inverted from v1): EDGAR is itself the permanent document store.** Filings
are immutable and permanently re-fetchable at 8 req/sec for free. Do **not** archive full
filing text in Postgres — v1's "store extracted text forever" math (~15 candidates/day × 3 docs
× ~150KB ≈ 1.7GB/year) blows Neon's 0.5GB free tier inside three months.

### 6.1 Two-layer cache

| Layer | Where | Policy |
|---|---|---|
| Filing documents (extracted text) | **Disk**, persisted via `actions/cache` | Forever, keyed by accession number. Cache miss = re-fetch from EDGAR; losing this cache costs only rate-limited time, never data. |
| `companyfacts` extracted metric series | Disk + Postgres (small) | ~24h; use `If-None-Match` with stored ETag, treat 304 as unchanged. Store *extracted series*, never raw JSONB (raw files run 5–20MB). |
| `submissions` index | Disk | 6–12h |
| Prices | Postgres, append-only by (ticker, date) | Survivors only, not the universe sweep |
| LLM analyses | Postgres, keyed by bundle hash (§6.2) | Forever |

### 6.2 Bundle hash — define it carefully or the cache never hits

v1 called analysis caching "the largest single cost saving," but a hash over the whole bundle
never matches across days because prices change daily. Define the identity as:

```
bundle_hash = sha256(ticker + sorted accession numbers included
              + facts snapshot fingerprint + PROMPT_VERSION + SCHEMA_VERSION)
```

Prices, drop percentages, and run date are **in the bundle but not in the hash**. A ticker
recurring with no new filing → identical hash → skip the LLM entirely and reuse the verdict.

**`PROMPT_VERSION` is load-bearing:** without it, every prompt iteration in Phase 4 silently
serves stale cached verdicts. Bump it on any prompt or schema change.

### 6.3 Schema (Drizzle)

```
documents_meta  accession_no PK, cik, ticker, form_type, item_codes[], filed_at, url
                -- metadata only; text lives in the disk cache
metrics         (cik, period) PK, extracted series JSONB (small), confidence flags, etag, fetched_at
prices          (ticker, date) PK, open, high, low, close, volume
bundles         bundle_hash PK, ticker, run_date, payload JSONB, created_at
analyses        bundle_hash PK → FK bundles, provider, model, prompt_version,
                classification, vote_agreement, output JSONB, retry_count, created_at
runs            id PK, started_at, finished_at, status, candidate_count,
                insufficient_evidence_count, error
predictions     id PK, ticker, run_date, rank, classification, scenarios JSONB,
                falsifier_status, falsifier_checked_at,
                drift_30d, drift_90d, actual_return_1y, actual_return_3y, resolution_note
feedback        (run_date, ticker) PK, worth_my_time boolean, received_at
```

---

## 7. The analytics step — the most important section

### 7.1 Separate computation from interpretation — and sanity-check the computation

**The LLM must not calculate anything.** All metrics computed in TypeScript from XBRL facts,
each carrying the accession number it derived from:

- FCF margin, operating margin, gross margin — and their trends
- Net debt / EBITDA, interest coverage
- Cash runway (quarters, if FCF negative)
- Share count change (dilution)
- Revenue growth and *deceleration*
- Working capital movements, notably inventory vs revenue divergence

**RATIONALE:** LLMs are unreliable at arithmetic, and an arithmetic error is indistinguishable
from a genuine finding in the output. A number computed in code can be unit-tested.

**But moving computation into code moves the risk, it doesn't eliminate it:** a wrongly
*computed* metric is presented to the model as ground truth, and citation validation will
happily bless claims derived from it. So every ticker's metrics pass a **sanity layer** before
entering the bundle:

- Balance-sheet identity check (assets ≈ liabilities + equity within tolerance)
- Sign/magnitude checks (gross margin ∈ [−100%, 100%], no impossible values)
- Series-continuity check (a >50% QoQ revenue jump with a tag-chain switch = suspect a
  phantom discontinuity, not a finding)
- Period-alignment check (compared quarters actually adjacent per `fy`/`fp`)

Failures don't drop the ticker; they set a per-ticker **`metrics_confidence: high | degraded`
flag that travels in the bundle** and is stated in the prompt ("some computed metrics for this
company failed validation; do not reason from the flagged values"). Expect 10–20% of candidates
to trip at least one check — that's the layer working, not failing.

### 7.2 Compute the deltas, not just the levels

The most informative input is **what changed**. Computed in code before the model sees anything:

- This quarter vs prior quarter vs year-ago: revenue, each margin, cash flow
- Share count change, debt change
- Stock move vs sector ETF vs SPY (the sector-vs-company fact, §4.3)

Hand the model the diff. `"gross margin −340bp QoQ while inventory +22%"` is an analyzable
fact. A wall of raw statements is not.

**Guidance old-vs-new is a text task, not a code task** (v1 misfiled it). Guidance lives in
free-form press-release prose; do not attempt to parse it deterministically. Instead: a cheap
structured-extraction LLM call pulls guidance figures from each 8-K exhibit into a schema
(metric, period, low, high, verbatim quote), and *then* code diffs consecutive extractions.
Extraction is not arithmetic, so this doesn't violate §7.1 — but the verbatim quote is required
so the human can verify. If extraction confidence is low, ship `guidance_change: unclear`
rather than a wrong diff.

### 7.3 What the LLM actually does

Only the parts code cannot do:

1. **Classify the drop cause** — the primary output. **Multi-label: a `primary` and optional
   `secondary` cause** (real drops are mixtures — guidance cut *and* sector rerate):
   - `mechanical` — index removal, lockup expiry, secondary offering, tax-loss selling
   - `sentiment` — a peer missed, sector rerated, macro
   - `thesis_breaking` — guidance cut, trial failure, customer loss, accounting problem
   - `insufficient_evidence` — the bundle does not explain the drop. **A first-class outcome,
     expected on a large minority of names** (many drops have no filing). On a large-cap name,
     "nothing in the filings explains this" is itself interesting and should be said plainly.
2. Read management's language for hedging, blame-shifting, and what they conspicuously stopped
   mentioning versus last quarter
3. Judge whether a guidance change is a timing issue or a demand issue
4. **Reconcile narrative against numbers** — where does management's story disagree with the
   cash flow statement? (Precision expectations and guardrails in §7.4.)

**Self-consistency voting:** the classification call runs **3× per ticker** (cheap on Flash)
and takes the majority label. Record the vote agreement in `analyses.vote_agreement` — it is a
per-ticker confidence signal *and* an aggregate health metric (§11). Disagreement across votes
means the evidence is ambiguous; say so in the report rather than presenting the majority label
as settled.

**RATIONALE:** "is this company healthy" is answered better and more cheaply by deterministic
metrics. Drop-cause classification is where a language model genuinely beats a spreadsheet —
and it is the actual signal, since only `mechanical` and `sentiment` contain candidates for
"temporarily dropped, may recover."

### 7.4 The reconciliation is a low-precision bonus — build it that way

Narrative-vs-numbers reconciliation is high-value *when it hits*, but LLMs are enthusiastic
discrepancy-finders: normal seasonality flagged as inventory divergence, non-cash items flagged
as cash-flow contradictions. Expect ~1 genuine insight per 10 flags. Guardrails:

- Each reconciliation claim must cite **both** the specific XBRL fact **and** the verbatim
  management sentence it contradicts. Either missing → claim dropped in validation.
- The prompt carries a known-benign-explanations checklist (seasonality, one-time items,
  non-cash charges, deferred revenue timing) and instructs the model to check against it first.
- The report labels this section "possible discrepancies to glance at" — never "findings."

### 7.5 Grounding must be verifiable

Every factual claim in the model's output carries a source ID: an accession number, or an XBRL
concept key present in the bundle.

**Then validate in code.** Parse the output, check each cited ID exists in the bundle, reject
and retry on failure — **at most 2 retries**, then record `validation_failed` for that ticker
and move on (one persistently hallucinating ticker must not wedge the run). Claims that survive
validation reach the report; claims that do not are dropped.

**RATIONALE:** the model has seen these tickers thousands of times in training and will import
priors, producing plausible facts that are not in your data. Citation validation catches the
confident fabrications and measurably changes model behaviour just by being present in the
schema. **What it does not catch: biased classification.** The model can cite only bundle facts
while still classifying NVDA through the lens of everything it remembers about NVDA. That risk
is measured, not prevented — via the anonymization A/B in Phase 4 (§12) and the drift tracking
in §10.

Also instruct explicitly: *reason only from the provided bundle; if the bundle is insufficient
to answer, say `insufficient_evidence` rather than inferring.*

### 7.6 Model strategy — Flash-only, synchronous, no Batch API

**Start with Gemini Flash for everything** — triage, deep analysis, ranking, guidance
extraction. Daily volume is ~30 tickers × 3 classification votes + ~10 deep analyses + 1
ranking call ≈ 100 requests / ~1M input tokens: within the AI Studio free tier at this volume,
and single-digit dollars per month even fully paid. Upgrade only the deep-analysis and ranking
calls to Pro if Phase 4 evaluation shows Flash quality is insufficient — decide from evidence,
not upfront.

**Do not use the Batch API.** v1 recommended it (~50% discount, ~24h turnaround) while also
specifying a single Actions job that runs to completion — contradictory, since a job can't wait
24h (6h hard limit). Batch would force a two-workflow submit/collect design with state handed
between runs: real complexity to discount a bill that is already near zero. Sequential
synchronous calls with exponential backoff and jitter; no parallel fan-out (free-tier RPM
limits are tight).

**Token budget: hard cap ~50k tokens per bundle.** "Read the filings" is otherwise unbounded —
a 10-K is 60k+ tokens alone. The 8-K/EX-99.1 goes in near-whole (it's small and it's the
point). For 10-Q/10-K, include extracted sections only: MD&A, and the risk-factor *diff* vs the
prior filing — plus the computed metrics, which already summarize the statements. If the cap is
hit, drop oldest/lowest-tier content first and record what was dropped in the bundle.

**Gemini specifics:** use `responseSchema` with `responseMimeType: "application/json"` — schema
enforced server-side, so you get well-formed JSON and only need to validate citations.

### 7.7 Two passes

**Pass A — per-ticker analyst.** One deep call per surviving candidate (after 3-vote
classification). Structured JSON out.

**Pass B — ranking.** All verdicts in one call, picks 10, justifies the ordering.

**RATIONALE:** independent per-ticker scores drift badly across calls and are not comparable. A
single ranking pass sees all candidates at once. **Ranking has position bias:** run the pass
twice with input order reversed; if the two top-10 sets differ by more than 2 names, flag the
run's ranking as unstable in the report footer. Costs one extra call.

---

## 8. Scenarios

For each of the final 10, produce bear / base / bull at **1 year** and **3 years**. Each
scenario must carry:

- A weight, **labeled in the report as a narrative weight, not a probability** — LLM
  probabilities are not calibrated; they cluster at 20/50/30-style archetypes regardless of
  the company. The scoring loop tracks their calibration anyway (§10); expect it to be poor
  and say so if a reader asks the system to be trusted on them.
- The 2–3 drivers that would have to be true
- A **structured valuation anchor**: metric (EV/EBITDA, P/E, …), multiple, and the assumed
  absolute metric value in that scenario. These are LLM *assumptions*; the implied per-share
  value is computed **in code** (current net debt and share count) and shown next to the
  current price in the digest and report, labeled "anchor, not a price target." Assumptions
  are sanity-bounded in validation (0.1×–10× of the TTM actual). This is as close to a "fair
  price" as this product gets — see §2 for why explicit buy prices stay out.
- **A falsifier** — a specific observable within 90 days that would kill this scenario. *This
  is the only part of the scenario with real epistemic content.* A falsifier must name a
  concrete, checkable event ("Q3 gross margin below 40%", "no new 10%+ customer disclosed by
  the next 10-Q") — validation rejects vague falsifiers ("sentiment improves").

**RATIONALE:** the scenario structure forces the thesis to be articulated; the falsifier makes
it gradeable on a 90-day loop — fast enough to actually steer prompt iteration, unlike 1y/3y
returns. Without the falsifier you get plausible narrative with no way to learn from it.

---

## 9. Delivery

**Telegram Bot API.** `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` from GitHub Secrets.

### 9.1 Digest

- One line per name — ticker, drop %, classification (with vote agreement if < 3/3),
  one-clause thesis, and **an anomaly flag where one exists** (insider bought into the crash;
  metrics contradict management; `insufficient_evidence` on a $10B name). Anomalies lead;
  summaries follow. **RATIONALE:** the reader's alert fatigue is the true failure mode.
  Disagreement and anomaly are what keep the digest worth opening; fluent summary is what
  kills it.
- **Full report:** attached via `sendDocument` as HTML.
- **Message limit is 4096 characters** — the digest must fit; the report is the attachment.
- **Use `parse_mode: "HTML"`, not MarkdownV2** (MarkdownV2 escaping of financial text is an
  evening of bugs for zero benefit).
- **Heartbeat:** on days with no candidates, send "no candidates today." Silence is ambiguous
  between "nothing qualified" and "the pipeline died."

### 9.2 Feedback buttons — the success metric, measured

Each name in the digest carries an inline keyboard: **👍 worth my time / 👎 not**. This is the
project's *stated* success metric (§2) and v1 never captured it. One tap per name accumulates
the only supervised signal aligned with the actual goal; after a couple of months it shows
which drop-classes and evidence conditions produce names the reader valued — which is what
prompts and screen thresholds get tuned against.

### 9.3 Receiving the taps

Inline-button callbacks need an HTTPS endpoint or a polling process; the nightly job is neither.
Cheapest solution that stays in one repo: the nightly job (and the weekly scoring job) calls
Telegram's `getUpdates` at startup and drains any pending callback queries into the `feedback`
table — taps are collected on the next run, which is fine; this data is read monthly, not live.
No webhook, no server, no new infrastructure. (If instant acknowledgment ever matters, a free
webhook receiver can be added later; do not build it in v1.)

### 9.4 Failure alert

```yaml
- name: Notify failure
  if: failure()
  run: |
    curl -s -X POST "https://api.telegram.org/bot${{ secrets.TELEGRAM_BOT_TOKEN }}/sendMessage" \
      -d chat_id=${{ secrets.TELEGRAM_CHAT_ID }} \
      -d text="Pipeline failed — run ${{ github.run_id }}"
```

---

## 10. The scoring loop — build early, do not skip

A weekly scheduled workflow that grades past predictions. **v1 graded only forward returns —
which §2 explicitly says is not the success metric, and which arrives too late (1–3 years) to
steer anything.** The loop grades three things, fastest first:

1. **Falsifier resolution (90 days).** For each scenario, did the named observable occur?
   Status: `fired` / `survived` / `uncheckable`. A high `uncheckable` rate means the analyst
   prompt is emitting vague falsifiers — feed that back into Phase-4 prompt iteration. *This is
   the primary loop; it is the only one fast enough to improve the system that generated it.*
2. **Classification drift (30/90 days).** Weak-label validation: `thesis_breaking` names should
   keep underperforming (PEAD); `mechanical`/`sentiment` names should mean-revert relative to
   sector. Per-class average drift after ~50–100 samples tells you whether the classifier
   carries signal at all. At 2–3 interesting names/day this takes months to become significant
   — expected; start counting from day one, which is why this ships in Phase 6, not later.
3. **Returns (1y/3y)** into `actual_return_1y/3y`, plus scenario-weight calibration. Recorded
   for honesty, not steering.

**Resolution rule for dead tickers:** acquisitions after a crash are common, and Yahoo erases
delisted history (trap #7). On delisting: if acquired, resolve at the deal price with
`resolution_note = "acquired"` (arguably a funnel win); if delisted for cause, resolve at last
traded price with the reason noted. Never leave predictions unresolvable silently.

**RATIONALE:** this is the only thing that ever tells you whether the pipeline works.
Retrofitting it later means losing the first months of data.

---

## 11. Pipeline health metrics — logged every run, reviewed monthly

Cheap to record, and they convert the design's unmeasurable risks into measured ones:

| Metric | Healthy range | What it detects |
|---|---|---|
| `insufficient_evidence` rate | ~25–40% | Near 0% → the model is confabulating causes for drops that have no filing. Near 80% → enrichment is failing. |
| Classification vote agreement (3-vote) | ≥ 80% avg | Below → the classifier is noise on this input distribution; know it in week one, not month six. |
| Citation-validation rejection rate | < 20% | Rising → prompt regression or prior contamination worsening. |
| Metrics sanity-check trip rate | 10–20% | Near 0% → checks too loose. Much higher → extractor bugs. |
| Falsifier `uncheckable` rate | < 25% | The analyst is emitting vague falsifiers. |
| 👍 rate on surfaced names | trending up | The actual product metric. |
| Cache hit rate on analyses | meaningful > 0 | Bundle hash mis-defined if always 0 (§6.2). |

---

## 12. Build phases

Each phase has an acceptance criterion. Do not proceed until it is met.

**Phase 1 — prove the screen (1 day, grown from ½ — the universe sweep is real work)**
Local script. No DB, no LLM. Universe seed from EDGAR ticker file, Yahoo batch-quote sweep,
floors + triggers, print survivors.
*Acceptance:* run 3–4 days and eyeball the output. Are these real companies or shells? Two
names or forty? Does the batch quote sweep reliably return the fields §5.1 needs (verify
against the installed `yahoo-finance2` version)? **Every downstream decision depends on this
answer and it cannot be guessed.**

**Phase 2 — EDGAR client + XBRL extractor + sanity layer (2 days)**
Rate limiter, User-Agent, CIK mapping, submissions, companyfacts, document fetch, section
extraction (MD&A, risk factors), tag fallback chains, fiscal alignment, the §7.1 sanity checks.
Write bundles to disk as JSON.
*Acceptance:* for 5 hand-picked tickers (include one with a fiscal year not ending in December
and one recent restatement), extracted metrics match the actual filings, verified manually, and
the sanity layer correctly flags a deliberately corrupted input. This is where hidden work lives.

**Phase 3 — persistence (½ day)**
Neon, Drizzle, schema (§6.3), disk cache + `actions/cache`, ETag conditional requests.
*Acceptance:* second run of the same day fetches ~nothing from the network, and Postgres growth
per run is < 1MB.

**Phase 4 — analyst (2–3 days, mostly prompt iteration)**
Classification (3-vote), deep pass, ranking pass (with reversed-order stability check), JSON
schemas, citation validation with retry cap, guidance extraction. Run against the Phase-2 JSON
files so prompts iterate offline, free, and reproducibly.
*Acceptance:*
- Outputs contain no uncited claims; `insufficient_evidence` actually appears on thin bundles.
- **Anonymization A/B:** run ≥10 bundles with tickers/company names masked ("Company A") and
  unmasked; classifications should substantially agree. Divergence = measured prior
  contamination — tighten the evidence requirements in the prompt and re-test.
- 3-vote self-agreement ≥ 80% on the test set.
- Every falsifier in the output names a concrete, checkable event.
Expect v1 prompts to read plausibly and be useless; that is normal and is fixed by tightening
the schema and evidence requirements, guided by the numbers above.

**Phase 5 — delivery + automation (1 day)**
Telegram digest with inline feedback buttons, `getUpdates` drain, HTML report attachment,
Actions workflow, holiday-calendar early exit, failure alert, heartbeat.

**Phase 6 — scoring loop (1 day)**
Weekly workflow: falsifier grading, drift tracking, returns, dead-ticker resolution, and the
§11 health-metrics rollup posted monthly to Telegram.

---

## 13. Configuration

Every threshold in **one file**, no magic numbers in logic:

```ts
export const config = {
  screen: {
    minMarketCap: 2_000_000_000,
    minPrice: 5,
    minAvgVolume: 500_000,
    usDomesticOnly: true,
    excludeSicRanges: [[6000, 6799]],           // financials/REITs, v1
    triggers: { dayDrop: -0.20, monthDrop: -0.25, from52WeekHigh: -0.40 },
    maxCandidates: 30,
    cooldownDays: 14,
  },
  edgar: { userAgent: process.env.SEC_USER_AGENT!, requestsPerSecond: 8 },
  llm: {
    model: "gemini-flash",                      // one tier until Phase 4 proves otherwise
    classificationVotes: 3,
    maxBundleTokens: 50_000,
    maxCitationRetries: 2,
    promptVersion: 1,                           // part of the bundle hash — bump on any prompt change
  },
  output: { topN: 10, horizonsYears: [1, 3] },
};
```

**Secrets** (GitHub Secrets — never committed, never pasted into a chat):
`SEC_USER_AGENT`, `GEMINI_API_KEY`, `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

---

## 14. Known traps

1. **EDGAR 403** — missing or malformed User-Agent. Most common failure.
2. **EDGAR IP block** — exceeding 10 req/sec blocks ~10 minutes. Shared limiter, always.
3. **XBRL tag variation** — fallback chains, log misses. Plus fiscal alignment and
   restatements (§4.1) — the sanity layer exists because of these.
4. **Yahoo endpoint drift** — will break eventually. Interface + clear error + verify the
   installed version's API at build time.
5. **Actions cron is UTC-only** and drifts across DST. Accept it, or two date-gated schedules.
6. **Actions disables schedules** on repos inactive 60 days. Keepalive commit.
7. **Delisted tickers** — Yahoo removes all history. Resolution rule in §10; enrichment must
   also tolerate a candidate vanishing mid-run.
8. **Empty days are normal.** Zero candidates is a heartbeat, not an error.
9. **Neon free tier is 0.5GB** — hence §6: derived data only, documents live on disk/EDGAR.
10. **Stale cached verdicts after prompt changes** — hence `promptVersion` in the bundle hash.
11. **One hallucinating ticker wedging the run** — hence the citation-retry cap.
12. **`actions/cache` eviction** (7-day unused / 10GB) — treat as cache, never as storage;
    everything on disk must be re-derivable from EDGAR.

---

## 15. Cost envelope

| Item | Expected |
|---|---|
| GitHub Actions | $0 (public) or within free minutes (private, ~660/2000 per month) |
| Neon Postgres | $0 (free tier; §6 keeps growth well under 0.5GB) |
| EDGAR, Yahoo, Telegram | $0 |
| Gemini | $0 on AI Studio free tier at ~100 requests/day; worst case ~$5–10/month paid on Flash |

**Total: ~$0/month, worst case ~$10/month.** Any design change that adds a paid service needs a
reason written into this document.

---

## 16. Disclaimer

This produces research, not investment advice. Output is a queue of names warranting human
investigation. Any user-facing surface must say so.
