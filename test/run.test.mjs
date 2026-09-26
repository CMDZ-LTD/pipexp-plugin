import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { freshHome } from "./helpers.mjs";

freshHome();
process.env.PIPEXP_RUNTIME = "codex";
const { currentSession, hook, loadSession, report } = await import("../core/run.mjs");

test("an MCP report finds the session by folder, through a symlinked path, and after the turn ended", () => {
  const real = mkdtempSync(join(tmpdir(), "pipexp-cwd-"));
  mkdirSync(join(real, "src"));
  const link = real + "-link";
  symlinkSync(real, link);
  hook({ session_id: "s-old", cwd: real, hook_event_name: "UserPromptSubmit" });
  hook({ session_id: "s-new", cwd: real, hook_event_name: "UserPromptSubmit" });
  hook({ session_id: "s-new", cwd: real, hook_event_name: "SessionEnd", reason: "other" });
  hook({ session_id: "s-elsewhere", cwd: tmpdir(), hook_event_name: "UserPromptSubmit" });
  assert.equal(currentSession(join(link, "src"), {}), "s-new");
  assert.equal(currentSession(real, { CODEX_THREAD_ID: "given" }), "given");
  assert.equal(currentSession(real, { CODEX_THREAD_ID: "leaked", CLAUDE_CODE_SESSION_ID: "claude-s", CLAUDECODE: "1" }), "claude-s");
  const { events } = report("s-new", { type: "snag.reported", fields: { kind: "snag", theme: "t", what: "w", costMin: null } });
  assert.deepEqual(events.map((e) => e.type), ["run.started", "step.entered", "snag.reported"], "a finished card comes back before the snag lands");
  assert.equal(loadSession("s-new").finished, false);
});

test("a hook with no session id does nothing", () => {
  assert.deepEqual(hook({ hook_event_name: "Stop" }), []);
});

test("hooks fired at the same moment in separate processes never undo each other's state (OpenCode, Cursor)", async () => {
  const { spawn } = await import("node:child_process");
  const { readdirSync, readFileSync } = await import("node:fs");
  const launcher = new URL("../hooks/pipexp-hook.mjs", import.meta.url).pathname;
  const run = (payload) =>
    new Promise((done) => {
      const child = spawn(process.execPath, [launcher, "--runtime", "opencode"], { env: { ...process.env }, stdio: ["pipe", "ignore", "ignore"] });
      child.on("exit", done);
      child.stdin.end(JSON.stringify(payload));
    });
  const base = { session_id: "race-1", cwd: "/repo" };
  await run({ ...base, hook_event_name: "UserPromptSubmit" });
  // Twelve edits and test runs at once, then the end of the turn.
  await Promise.all(Array.from({ length: 12 }, (_, i) => run({ ...base, hook_event_name: "PostToolUse", tool_name: i % 2 ? "edit" : "bash", tool_input: { command: "npm test" } })));
  await run({ ...base, hook_event_name: "Stop" });
  const dir = join(process.env.PIPEXP_HOME, "state", "outbox");
  const events = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")).event).filter((e) => e.runId && e.type === "run.started");
  assert.equal(events.filter((e) => e.runtime === "opencode").length, 1, "one run.started: every process saw the state the one before it saved");
  assert.equal(loadSession("race-1").stage, "agent:S5");
  assert.ok(!readdirSync(join(process.env.PIPEXP_HOME, "state", "sessions")).some((f) => f.endsWith(".lock")), "no lock left behind");
});
