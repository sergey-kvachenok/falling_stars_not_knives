import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

const CACHE_DIR = new URL("../../.cache/edgar", import.meta.url).pathname;

// Shared token bucket across the whole process (PLAN.md §4.1). SEC's limit is
// 10 req/s hard; we run at 8. Serializing on a next-available-slot timestamp
// is enough because callers are sequential anyway.
let nextSlot = 0;
async function rateLimit(): Promise<void> {
  const interval = 1000 / config.edgar.requestsPerSecond;
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + interval;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

export interface EdgarGetOptions {
  cacheKey: string;
  /** Cache TTL in hours. Omit for immutable content (filings) — cached forever. */
  ttlHours?: number;
}

export async function edgarGet(url: string, opts: EdgarGetOptions): Promise<string> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const path = join(CACHE_DIR, opts.cacheKey.replace(/[^\w.-]/g, "_"));
  if (existsSync(path)) {
    const fresh =
      opts.ttlHours === undefined || Date.now() - statSync(path).mtimeMs < opts.ttlHours * 3600_000;
    if (fresh) return readFileSync(path, "utf8");
  }

  for (let attempt = 0; ; attempt++) {
    await rateLimit();
    const res = await fetch(url, {
      headers: { "User-Agent": config.edgar.userAgent, "Accept-Encoding": "gzip, deflate" },
    });
    if (res.ok) {
      const body = await res.text();
      writeFileSync(path, body);
      return body;
    }
    // 403 = bad User-Agent (trap #1) — retrying won't help and hammering risks a block.
    if (res.status === 403) {
      throw new Error(`EDGAR 403 for ${url} — check SEC_USER_AGENT has a name and email`);
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 2) {
      throw new Error(`EDGAR GET ${url} → ${res.status} ${res.statusText}`);
    }
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
}

export async function edgarGetJson<T>(url: string, opts: EdgarGetOptions): Promise<T> {
  return JSON.parse(await edgarGet(url, opts)) as T;
}

export const cik10 = (cik: number): string => String(cik).padStart(10, "0");
