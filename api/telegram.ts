import postgres from "postgres";

// Telegram webhook (Vercel Function, Node runtime). Deliberately
// self-contained — no imports from src/ — so it deploys with zero build
// configuration. Telegram POSTs here the instant a digest button is tapped:
//   1. verify the secret token set by `npm run webhook -- <url>`
//   2. record the vote in the feedback table (same one the pipeline reads)
//   3. on 👍, reply immediately with the precomputed expanded card plus the
//      live price and its distance to the blended 1y anchor
// Required env on Vercel: DATABASE_URL, TELEGRAM_BOT_TOKEN,
// TELEGRAM_WEBHOOK_SECRET.

interface TgCallbackQuery {
  id: string;
  data?: string;
  message?: { chat?: { id: number } };
}

const api = (method: string) => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;

async function tg(method: string, body: object): Promise<void> {
  try {
    const res = await fetch(api(method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { ok: boolean; description?: string };
    if (!data.ok) console.error(`telegram ${method} failed: ${data.description}`);
  } catch (err) {
    console.error(`telegram ${method} threw: ${(err as Error).message}`);
  }
}

async function livePrice(ticker: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`,
      { headers: { "User-Agent": "Mozilla/5.0" } },
    );
    const data = (await res.json()) as { chart?: { result?: { meta?: { regularMarketPrice?: number } }[] } };
    return data.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
  } catch {
    return null;
  }
}

/** Secret-protected self-diagnostic: verifies the function's own credentials. */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return new Response("forbidden", { status: 403 });
  }
  const diag: Record<string, unknown> = {
    tokenSet: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    dbSet: Boolean(process.env.DATABASE_URL),
  };
  if (process.env.TELEGRAM_BOT_TOKEN) {
    try {
      const res = await fetch(api("getMe"));
      const data = (await res.json()) as { ok: boolean; description?: string; result?: { username?: string } };
      diag.getMe = data.ok ? `ok @${data.result?.username}` : `FAIL: ${data.description}`;
    } catch (err) {
      diag.getMe = `THREW: ${(err as Error).message}`;
    }
  }
  if (process.env.DATABASE_URL) {
    const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 15, onnotice: () => {} });
    try {
      const [row] = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM cards`;
      diag.cards = row?.n;
    } catch (err) {
      diag.cards = `FAIL: ${(err as Error).message}`;
    } finally {
      await sql.end();
    }
  }
  return Response.json(diag);
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return new Response("forbidden", { status: 403 });
  }

  const update = (await request.json().catch(() => ({}))) as { callback_query?: TgCallbackQuery };
  const cq = update.callback_query;
  if (!cq?.data?.startsWith("fb|")) return Response.json({ ok: true });

  const [, runDate, ticker, vote] = cq.data.split("|");
  if (!runDate || !ticker) return Response.json({ ok: true });
  const up = vote === "1";
  const chatId = cq.message?.chat?.id;

  const sql = postgres(process.env.DATABASE_URL!, { max: 1, connect_timeout: 15, onnotice: () => {} });
  try {
    await sql`CREATE TABLE IF NOT EXISTS feedback (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      run_date text NOT NULL, ticker text NOT NULL,
      worth_my_time boolean NOT NULL, received_at timestamptz NOT NULL DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS cards (
      ticker text PRIMARY KEY, run_date text NOT NULL, ref_price double precision,
      weighted_anchor_1y double precision, html text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now())`;
    await sql`INSERT INTO feedback (run_date, ticker, worth_my_time, received_at)
              VALUES (${runDate}, ${ticker}, ${up}, now())`;
    // runDate sentinel "news" = mute button on a news message, not a vote.
    if (runDate === "news") {
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: `🔕 news muted for ${ticker}` });
      return Response.json({ ok: true });
    }
    await tg("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: up ? `👍 ${ticker} recorded — details incoming` : `👎 ${ticker} recorded`,
    });

    if (up && chatId) {
      const rows = await sql<{ html: string; weighted_anchor_1y: number | null }[]>`
        SELECT html, weighted_anchor_1y FROM cards WHERE ticker = ${ticker}`;
      const card = rows[0];
      let text: string;
      if (!card) {
        text = `No stored card for <b>${ticker}</b> — it predates the card feature; it will exist after the next run that surfaces it.`;
      } else {
        text = card.html;
        const price = await livePrice(ticker);
        if (price) {
          const vs =
            card.weighted_anchor_1y && card.weighted_anchor_1y > 0
              ? ` · vs blended 1y anchor $${card.weighted_anchor_1y.toFixed(2)}: ${(
                  (price / card.weighted_anchor_1y - 1) * 100
                ).toFixed(0)}%`
              : "";
          text += `\n\n📈 <b>Live now: $${price.toFixed(2)}</b>${vs} <i>(negative = below anchor)</i>`;
        }
      }
      await tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });
    }
  } catch (err) {
    console.error("webhook error:", (err as Error).message);
  } finally {
    await sql.end();
  }
  return Response.json({ ok: true });
}
