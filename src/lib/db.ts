import postgres from "postgres";
import type { FeedbackEntry } from "../deliver/telegram.js";

// Row-level tables for data written from MORE THAN ONE place (unlike
// state_kv blobs, which only the batch jobs touch):
//   feedback — appended by the Telegram webhook (api/telegram.ts) the moment
//              a button is tapped, and by the getUpdates drain in local mode
//   cards    — expanded ticker cards precomputed by the nightly pipeline,
//              read by the webhook to answer a 👍 instantly
// Without DATABASE_URL every function is a no-op / null and the file layer
// stands alone.

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return postgres(url, { max: 1, connect_timeout: 20, onnotice: () => {} });
}

type Sql = NonNullable<ReturnType<typeof db>>;

export async function ensureRowTables(sql: Sql): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS feedback (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_date text NOT NULL,
    ticker text NOT NULL,
    worth_my_time boolean NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS cards (
    ticker text PRIMARY KEY,
    run_date text NOT NULL,
    ref_price double precision,
    weighted_anchor_1y double precision,
    html text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`;
}

export async function insertFeedbackDb(entries: FeedbackEntry[]): Promise<void> {
  const sql = db();
  if (!sql || entries.length === 0) return;
  try {
    await ensureRowTables(sql);
    for (const e of entries) {
      await sql`INSERT INTO feedback (run_date, ticker, worth_my_time, received_at)
                VALUES (${e.runDate}, ${e.ticker}, ${e.worthMyTime}, ${e.receivedAt})`;
    }
  } finally {
    await sql.end();
  }
}

/** null = no DATABASE_URL (caller falls back to the local file). */
export async function loadFeedbackDb(): Promise<FeedbackEntry[] | null> {
  const sql = db();
  if (!sql) return null;
  try {
    await ensureRowTables(sql);
    const rows = await sql<{ run_date: string; ticker: string; worth_my_time: boolean; received_at: Date }[]>`
      SELECT run_date, ticker, worth_my_time, received_at FROM feedback ORDER BY received_at`;
    return rows.map((r) => ({
      runDate: r.run_date,
      ticker: r.ticker,
      worthMyTime: r.worth_my_time,
      receivedAt: r.received_at.toISOString(),
    }));
  } finally {
    await sql.end();
  }
}

export interface CardRow {
  ticker: string;
  runDate: string;
  refPrice: number | null;
  weightedAnchor1y: number | null;
  html: string;
}

export async function upsertCards(cards: CardRow[]): Promise<boolean> {
  const sql = db();
  if (!sql) return false;
  try {
    await ensureRowTables(sql);
    for (const c of cards) {
      await sql`INSERT INTO cards (ticker, run_date, ref_price, weighted_anchor_1y, html, updated_at)
                VALUES (${c.ticker}, ${c.runDate}, ${c.refPrice}, ${c.weightedAnchor1y}, ${c.html}, now())
                ON CONFLICT (ticker) DO UPDATE SET run_date = EXCLUDED.run_date,
                  ref_price = EXCLUDED.ref_price, weighted_anchor_1y = EXCLUDED.weighted_anchor_1y,
                  html = EXCLUDED.html, updated_at = now()`;
    }
    return true;
  } finally {
    await sql.end();
  }
}
