import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Small JSON state files under out/state/ — the file-backed stand-in for
// Postgres until Phase 3. Everything here must stay small (cooldown map,
// telegram offset, feedback log), so the actions/cache round-trip is cheap.

const STATE_DIR = new URL("../../out/state", import.meta.url).pathname;

export function readState<T>(name: string, fallback: T): T {
  const path = `${STATE_DIR}/${name}.json`;
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeState(name: string, value: unknown): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(`${STATE_DIR}/${name}.json`, JSON.stringify(value, null, 2));
}
