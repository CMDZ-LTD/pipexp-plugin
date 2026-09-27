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
import { queueAudit } from "./health.mjs";
import { scrubEvent } from "./scrub.mjs";
import { onHook, onIdle, onReport, PR_CMD, commandOf } from "./session.mjs";
import { markPrChecked, prDue } from "./pr.mjs";
import { boardContent, repoOf, routedRepo, startContext, supportsActivity } from "./stages.mjs";
import { markChecked, steerDue } from "./steer.mjs";
import { restartPlan, startRestart } from "./restart.mjs";

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

/**
 * How much this machine sends (CMD-343): minimal when either this machine (pipexp content minimal) or the project on the
 * board says so. The board's level comes from /plugin/config, cached per repo; a machine can go stricter, never looser.
 */
export const contentFor = (cwd) => (settings().content === "minimal" || (cwd && boardContent(cwd) === "minimal") ? "minimal" : "standard");

export function context(runtime, transcriptPath, known, now = Date.now(), cwd = null) {
  return {
    now,
    runtime,
    machineId: machine().id,
    // Read once per session: the first line of a Codex transcript can be tens of KB.
    runtimeVersion: known ?? probe.runtimeVersion(runtime, transcriptPath),
    content: contentFor(cwd),
    // Whether this folder's board takes activity (CMD-518): without it, no activity beat is made or counted.
    activity: supportsActivity(cwd),
    // Set by a restart for the new session it starts (core/restart.mjs).
    parentRunId: process.env.PIPEXP_PARENT_RUN || null,
    ticket: process.env.PIPEXP_TICKET || null,
    probe,
  };
}

/** Writes the events to the outbox (scrubbed) and saves the state. Events name the repo once the board knows it. */
function commit(state, events) {
  mkdirSync(sessions(), { recursive: true, mode: 0o700 });
  // Rechecked until known: the board learns the repo the first time pipexp_stages (or pipexp stages) reads it.
  if (!state.repo && state.cwd) state.repo = routedRepo(state.cwd);
  // Where the session runs (CMD-374): "repo" in a GitHub checkout, "none" elsewhere. The board never files an event
  // that says so on the key's own project, so a session outside every project's repo stays off every board.
  if (!state.origin && state.cwd) state.origin = repoOf(state.cwd) ? "repo" : "none";
  writeJson(sessionFile(state.sessionId), state);
  const enabled = supportsActivity(state.cwd);
  const minimal = contentFor(state.cwd) === "minimal";
  const where = (e) => {
    const out = { ...e, ...(state.repo && !e.repo && { repo: state.repo }), ...(state.origin && !e.origin && { origin: state.origin }) };
    if (minimal && out.activity) { const { note, ...activity } = out.activity; out.activity = activity; }
    if (!enabled) {
      delete out.sessionId;
      delete out.activity;
      if (out.type === "run.started") delete out.prNumber;
    }
    return out;
  };
  if (events.length) enqueue(...events.filter((e) => enabled || e.type !== "activity.reported").map((e) => scrubEvent(where(e))));
  return events;
}

/**
 * Starts a flush in its own process group, so it outlives a hook the harness kills. steerFor: also check that session's
 * steers. stagesCwd: also refresh that folder's lanes from the board (CMD-421), so the next session is told them.
 * prFor: also look up that session's PR (CMD-427).
 */
