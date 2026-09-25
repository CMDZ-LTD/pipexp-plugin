// Where pipexp keeps its files and how it finds its key. Everything lives under ~/.config/pipexp
// (PIPEXP_HOME overrides it), so Codex, Claude Code and the MCP server on one machine share one connection.
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform, release } from "node:os";
import { join } from "node:path";

export const VERSION = "0.1.0";
// PIPEXP_HOME moves everything (tests). Codex starts MCP servers with a bare environment, so the MCP server
// always uses the default folder: keep real connections in credentials.json, not in env.
export const home = () => process.env.PIPEXP_HOME || join(homedir(), ".config", "pipexp");
export const stateDir = () => join(home(), "state");

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Writes through a temp file and rename, so a reader never sees half a file. */
export function writeJson(path, value, mode = 0o600) {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const tmp = path + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
  renameSync(tmp, path);
  chmodSync(path, mode);
}

/** A key from the old /setup page: ~/.config/nudj/telemetry.env, "export NAME=value" lines. */
function legacy() {
  try {
    const text = readFileSync(join(homedir(), ".config", "nudj", "telemetry.env"), "utf8");
    const get = (name) => text.match(new RegExp("^(?:export\\s+)?" + name + "=[\"']?([^\"'\\s]+)", "m"))?.[1];
    const url = get("NUDJ_TELEMETRY_URL");
    const key = get("NUDJ_TELEMETRY_TOKEN");
    return url && key ? { url, key, source: "legacy" } : null;
  } catch {
    return null;
  }
}

/** The ingest URL and key: env (CI), then credentials.json (connect), then the legacy file. Null when not connected. */
export function credentials() {
  if (process.env.PIPEXP_URL && process.env.PIPEXP_KEY) return { url: process.env.PIPEXP_URL, key: process.env.PIPEXP_KEY, source: "env" };
  const saved = readJson(join(home(), "credentials.json"));
  if (saved?.url && saved?.key) return { ...saved, source: "file" };
  return legacy();
}

export const saveCredentials = (value) => writeJson(join(home(), "credentials.json"), value);

/** This machine's id and name, made once. Reuses the id the Nudj ship skill already made, so the board keeps one machine. */
export function machine() {
  const path = join(home(), "machine.json");
  const mine = readJson(path);
  if (mine?.id) return mine;
  const old = readJson(join(homedir(), ".config", "nudj", "machine.json"));
  const made = {
    id: old?.id ?? randomUUID(),
    name: old?.name ?? (process.env.PIPEXP_MACHINE_NAME || hostname().replace(/\.(local|lan)$/i, "")),
    createdAt: new Date().toISOString(),
  };
  try {
    writeJson(path, made);
  } catch {
    // Read-only home: use it for this process only.
  }
  return made;
}

export const osName = () => (platform() === "darwin" ? "macOS" : platform()) + " " + release();

/** True under a test runner: then nothing goes anywhere but localhost, whatever the shell exports. */
export const underTest = () => ["PIPEXP_TEST", "NODE_TEST_CONTEXT", "VITEST", "PYTEST_CURRENT_TEST"].some((k) => process.env[k]);

export const exists = existsSync;
