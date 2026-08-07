import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

// Cloud persistence (Phase 3, PLAN.md §6): out/state/*.json holds the
// IRREPLACEABLE data — predictions, feedback, cooldown, telegram offset. In
// CI the runner is stateless and actions/cache is evictable, so the state
// syncs with a single Postgres key-value table around each run:
//   pullState() at start  — DB is the source of truth when DATABASE_URL is set
//   pushState() at end    — upload every state file
// Without DATABASE_URL both are no-ops and the file layer stands alone
// (local development). Filing caches and analyses stay on disk/actions-cache:
// they are re-derivable, state is not.

const STATE_DIR = new URL("../../out/state", import.meta.url).pathname;

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return postgres(url, { max: 1, connect_timeout: 20 });
}

export async function pullState(): Promise<boolean> {
  const sql = db();
  if (!sql) return false;
  try {
    await sql`CREATE TABLE IF NOT EXISTS state_kv (
      name text PRIMARY KEY,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
    const rows = await sql<{ name: string; value: unknown }[]>`SELECT name, value FROM state_kv`;
    mkdirSync(STATE_DIR, { recursive: true });
    for (const row of rows) {
      writeFileSync(join(STATE_DIR, `${row.name}.json`), JSON.stringify(row.value, null, 2));
    }
    console.log(`State: pulled ${rows.length} object(s) from Postgres.`);
    return true;
  } finally {
    await sql.end();
  }
}

export async function pushState(): Promise<boolean> {
  const sql = db();
  if (!sql) return false;
  try {
    if (!existsSync(STATE_DIR)) return true;
    const files = readdirSync(STATE_DIR).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const name = f.replace(/\.json$/, "");
      const value = JSON.parse(readFileSync(join(STATE_DIR, f), "utf8"));
      await sql`INSERT INTO state_kv (name, value, updated_at) VALUES (${name}, ${sql.json(value)}, now())
                ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    }
    console.log(`State: pushed ${files.length} object(s) to Postgres.`);
    return true;
  } finally {
    await sql.end();
  }
}
