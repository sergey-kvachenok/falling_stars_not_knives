import { readFileSync } from "node:fs";

// Minimal .env loader — avoids a dotenv dependency. Values already set in the
// environment (e.g. GitHub Actions secrets) take precedence over the file.
try {
  const lines = readFileSync(new URL("../../.env", import.meta.url), "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || !m[1] || process.env[m[1]] !== undefined) continue;
    let value = m[2]!.trim();
    // Strip one layer of matching quotes — both '…' and "…" are common.
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0]!)) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] = value;
  }
} catch {
  // no .env file — fine in CI, where secrets come from the environment
}
