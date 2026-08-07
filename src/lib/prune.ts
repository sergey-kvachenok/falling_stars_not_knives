import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// Cache pruning (PLAN.md §6): EDGAR is the permanent document store — the
// local cache is disposable. Without pruning, companyfacts JSON (5–20MB per
// company) and raw filing HTML accumulate to 5–20GB/year. A file untouched
// for `maxAgeDays` belongs to a ticker that stopped recurring; if it ever
// comes back, re-fetching costs seconds. Never prune out/state or
// out/analyses — predictions and feedback are not re-derivable.

export function pruneCache(dir: string, maxAgeDays: number): { deleted: number; freedMb: number } {
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  let deleted = 0;
  let freedBytes = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { deleted: 0, freedMb: 0 };
  }
  for (const name of entries) {
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile() || st.mtimeMs >= cutoff) continue;
      freedBytes += st.size;
      unlinkSync(path);
      deleted++;
    } catch {
      // file vanished mid-walk — fine
    }
  }
  return { deleted, freedMb: Math.round(freedBytes / 1e6) };
}
