// Steers from the board (CMD-80): a note for the agent's next step, or a stop that ends its turn. The detached flush
// fetches them (GET /steer on the run's machine key) into a small inbox per session; the next hook, which must answer
// in milliseconds, only reads that inbox and prints it in the agent's own hook format. Never blocks, never throws.
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./config.mjs";
import { call } from "./send.mjs";

const inbox = () => join(stateDir(), "steers");
const safe = (id) => String(id).replace(/[^\w.-]/g, "_").slice(0, 120);
const fileOf = (sessionId) => join(inbox(), safe(sessionId) + ".json");

/** Asks the board for this run's waiting steers and adds them to the session's inbox. Quietly does nothing on failure. */
export async function fetchSteers(creds, session) {
  if (!session?.runId || session.shipOwned || session.finished) return 0;
  let res;
  try {
    const q = "?runId=" + encodeURIComponent(session.runId) + (session.repo ? "&repo=" + encodeURIComponent(session.repo) : "");
    res = await call(creds, "/steer" + q, { method: "GET" }, 4000);
  } catch {
    return 0;
  }
  const got = Array.isArray(res?.body?.steers) ? res.body.steers.filter((s) => (s.kind === "note" || s.kind === "stop") && typeof s.message === "string") : [];
  if (!got.length) return 0;
  try {
    mkdirSync(inbox(), { recursive: true, mode: 0o700 });
    const file = fileOf(session.sessionId);
    let waiting = [];
    try {
      waiting = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
    const tmp = file + "." + process.pid + ".tmp";
    writeFileSync(tmp, JSON.stringify([...waiting, ...got].slice(-10)), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {}
  return got.length;
}

/** Takes the session's waiting steers out of its inbox: each is shown once. */
export function takeSteers(sessionId) {
  const file = fileOf(sessionId);
  const mine = file + "." + process.pid + ".taking";
  try {
    // Renamed first, so a flush writing meanwhile starts a new inbox instead of losing to this read.
    renameSync(file, mine);
  } catch {
    return [];
  }
  try {
    const steers = JSON.parse(readFileSync(mine, "utf8"));
    return Array.isArray(steers) ? steers : [];
  } catch {
    return [];
  } finally {
    try {
      unlinkSync(mine);
    } catch {}
  }
}

// How often a busy session asks the board for steers: at most every 30 seconds, from the detached flush.
export const CHECK_MS = 30_000;
const checkedFile = (sessionId) => fileOf(sessionId) + ".checked";

/** Whether this session is due a steer check. Only reads a file's time, so a hook stays fast. */
export function steerDue(sessionId, now = Date.now()) {
  try {
    return now - statSync(checkedFile(sessionId)).mtimeMs >= CHECK_MS;
  } catch {
    return true;
  }
}

/** Notes the check, so the next hooks within CHECK_MS do not start another flush for it. */
export function markChecked(sessionId, now = Date.now()) {
  try {
    mkdirSync(inbox(), { recursive: true, mode: 0o700 });
    const f = checkedFile(sessionId);
    try {
      utimesSync(f, now / 1000, now / 1000);
    } catch {
      writeFileSync(f, "", { mode: 0o600 });
    }
  } catch {}
}

// Events whose output an agent reads as context for what it does next.
const CONTEXT_EVENTS = new Set(["UserPromptSubmit", "PostToolUse", "PostToolUseFailure"]);

/**
 * What a hook prints so the agent sees the steers. Codex and Claude Code: additionalContext for a note, and for a stop
 * continue:false with the reason (it ends the turn), plus the same words as context. Cursor and Gemini: context only.
 * Empty when there is nothing to say, or the event cannot carry it.
 */
export function steerOutput(runtime, event, steers) {
  if (!steers.length || !CONTEXT_EVENTS.has(event)) return "";
  const text = steers.map((s) => s.message).join("\n");
  const stop = steers.find((s) => s.kind === "stop");
  if (runtime === "cursor") return JSON.stringify({ additional_context: text });
  const out = { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
  return JSON.stringify(stop && (runtime === "codex" || runtime === "claude") ? { continue: false, stopReason: stop.message, ...out } : out);
}
