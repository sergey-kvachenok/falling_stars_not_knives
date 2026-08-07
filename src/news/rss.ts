import { config } from "../config.js";

// Daily news/rumors for 👍 companies via Google News RSS — free, no key.
// This is deliberately OUTSIDE the analysis path: headlines never feed the
// LLM (PLAN.md §4.3 rationale stands); they go straight to the reader, who
// asked for them, with a per-company mute button.

export interface NewsItem {
  title: string;
  link: string;
  source: string;
  pubDate: string;
}

export async function fetchNews(ticker: string, companyName: string): Promise<NewsItem[]> {
  const q = encodeURIComponent(`"${ticker}" OR "${shortName(companyName)}" stock`);
  const url = `https://news.google.com/rss/search?q=${q}+when:2d&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) return [];
  const xml = await res.text();

  const items: NewsItem[] = [];
  const cutoff = Date.now() - config.news.freshHours * 3600_000;
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1]!;
    const title = decode(pick(block, "title"));
    const link = pick(block, "link");
    const pubDate = pick(block, "pubDate");
    const source = decode(pick(block, "source"));
    if (!title || !link) continue;
    const t = Date.parse(pubDate);
    if (Number.isFinite(t) && t < cutoff) continue;
    items.push({ title, link, source: source || "unknown", pubDate });
    if (items.length >= config.news.headlinesPerCompany) break;
  }
  return items;
}

export function buildNewsHtml(ticker: string, companyName: string, items: NewsItem[]): string {
  const escFull = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return (
    `📰 <b>${escFull(ticker)}</b> — ${escFull(shortName(companyName))}\n` +
    items.map((i) => `• <a href="${escFull(i.link)}">${escFull(i.title)}</a> <i>(${escFull(i.source)})</i>`).join("\n") +
    `\n<i>Headlines are unverified news/rumors — not analysis, not advice.</i>`
  );
}

/** "SOLAREDGE TECHNOLOGIES, INC." → "Solaredge Technologies" for the query. */
function shortName(name: string): string {
  return name
    .replace(/,?\s*(inc|corp|corporation|ltd|plc|co|llc)\.?$/i, "")
    .replace(/[,.]/g, "")
    .trim();
}

function pick(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
  return m?.[1]?.trim() ?? "";
}

const decode = (s: string): string =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
