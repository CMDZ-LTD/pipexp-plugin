// The glue every entry point shares: load a session's state, apply a hook or a report, queue the events, and
// start one detached flush. Nothing here waits on the network.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { credentials, machine, readJson, stateDir, writeJson } from "./config.mjs";
import { RUNTIMES } from "./adapt.mjs";
import * as probe from "./probe.mjs";
import { enqueue } from "./queue.mjs";
import { scrubEvent } from "./scrub.mjs";
import { onHook, onReport } from "./session.mjs";
import { routedRepo } from "./stages.mjs";

const FLUSH = fileURLToPath(new URL("../bin/flush.mjs", import.meta.url));
const sessions = () => join(stateDir(), "sessions");
const safe = (id) => String(id).replace(/[^\w.-]/g, "_").slice(0, 120);
export const sessionFile = (id) => join(sessions(), safe(id) + ".json");
export const loadSession = (id) => readJson(sessionFile(id));
const settings = () => readJson(join(stateDir(), "..", "settings.json")) ?? {};

/**
 * The runtime a hook runs under. Both harnesses load the same hooks/hooks.json, so the process tells them apart.
 * Plugin roots decide first: Codex sets PLUGIN_ROOT, Claude Code only CLAUDE_PLUGIN_ROOT. Then Claude's own markers
 * (CLAUDE_CODE_SESSION_ID, CLAUDECODE) beat CODEX_THREAD_ID, which leaks into a Claude started from a Codex
 * terminal. --runtime or PIPEXP_RUNTIME override it (tests, scripts).
 */
export const runtimeOf = (env = process.env, argv = process.argv) => {
  const flag = argv.indexOf("--runtime");
  const given = flag >= 0 ? argv[flag + 1] : env.PIPEXP_RUNTIME;
  if (RUNTIMES.includes(given)) return given;
  if (env.PLUGIN_ROOT) return "codex";
  // Cursor also runs Claude-format hooks from ~/.claude and sets CLAUDE_PLUGIN_ROOT for them: it wins over Claude.
  if (env.CURSOR_VERSION || env.CURSOR_PROJECT_DIR) return "cursor";
  if (env.GEMINI_SESSION_ID || env.GEMINI_PROJECT_DIR) return "gemini";
  if (env.CLAUDE_PLUGIN_ROOT || env.CLAUDE_CODE_SESSION_ID || env.CLAUDECODE) return "claude";
  return "codex";
};

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

/** Writes the events to the outbox (scrubbed) and saves the state. Events name the repo once the board knows it. */
function commit(state, events) {
  mkdirSync(sessions(), { recursive: true, mode: 0o700 });
  // Rechecked until known: the board learns the repo the first time pipexp_stages (or pipexp stages) reads it.
  if (!state.repo && state.cwd) state.repo = routedRepo(state.cwd);
  writeJson(sessionFile(state.sessionId), state);
  if (events.length) enqueue(...events.map((e) => scrubEvent(state.repo && !e.repo ? { ...e, repo: state.repo } : e)));
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

/**
 * One process at a time per session: agents fire hooks back to back (a tool call, then the turn ending), each in
 * its own process, and each reads, changes and saves the session's state. Without this, a later write can undo an
 * earlier one. Waits at most ~1 s; a lock older than 10 s belongs to a crashed hook and is taken over.
 */
function withSessionLock(id, fn) {
  mkdirSync(sessions(), { recursive: true, mode: 0o700 });
  const lock = sessionFile(id) + ".lock";
  let held = false;
  for (let i = 0; i < 100 && !held; i++) {
    try {
      closeSync(openSync(lock, "wx"));
      held = true;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) unlinkSync(lock);
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        unlinkSync(lock);
      } catch {}
    }
  }
}

/** One hook payload in, events queued out. Returns the events (tests read them). */
export function hook(input, runtime = runtimeOf()) {
  if (!input?.session_id) return [];
  const events = withSessionLock(input.session_id, () => {
    const existing = loadSession(input.session_id);
    const ctx = context(existing?.runtime ?? runtime, input.transcript_path, existing?.runtimeVersion);
    const { state, events } = onHook(existing, input, ctx);
    return commit(state, events);
  });
  if (events.length && credentials()) kick();
  prune();
  return events;
}

/** An explicit report for a session (MCP tool, CLI). Starts the session's run when needed. */
export function report(sessionId, rep, runtime = runtimeOf(), cwd = process.cwd()) {
  const { state, events } = withSessionLock(sessionId, () => {
    const existing = loadSession(sessionId);
    const ctx = context(existing?.runtime ?? runtime, existing?.transcriptPath, existing?.runtimeVersion);
    // No hook has seen this session yet (hooks not trusted, or a report before the first prompt): start it here.
    const base = existing ?? onHook(null, { session_id: sessionId, cwd: cwd || process.cwd(), hook_event_name: "none" }, ctx).state;
    const result = onReport(base, rep, ctx);
    commit(result.state, result.events);
    return result;
  });
  if (credentials()) kick();
  return { state, events };
}

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * The session a report belongs to: the harness's id when it gives one, else the session most recently seen in
 * this folder (or a parent of it). Folders are compared by real path: macOS /tmp is /private/tmp. A finished
 * session still counts, so a report after the turn ended lands on the same card and brings it back.
 */
export function currentSession(cwd = process.cwd(), env = process.env) {
  // The harness this process runs in names the session; a Codex thread id can leak into a Claude Code shell.
  const id = runtimeOf(env, []) === "claude" ? env.CLAUDE_CODE_SESSION_ID : env.CODEX_THREAD_ID || env.CODEX_SESSION_ID;
  if (id) return id;
  const here = real(cwd);
  let best = null;
  try {
    for (const name of readdirSync(sessions())) {
      const s = readJson(join(sessions(), name));
      if (!s?.cwd) continue;
      const root = real(s.cwd);
      if (here !== root && !here.startsWith(root + "/")) continue;
      // The deepest matching folder wins (a session in the repo beats one in a parent), then the most recent.
      const depth = root.length;
      if (!best || depth > best.depth || (depth === best.depth && s.lastSeenAt > best.s.lastSeenAt)) best = { s, depth };
    }
  } catch {}
  return best?.s.sessionId ?? null;
}

// ponytail: sessions untouched for 14 days are deleted on each hook; fine at a few hundred files.
function prune() {
  try {
    const cutoff = Date.now() - 14 * 86_400_000;
    for (const name of readdirSync(sessions())) {
      if (name.endsWith(".lock")) continue;
      const path = join(sessions(), name);
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
    }
  } catch {}
}
