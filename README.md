# stock-agent

Nightly post-drop equity research pipeline. Full design in [PLAN.md](./PLAN.md) — read it
before changing anything; it is the brief.

**This produces research, not investment advice.** Output is a queue of names warranting
human investigation.

## Status

- [x] Phase 1 — screen (universe sweep, floors, triggers) — `npm run screen`
- [x] Phase 2 — EDGAR client + XBRL extractor + sanity layer — `npm run bundle -- TICKER…`, `npm test`
- [x] Phase 3 — persistence: durable state syncs to Neon Postgres when `DATABASE_URL` is set (single `state_kv` table); disk caches remain re-derivable from EDGAR
- [x] Phase 4 — analyst (Gemini Flash, classification + verdicts) — `npm run analyze -- [TICKER…] [--anon]` (needs `GEMINI_API_KEY`)
- [x] Phase 5 — delivery (Telegram + feedback buttons) + nightly pipeline — `npm run pipeline` (`--no-telegram --limit N` for local testing); Actions workflow in `.github/workflows/nightly.yml` (repo publishing is manual, done by the owner)
- [x] Phase 6 — scoring loop — `npm run score` (weekly; drift vs SPY at 30/90d, falsifier grading at 90d, returns at 1y/3y, 👍 rate); workflow in `.github/workflows/scoring.yml`

## Setup

```sh
npm install
cp .env.example .env   # set SEC_USER_AGENT to "<name> <your-email>"
npm run screen
```

Results print to the console and are saved to `out/screen-YYYY-MM-DD.json`.
Phase 1 acceptance: run for 3–4 market days and eyeball the survivors (PLAN.md §12).

## Memory

- **Analyst memory**: on a recurring ticker, the deep pass receives its own prior verdicts
  plus a code-computed diff of the two states (new filings, quarter roll, margin/debt/share
  moves, price change) and must report `changeSincePrior` — what changed and why. Citable as
  `prior:<date>`. Classification votes stay memory-free so vote agreement keeps measuring
  evidence ambiguity.
- **Bot memory**: 👎 names stay suppressed for 30 days unless a new filing changes their
  bundle; 👍 names go on a 90-day watchlist and get a follow-up in the digest when they file
  something new; previously surfaced names carry a "seen <date> 👍/👎" marker.

## Fully automated cloud deployment (owner does the publishing)

1. Create a **private** GitHub repo and push this folder (`.env` is gitignored — never commit it).
2. Create a free Neon project (neon.tech) → copy the connection string.
3. Repo → Settings → Secrets and variables → Actions → add:
   `SEC_USER_AGENT`, `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `DATABASE_URL`.
4. Actions tab → enable workflows. `nightly-pipeline` runs weeknights 23:30 UTC,
   `weekly-scoring` runs Sundays. Both can be fired manually via "Run workflow".
5. First cloud run seeds Postgres from nothing; local state can be pre-seeded by running
   `npm run pipeline` once locally with `DATABASE_URL` set (it pushes state at the end).

Note (trap #6): GitHub disables cron schedules on repos with no activity for 60 days —
any commit or manual workflow run resets the clock.

## Instant 👍 replies (Telegram webhook on Vercel)

Tapping 👍 replies immediately with an expanded ticker card: anchor prices per scenario,
the blended 1y anchor with the live price's discount/premium to it, falsifiers, and the
analysis as its own section. Votes also count immediately instead of at the next run.

Setup (once):
1. vercel.com → New Project → import this GitHub repo (framework preset: **Other**; no build
   command needed — only `api/telegram.ts` deploys as a function).
2. Project → Settings → Environment Variables: `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_WEBHOOK_SECRET` (any long random string — also add it to local `.env`).
3. Deploy, then register the webhook:
   `npm run webhook -- https://<project>.vercel.app/api/telegram`
   (`npm run webhook -- --delete` reverts to getUpdates polling.)

With the webhook active, the nightly job's getUpdates drain politely no-ops (Telegram 409)
and the feedback table becomes the single ledger both modes share.
