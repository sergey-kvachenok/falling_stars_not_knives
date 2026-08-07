import { config } from "../config.js";
import { readState, writeState } from "../lib/state.js";

// Telegram Bot API (PLAN.md §9). HTML parse mode, never MarkdownV2 —
// financial text is full of characters MarkdownV2 requires escaping.

const api = (method: string) => `https://api.telegram.org/bot${config.telegram.botToken}/${method}`;

export function telegramConfigured(): boolean {
  return Boolean(config.telegram.botToken && config.telegram.chatId);
}

async function call<T>(method: string, body: object): Promise<T> {
  const res = await fetch(api(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; description?: string; result?: T };
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
  return data.result as T;
}

export interface FeedbackButton {
  ticker: string;
  runDate: string;
}

/** Digest message with per-name 👍/👎 inline buttons (PLAN.md §9.2). */
export async function sendDigest(html: string, buttons: FeedbackButton[]): Promise<void> {
  // callback_data is capped at 64 bytes — "fb|YYYY-MM-DD|TICKER|1" fits.
  const keyboard = buttons.map((b) => [
    { text: `👍 ${b.ticker}`, callback_data: `fb|${b.runDate}|${b.ticker}|1` },
    { text: `👎 ${b.ticker}`, callback_data: `fb|${b.runDate}|${b.ticker}|0` },
  ]);
  await call("sendMessage", {
    chat_id: config.telegram.chatId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard.length > 0 ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

export async function sendHeartbeat(text: string): Promise<void> {
  await call("sendMessage", { chat_id: config.telegram.chatId, text, parse_mode: "HTML" });
}

/** Full report as an HTML file attachment — the digest links to nothing else. */
export async function sendReport(filename: string, htmlContent: string, caption: string): Promise<void> {
  const form = new FormData();
  form.append("chat_id", config.telegram.chatId);
  form.append("caption", caption);
  form.append("document", new Blob([htmlContent], { type: "text/html" }), filename);
  const res = await fetch(api("sendDocument"), { method: "POST", body: form });
  const data = (await res.json()) as { ok: boolean; description?: string };
  if (!data.ok) throw new Error(`Telegram sendDocument: ${data.description ?? res.status}`);
}

export interface FeedbackEntry {
  runDate: string;
  ticker: string;
  worthMyTime: boolean;
  receivedAt: string;
}

interface TgUpdate {
  update_id: number;
  callback_query?: { id: string; data?: string };
}

/**
 * Drain pending feedback taps (PLAN.md §9.3): no webhook, no server — the
 * nightly job collects callback queries via getUpdates at startup. Taps are
 * read monthly, not live, so next-run latency is fine.
 */
export async function drainFeedback(): Promise<FeedbackEntry[]> {
  const { offset } = readState("telegram-offset", { offset: 0 });
  let updates: TgUpdate[];
  try {
    updates = await call<TgUpdate[]>("getUpdates", { offset, timeout: 0, allowed_updates: ["callback_query"] });
  } catch (err) {
    // A registered webhook makes getUpdates 409 — the webhook collects
    // feedback now, so polling has nothing to do.
    if ((err as Error).message.includes("webhook is active")) return [];
    throw err;
  }
  const entries: FeedbackEntry[] = [];
  let maxId = offset - 1;
  for (const u of updates) {
    maxId = Math.max(maxId, u.update_id);
    const data = u.callback_query?.data;
    if (!data?.startsWith("fb|")) continue;
    const [, runDate, ticker, vote] = data.split("|");
    if (!runDate || !ticker) continue;
    entries.push({ runDate, ticker, worthMyTime: vote === "1", receivedAt: new Date().toISOString() });
    // Best-effort ack; old queries can no longer be answered — ignore failures.
    if (u.callback_query) {
      await call("answerCallbackQuery", { callback_query_id: u.callback_query.id, text: "recorded" }).catch(() => {});
    }
  }
  if (updates.length > 0) writeState("telegram-offset", { offset: maxId + 1 });
  if (entries.length > 0) {
    const log = readState<FeedbackEntry[]>("feedback", []);
    writeState("feedback", [...log, ...entries]);
    // Mirror into the feedback table so polling and webhook modes share one ledger.
    const { insertFeedbackDb } = await import("../lib/db.js");
    await insertFeedbackDb(entries).catch(() => {});
  }
  return entries;
}
