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

interface TgMessage {
  text?: string;
  chat?: { id: number };
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
    geminiSet: Boolean(process.env.GEMINI_API_KEY),
  };
  if (process.env.GEMINI_API_KEY) {
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
        headers: { "x-goog-api-key": process.env.GEMINI_API_KEY },
      });
      diag.gemini = r.ok ? "ok" : `FAIL: HTTP ${r.status}`;
    } catch (err) {
      diag.gemini = `THREW: ${(err as Error).message}`;
    }
  }
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

  const update = (await request.json().catch(() => ({}))) as {
    callback_query?: TgCallbackQuery;
    message?: TgMessage;
  };
  const { waitUntil } = await import("@vercel/functions");

  const cq = update.callback_query;
  if (cq?.data?.startsWith("fb|")) {
    // Acknowledge Telegram immediately — a cold-starting Neon connection must
    // not eat into the webhook response window. Real work runs post-response.
    waitUntil(processTap(cq).catch((err) => console.error("webhook background error:", (err as Error).message)));
    return Response.json({ ok: true });
  }

  // Text message = the reader arguing with a prediction (debate channel).
  const msg = update.message;
  const isOwner = msg?.chat?.id != null && String(msg.chat.id) === process.env.TELEGRAM_CHAT_ID;
  if (isOwner && msg?.text && msg.text.length > 10 && !msg.text.startsWith("/")) {
    waitUntil(processArgument(msg).catch((err) => console.error("argument error:", (err as Error).message)));
  }
  return Response.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Debate channel: the reader argues with a recorded analysis; the AI
// re-examines it against the stored data and replies — concede, partial, or
// hold, with the observable that would settle it. The argument persists in
// user_arguments; every future analysis of the ticker must address it.
// ---------------------------------------------------------------------------
async function processArgument(msg: TgMessage): Promise<void> {
  const chatId = msg.chat!.id;
  const text = msg.text!;
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, connect_timeout: 15, onnotice: () => {} });
  try {
    // Which ticker? Match uppercase tokens against companies we actually know.
    const known = new Set(
      (await sql<{ ticker: string }[]>`SELECT ticker FROM performance UNION SELECT ticker FROM cards`).map(
        (r) => r.ticker,
      ),
    );
    const tokens = text.toUpperCase().match(/\$?\b[A-Z]{1,5}\b/g) ?? [];
    const ticker = tokens.map((t) => t.replace("$", "")).find((t) => known.has(t));
    if (!ticker) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: `I couldn't match a ticker I've analyzed. Mention it explicitly (e.g. "RBLX: your bear case ignores…"). Known: ${[...known].sort().join(", ")}`,
      });
      return;
    }

    // Context: the recorded prediction, performance record, prior arguments.
    const [predRow] = await sql<{ value: unknown }[]>`SELECT value FROM state_kv WHERE name = 'predictions'`;
    const preds = (predRow?.value ?? []) as {
      ticker: string; runDate: string; classification: string; thesis?: string;
      fairValue1y?: number | null; refPrice: number; economics?: unknown;
      scenarios?: { horizonYears: string; scenarioCase: string; falsifier: string; narrativeWeight: number }[];
    }[];
    const pred = preds.filter((p) => p.ticker === ticker).sort((a, b) => a.runDate.localeCompare(b.runDate)).at(-1);
    const [perf] = await sql<{ data: unknown }[]>`SELECT data FROM performance WHERE ticker = ${ticker}`;
    const priorArgs = await sql<{ user_text: string; distilled_note: string; created_at: Date }[]>`
      SELECT user_text, distilled_note, created_at FROM user_arguments WHERE ticker = ${ticker} ORDER BY created_at DESC LIMIT 3`;

    const prompt = `You are the research agent behind a disciplined valuation system. The reader — your
principal — is arguing with your recorded analysis of ${ticker}. Engage as a colleague, not a
defender. Rules: reason only from the RECORDED DATA below and the reader's argument; no price
predictions; if the reader identifies a factual error or a consideration you missed, concede
explicitly; if the recorded filed data contradicts them, say which number; always name the
observable that would settle the disagreement.

RECORDED ANALYSIS (${pred?.runDate ?? "unknown"}): ${JSON.stringify({
      classification: pred?.classification,
      thesis: pred?.thesis,
      fairValue1y: pred?.fairValue1y,
      refPrice: pred?.refPrice,
      economics: pred?.economics ?? null,
      killSwitches: pred?.scenarios?.map((s) => `${s.horizonYears}y ${s.scenarioCase}: ${s.falsifier}`),
    })}
PERFORMANCE RECORD: ${JSON.stringify(perf?.data ?? null)}
PRIOR READER OBJECTIONS: ${priorArgs.map((a) => `[${a.created_at.toISOString().slice(0, 10)}] ${a.user_text} → noted: ${a.distilled_note}`).join(" | ") || "none"}

READER'S ARGUMENT: "${text.slice(0, 1500)}"`;

    const schema = {
      type: "OBJECT",
      properties: {
        reply: { type: "STRING", description: "Your response to the reader, under 250 words, plain text" },
        standing: { type: "STRING", enum: ["concede_update", "partial", "hold"] },
        distilledNote: {
          type: "STRING",
          description: "One sentence: what every future analysis of this ticker must now address",
        },
      },
      required: ["reply", "standing", "distilledNote"],
    };
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY! },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.4 },
        }),
      },
    );
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
      error?: { message?: string };
    };
    const raw = data.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? "").join("");
    if (!raw) throw new Error(data.error?.message ?? "no model output");
    const out = JSON.parse(raw) as { reply: string; standing: string; distilledNote: string };

    await sql`INSERT INTO user_arguments (ticker, user_text, ai_reply, standing, distilled_note)
              VALUES (${ticker}, ${text.slice(0, 2000)}, ${out.reply.slice(0, 3000)}, ${out.standing}, ${out.distilledNote.slice(0, 500)})`;

    const badge = out.standing === "concede_update" ? "🔄 conceded" : out.standing === "partial" ? "⚖️ partially accepted" : "🛡 holding";
    const escT = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    await tg("sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text:
        `💬 <b>${ticker}</b> — ${badge}\n\n${escT(out.reply)}\n\n` +
        `<i>Logged: "${escT(out.distilledNote)}" — every future analysis of ${ticker} must address this.</i>`,
    });
  } finally {
    await sql.end();
  }
}

async function processTap(cq: TgCallbackQuery): Promise<void> {
  const [, runDate, ticker, vote] = cq.data!.split("|");
  if (!runDate || !ticker) return;
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
      return;
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
}
