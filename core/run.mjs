// The glue every entry point shares: load a session's state, apply a hook or a report, queue the events, and
// start one detached flush. Nothing here waits on the network.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { credentials, machine, readJson, stateDir, writeJson } from "./config.mjs";
import * as probe from "./probe.mjs";
import { enqueue } from "./queue.mjs";
import { scrubEvent } from "./scrub.mjs";
import { onHook, onReport } from "./session.mjs";

const FLUSH = fileURLToPath(new URL("../bin/flush.mjs", import.meta.url));
const sessions = () => join(stateDir(), "sessions");
const safe = (id) => String(id).replace(/[^\w.-]/g, "_").slice(0, 120);
export const sessionFile = (id) => join(sessions(), safe(id) + ".json");
export const loadSession = (id) => readJson(sessionFile(id));
const settings = () => readJson(join(stateDir(), "..", "settings.json")) ?? {};

/** The runtime a hook runs under. Codex sets PLUGIN_ROOT; Claude Code sets only CLAUDE_PLUGIN_ROOT. */
export const runtimeOf = (env = process.env) => (env.PIPEXP_RUNTIME || (env.PLUGIN_ROOT || env.CODEX_THREAD_ID ? "codex" : "claude"));

export function context(runtime, transcriptPath, known, now = Date.now()) {
  return {
    now,
    runtime,
    machineId: machine().id,
    // Read once per session: the first line of a Codex transcript can be tens of KB.
    runtimeVersion: known ?? probe.runtimeVersion(runtime, transcriptPath),
    content: settings().content === "minimal" ? "minimal" : "standard",
    probe,
  };
}

/** Writes the events to the outbox (scrubbed) and saves the state. */
function commit(state, events) {
  mkdirSync(sessions(), { recursive: true, mode: 0o700 });
  writeJson(sessionFile(state.sessionId), state);
  if (events.length) enqueue(...events.map(scrubEvent));
  return events;
}

/** Starts a flush in its own process group, so it outlives a hook the harness kills. */
export function kick() {
  if (process.env.PIPEXP_NO_FLUSH) return;
  try {
    spawn(process.execPath, [FLUSH], { detached: true, stdio: "ignore", env: process.env }).unref();
  } catch {
    // The next hook tries again.
  }
}

/** One hook payload in, events queued out. Returns the events (tests read them). */
export function hook(input, runtime = runtimeOf()) {
  if (!input?.session_id) return [];
  const existing = loadSession(input.session_id);
  const ctx = context(existing?.runtime ?? runtime, input.transcript_path, existing?.runtimeVersion);
  const { state, events } = onHook(existing, input, ctx);
  commit(state, events);
  if (events.length && credentials()) kick();
  prune();
  return events;
}

/** An explicit report for a session (MCP tool, CLI). Starts the session's run when needed. */
export function report(sessionId, rep, runtime = runtimeOf(), cwd = process.cwd()) {
  const existing = loadSession(sessionId);
  const ctx = context(existing?.runtime ?? runtime, existing?.transcriptPath, existing?.runtimeVersion);
  const base = existing ?? onHook(null, { session_id: sessionId, cwd, hook_event_name: "none" }, ctx).state;
  const { state, events } = onReport(base, rep, ctx);
  commit(state, events);
  if (credentials()) kick();
  return { state, events };
}

/** The session this process belongs to: the harness's id when it gives one, else the most recent session in this folder. */
export function currentSession(cwd = process.cwd(), env = process.env) {
  const id = env.CODEX_THREAD_ID || env.CLAUDE_CODE_SESSION_ID || env.CODEX_SESSION_ID;
  if (id) return id;
  let best = null;
  try {
    for (const name of readdirSync(sessions())) {
      const s = readJson(join(sessions(), name));
      if (!s || s.finished || s.shipOwned) continue;
      if (s.cwd && cwd !== s.cwd && !cwd.startsWith(s.cwd + "/")) continue;
      if (!best || s.lastSeenAt > best.lastSeenAt) best = s;
    }
  } catch {}
  return best?.sessionId ?? null;
}

// ponytail: sessions untouched for 14 days are deleted on each hook; fine at a few hundred files.
function prune() {
  try {
    const cutoff = Date.now() - 14 * 86_400_000;
    for (const name of readdirSync(sessions())) {
      const path = join(sessions(), name);
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
    }
  } catch {}
}
