import { readFileSync } from "node:fs";

// Minimal .env loader — avoids a dotenv dependency. Values already set in the
// environment (e.g. GitHub Actions secrets) take precedence over the file.
try {
  const lines = readFileSync(new URL("../../.env", import.meta.url), "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?\s*$/);
    if (m && m[1] && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2]!.trim();
    }
  }
} catch {
  // no .env file — fine in CI, where secrets come from the environment
}