export function kick(steerFor, stagesCwd, prFor) {
  if (process.env.PIPEXP_NO_FLUSH) return;
  const env = { ...process.env, ...(steerFor && { PIPEXP_STEER_SESSION: steerFor }), ...(stagesCwd && { PIPEXP_STAGES_CWD: stagesCwd }), ...(prFor && { PIPEXP_PR_SESSION: prFor }) };
  try {
    spawn(process.execPath, [FLUSH], { detached: true, stdio: "ignore", env }).unref();
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
  let after = null;
  const events = withSessionLock(input.session_id, () => {
    const existing = loadSession(input.session_id);
    const ctx = context(existing?.runtime ?? runtime, input.transcript_path, existing?.runtimeVersion, Date.now(), input.cwd ?? existing?.cwd);
    const { state, events } = onHook(existing, input, ctx);
    after = state;
    return commit(state, events);
  });
  // Whether this session's PR should be looked up (by the flush, never here): a new branch, just after a push, or now
  // and then while its branch has no PR yet.
  const pushed = /^PostToolUse/.test(input.hook_event_name ?? "") && PR_CMD.test(commandOf(input.tool_input));
  const prFor = input.hook_event_name !== "PrFound" && after?.started && !after.shipOwned && credentials() && prDue(input.session_id, after.gitBranch, pushed) ? input.session_id : null;
  if (prFor) markPrChecked(prFor, after.gitBranch);
  // A new session is when a fixed fault shows: the audit goes now if trust changed or the last one showed a fault.
  if (input.hook_event_name === "SessionStart" && credentials()) queueAudit();
  // A live session asks the board for steers every CHECK_MS, through the detached flush, never in this hook.
  const steer = credentials() && steerDue(input.session_id) ? input.session_id : null;
  if (steer) markChecked(steer);
  // A session starting where the cached lanes are old or missing: the flush reads them again (CMD-421).
  const stagesCwd = input.hook_event_name === "SessionStart" && input.cwd && startContext(input.cwd).stale ? input.cwd : null;
  if ((events.length || steer || stagesCwd || prFor) && credentials()) kick(steer ?? undefined, stagesCwd ?? undefined, prFor ?? undefined);
  prune();
  return events;
}

/** An explicit report for a session (MCP tool, CLI). Starts the session's run when needed. */
export function report(sessionId, rep, runtime = runtimeOf(), cwd) {
  const { state, events } = withSessionLock(sessionId, () => {
    const existing = loadSession(sessionId);
    const folder = cwd ?? existing?.cwd ?? process.cwd();
    if (existing && cwd && repoOf(existing.cwd)?.toLowerCase() !== repoOf(cwd)?.toLowerCase()) {
      throw new Error("This session belongs to another repository. Start a session in the new project instead.");
    }
    const ctx = context(existing?.runtime ?? runtime, existing?.transcriptPath, existing?.runtimeVersion, Date.now(), folder);
    // No hook has seen this session yet (hooks not trusted, or a report before the first prompt): start it here.
    const base = existing ?? onHook(null, { session_id: sessionId, cwd: folder, hook_event_name: "none" }, ctx).state;
    if (cwd) { base.cwd = cwd; base.reportingCwd = cwd; }
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
export const currentSession = (cwd = process.cwd(), env = process.env) => findSession(cwd, env).id;

/**
 * currentSession, with why it found none. An agent often works in a git worktree its session did not start in
 * (CMD-370): then the one session seen in another worktree of the same repo (same git common dir) is it. With
 * several there, it could be another agent's card, so none is picked and the caller is told to pass session_id.
 */
export function findSession(cwd = process.cwd(), env = process.env, git = probe.git) {
  // The harness this process runs in names the session; a Codex thread id can leak into a Claude Code shell.
  const id = runtimeOf(env, []) === "claude" ? env.CLAUDE_CODE_SESSION_ID : env.CODEX_THREAD_ID || env.CODEX_SESSION_ID;
  if (id) return { id, via: "env" };
  const here = real(cwd);
  let best = null;
  const all = [];
  try {
    for (const name of readdirSync(sessions())) {
      if (!name.endsWith(".json")) continue;
      const s = readJson(join(sessions(), name));
      if (!s?.cwd) continue;
      all.push(s);
      const root = real(s.cwd);
      if (here !== root && !here.startsWith(root + "/")) continue;
      // The deepest matching folder wins (a session in the repo beats one in a parent), then the most recent.
      const depth = root.length;
      if (!best || depth > best.depth || (depth === best.depth && s.lastSeenAt > best.s.lastSeenAt)) best = { s, depth };
    }
  } catch {}
  if (best) return { id: best.s.sessionId, via: "folder" };
  const common = git(here)?.common;
  if (!common) return { id: null, why: "none" };
  // One git call per distinct folder, not per session file.
  const commons = new Map();
  const commonOf = (dir) => (commons.has(dir) ? commons.get(dir) : commons.set(dir, git(dir)?.common ?? null).get(dir));
  const same = [...new Set(all.filter((s) => commonOf(real(s.cwd)) === common).map((s) => s.sessionId))];
  if (same.length === 1) return { id: same[0], via: "worktree" };
  return { id: null, why: same.length ? "several" : "none" };
}

/**
 * Moves every session no hook has heard from for a while to Waiting for you (session.mjs onIdle). The flush runs it,
 * so a closed Codex thread's card leaves Build or Test within a flush of the next hook on this machine.
 */
export function sweepIdle(now = Date.now()) {
  let moved = 0;
  try {
    for (const name of readdirSync(sessions())) {
      if (!name.endsWith(".json")) continue;
      const id = readJson(join(sessions(), name))?.sessionId;
      if (!id) continue;
      moved += withSessionLock(id, () => {
        const { state, events } = onIdle(loadSession(id), now);
        if (!events.length) return 0;
        commit(state, events);
        return 1;
      });
    }
  } catch {}
  return moved;
}

/**
 * Carries out a restart the board sent for this session (CMD-80), from the steers the flush just fetched: the same
 * steer also sits in the inbox for the hook to end the turn with, and the new run starts here, once per steer id. Refused ones are logged on the old run as a snag, so the
 * card says why nothing started.
 */
export function carryOutRestarts(sessionId, steers, start = startRestart) {
  const s = loadSession(sessionId);
  if (!s || !Array.isArray(steers)) return 0;
  const done = new Set(s.restarted ?? []);
  let started = 0;
  for (const steer of steers.filter((w) => w.kind === "restart")) {
    // One run per steer: by its id (an older board sends none: then model and message).
    const key = steer.steerId ?? steer.model + "|" + steer.message;
    if (done.has(key)) continue;
    done.add(key);
    const plan = restartPlan(s, steer);
    const pid = plan.why ? null : start(plan, join(stateDir(), "restart-" + s.runId + ".log"));
    const why = plan.why ?? (pid ? null : "the " + plan.file + " command could not be started on this machine");
    report(sessionId, { type: "snag.reported", fields: { kind: why ? "snag" : "worked", theme: "restart", what: why ? "Restart on " + steer.model + " refused: " + why : "Restarted on " + steer.model + " in the same folder and mode", costMin: null } }, s.runtime, s.cwd);
    if (!why) started++;
  }
  withSessionLock(sessionId, () => {
    const now = loadSession(sessionId);
    if (now) writeJson(sessionFile(sessionId), { ...now, restarted: [...done].slice(-20) });
  });
  return started;
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
