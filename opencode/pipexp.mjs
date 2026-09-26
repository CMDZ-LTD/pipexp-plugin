// PipeXP for OpenCode: reports each session to your PipeXP board. OpenCode has no shell hooks, so this plugin turns
// its events into the same hook payloads Codex and Claude Code send and hands each one to the shared launcher,
// detached. It never waits on the launcher and never throws into OpenCode.
// Install: add the path of this file (or the package) to "plugin" in opencode.json, or copy it to
// ~/.config/opencode/plugins/. See the plugin README.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCHER = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "pipexp-hook.mjs");

// OpenCode fires events back to back (a tool call, then the turn ending). Each launcher run reads and writes the
// session's state file, so two at once would overwrite each other: they go one after another, never in parallel.
// OpenCode never waits for them: the chain runs in the background, and one that hangs is dropped after 5 s.
let chain = Promise.resolve();

/** Hands one payload to the launcher. "node", not process.execPath: OpenCode may run on Bun. */
export function send(payload, spawnFn = spawn) {
  chain = chain.then(() => new Promise((done) => {
    try {
      const child = spawnFn("node", [LAUNCHER, "--runtime", "opencode"], { stdio: ["pipe", "ignore", "ignore"] });
      const timer = setTimeout(() => {
        child.kill?.();
        done();
      }, 5000);
      timer.unref?.();
      child.on?.("error", () => {
        clearTimeout(timer);
        done();
      });
      child.on?.("exit", () => {
        clearTimeout(timer);
        done();
      });
      child.stdin.on?.("error", () => {});
      child.stdin.end(JSON.stringify(payload));
    } catch {
      // Telemetry never gets in OpenCode's way.
      done();
    }
  }));
  return chain;
}

/** OpenCode's events, as the payloads the launcher reads. Exported for tests. */
export function makeHandlers({ directory } = {}, emit = send) {
  const sessions = new Map(); // id -> { cwd, started, tokens }
  // OpenCode has no transcript file: its assistant messages carry tokens, so the session's total is summed here.
  // A message is updated many times while it streams, so each id keeps only its latest count.
  const totals = (id) => {
    const all = Object.values(sessions.get(id)?.messages ?? {});
    const sum = (f) => all.reduce((n, m) => n + (Number(f(m.tokens)) || 0), 0);
    return {
      model: all.at(-1)?.model ?? null,
      input: sum((t) => (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)),
      cachedInput: sum((t) => t.cache?.read ?? 0),
      output: sum((t) => t.output ?? 0),
      reasoning: sum((t) => t.reasoning ?? 0),
    };
  };
  const cwdOf = (id) => sessions.get(id)?.cwd ?? directory ?? process.cwd();
  const base = (id, name, extra = {}) => ({ session_id: id, cwd: cwdOf(id), transcript_path: null, hook_event_name: name, ...extra });
  const start = (id, cwd) => {
    const s = sessions.get(id) ?? { cwd: cwd ?? directory, started: false };
    if (cwd) s.cwd = cwd;
    sessions.set(id, s);
    if (!s.started) {
      s.started = true;
      emit(base(id, "SessionStart", { source: "startup" }));
    }
    return s;
  };
  return {
    event: async ({ event }) => {
      const p = event?.properties ?? {};
      if (event?.type === "session.created" && p.info?.id && !p.info.parentID) start(p.info.id, p.info.directory);
      else if (event?.type === "session.idle" && p.sessionID && sessions.has(p.sessionID)) emit(base(p.sessionID, "Stop", { pipexp_usage: totals(p.sessionID) }));
      else if (event?.type === "session.deleted" && p.info?.id && sessions.has(p.info.id)) {
        emit(base(p.info.id, "SessionEnd", { reason: "deleted", pipexp_usage: totals(p.info.id) }));
        sessions.delete(p.info.id);
      } else if (event?.type === "message.part.updated" && p.part?.type === "tool" && p.part.state?.status === "error" && p.part.sessionID) {
        emit(base(p.part.sessionID, "PostToolUseFailure", { tool_name: p.part.tool, tool_input: p.part.state.input ?? {}, error: p.part.state.error }));
      } else if (event?.type === "message.updated" && p.info?.role === "assistant" && p.info.sessionID && p.info.tokens) {
        // Tokens per assistant message: kept as a running total and sent with the end of the turn.
        const s = sessions.get(p.info.sessionID);
        if (s) (s.messages ??= {})[p.info.id] = { model: p.info.modelID, tokens: p.info.tokens };
      }
    },
    "chat.message": async (input) => {
      if (!input?.sessionID) return;
      start(input.sessionID);
      emit(base(input.sessionID, "UserPromptSubmit"));
    },
    "tool.execute.after": async (input, output) => {
      if (!input?.sessionID) return;
      start(input.sessionID);
      const args = input.args ?? {};
      if (args.workdir) sessions.get(input.sessionID).cwd = args.workdir;
      emit(base(input.sessionID, "PostToolUse", {
        tool_name: input.tool,
        tool_input: args,
        tool_response: { exit: output?.metadata?.exit ?? null, output: typeof output?.output === "string" ? output.output.slice(0, 2000) : "" },
      }));
    },
  };
}

export const PipeXP = async (ctx) => makeHandlers(ctx);
export default PipeXP;
