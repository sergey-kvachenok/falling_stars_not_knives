import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CACHE_DIR = new URL("../../.cache", import.meta.url).pathname;

export async function fetchJsonCached<T>(
  url: string,
  cacheKey: string,
  ttlHours: number,
  headers: Record<string, string>,
): Promise<T> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const path = join(CACHE_DIR, cacheKey);
  try {
    const age = Date.now() - statSync(path).mtimeMs;
    if (age < ttlHours * 3600_000) {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    }
  } catch {
    // no cache file yet
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  const body = await res.text();
  writeFileSync(path, body);
  return JSON.parse(body) as T;
}
