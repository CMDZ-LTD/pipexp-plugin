// Restart on another model (CMD-80). A board click, by the owner of this machine's key only, asks this machine to end
// the run's turn and start a new run on the same ticket with a listed model. It is the riskiest thing the plugin
// does, so every piece is fixed here: off until the machine's owner allows it, a model from this list only, the same
// folder and the same sandbox or permission mode as the stopped session (refused when that cannot be read), a fixed
// prompt, and a process started from an args array with no shell. Nothing typed on the board reaches the command.
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, statSync } from "node:fs";
import { join } from "node:path";
import { home, readJson, writeJson } from "./config.mjs";
import { tail } from "./probe.mjs";

/** The models a run may restart on. The board holds the same list (agent-pipeline lib/steer.ts RESTART_MODELS). */
export const RESTART_MODELS = {
  codex: ["gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.5", "gpt-5.4"],
  claude: ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku"],
};

const settingsFile = () => join(home(), "settings.json");
/** Whether this machine's owner allowed Restart from the board. Off unless they ran pipexp allow restart. */
export const restartAllowed = () => readJson(settingsFile())?.restart === true;
export function setRestart(on) {
  writeJson(settingsFile(), { ...(readJson(settingsFile()) ?? {}), restart: !!on });
}

// The values each agent may be started with, as the stopped session ran: nothing else is ever passed on.
const CODEX_SANDBOX = new Set(["read-only", "workspace-write", "danger-full-access"]);
const CODEX_APPROVAL = new Set(["untrusted", "on-failure", "on-request", "never"]);
const CLAUDE_MODES = new Set(["default", "acceptEdits", "plan", "auto", "manual", "dontAsk", "bypassPermissions"]);

/**
 * The stopped session's own mode, from its transcript: Codex's last turn_context (sandbox and approval), Claude Code's
 * last permissionMode. Null when it cannot be read, and then the restart is refused.
 */
export function sessionMode(runtime, transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  const lines = tail(transcriptPath, 2 * 1024 * 1024).split("\n").reverse();
  for (const line of lines) {
    if (runtime === "codex" && line.includes('"turn_context"')) {
      try {
        const p = JSON.parse(line).payload ?? {};
        const sandbox = p.sandbox_policy?.type;
        return CODEX_SANDBOX.has(sandbox) && CODEX_APPROVAL.has(p.approval_policy) ? { sandbox, approval: p.approval_policy } : null;
      } catch {
        return null;
      }
    }
    if (runtime === "claude" && line.includes('"permissionMode"')) {
      const mode = line.match(/"permissionMode":"([A-Za-z]+)"/)?.[1];
      return CLAUDE_MODES.has(mode) ? { permission: mode } : null;
    }
  }
  return null;
}

/** The fixed prompt: the ticket key and the parent run id only. Never a note or anything else from the board. */
export const restartPrompt = (ticket, parentRunId) =>
  "Resume " + (ticket ?? "this task") + " where the last run stopped (PipeXP run " + parentRunId + "). Read the branch, the open PR and its review threads, then carry on.";

const TICKET = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/;
const RUN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Why this restart cannot run here ({ why }), or the command to run ({ file, args, cwd, env }).
 * session: the stopped session's state. steer: { kind: "restart", model }.
 */
export function restartPlan(session, steer) {
  if (!restartAllowed()) return { why: "Restart is off on this machine (pipexp allow restart turns it on)" };
  const runtime = session?.runtime;
  const models = RESTART_MODELS[runtime];
  if (!models) return { why: "Restart works for Codex and Claude Code sessions" };
  if (!models.includes(steer?.model)) return { why: "The board asked for a model not on this machine's list" };
  const cwd = session.cwd;
  if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) return { why: "The session's folder is gone" };
  if (session.ticket && !TICKET.test(session.ticket)) return { why: "The session's ticket is not a ticket key" };
  if (!RUN.test(session.runId ?? "")) return { why: "The session has no run id" };
  const mode = sessionMode(runtime, session.transcriptPath);
  if (!mode) return { why: "Could not read the stopped session's sandbox or permission mode, so it will not guess one" };
  const prompt = restartPrompt(session.ticket, session.runId);
  // The new session's first hook reads these: its card names this run as its parent, and the same ticket.
  const env = { ...process.env, PIPEXP_PARENT_RUN: session.runId, PIPEXP_TICKET: session.ticket ?? "" };
  if (runtime === "codex") {
    return { file: "codex", args: ["exec", "--model", steer.model, "--sandbox", mode.sandbox, "-c", "approval_policy=" + JSON.stringify(mode.approval), "--cd", cwd, prompt], cwd, env };
  }
  return { file: "claude", args: ["--print", "--model", steer.model, "--permission-mode", mode.permission, prompt], cwd, env };
}

/** Starts the planned process detached: no shell, output to a log file. Returns its pid, or null if it did not start. */
export function startRestart(plan, logPath, run = spawn) {
  let out;
  try {
    out = openSync(logPath, "a", 0o600);
    const child = run(plan.file, plan.args, { cwd: plan.cwd, env: plan.env, detached: true, shell: false, stdio: ["ignore", out, out] });
    child.on?.("error", () => {});
    child.unref?.();
    return child.pid ?? null;
  } catch {
    return null;
  } finally {
    if (out !== undefined) closeSync(out);
  }
}
