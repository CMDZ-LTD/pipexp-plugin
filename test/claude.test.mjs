// Claude Code: the same hooks and events as Codex, from Claude's own hook payloads and transcripts.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ctx, probe } from "./helpers.mjs";
import { onHook } from "../core/session.mjs";
import { runtimeVersion, sessionStart, threadName } from "../core/probe.mjs";
import { runtimeOf } from "../core/run.mjs";
import { usage } from "../core/usage.mjs";

const T0 = Date.parse("2026-09-24T09:00:00Z");
const MIN = 60_000;
const SID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FIX = new URL("./fixtures/claude/projects/-fixture-repo/", import.meta.url).pathname;
const TRANSCRIPT = join(FIX, SID + ".jsonl");
// Shapes from code.claude.com/docs/en/hooks: no turn_id, a model only on SessionStart, prompt_id and effort.
const base = { session_id: SID, transcript_path: TRANSCRIPT, cwd: "/repo", permission_mode: "default", prompt_id: "550e8400-e29b-41d4-a716-446655440000" };
const claude = (over = {}) => ctx(0, { runtime: "claude", runtimeVersion: "claude 2.1.270", ...over });

function play(steps) {
  let state = null;
  const events = [];
  for (const [min, hook] of steps) {
    const r = onHook(state, { ...base, ...hook }, { ...claude(), now: T0 + min * MIN });
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
}
const brief = (events) => events.map((e) => e.type + (e.stage ? " " + e.stage : ""));

test("a Claude Code session moves across the same lanes as Codex, as runtime claude", () => {
  const { events } = play([
    [0, { hook_event_name: "SessionStart", source: "startup", model: "claude-opus-5-5" }],
    [0, { hook_event_name: "UserPromptSubmit", prompt: "fix login" }],
    [2, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" }, tool_response: { type: "update" }, effort: { level: "high" } }],
    [4, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test", description: "Run tests" }, tool_response: { stdout: "ok", stderr: "", interrupted: false } }],
    [6, { hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Done", background_tasks: [] }],
    [30, { hook_event_name: "SessionEnd", reason: "prompt_input_exit" }],
  ]);
  assert.deepEqual(brief(events), [
    "run.started", "step.entered agent:S1", "usage.reported agent:S1", "step.entered agent:S2",
    "usage.reported agent:S2", "step.entered agent:S3", "usage.reported agent:S3", "step.entered agent:S5", "run.finished",
  ]);
  assert.ok(events.every((e) => e.runtime === "claude"));
  assert.equal(events[0].runtimeVersion, "claude 2.1.270");
  assert.equal(events.at(-1).outcome, "ready");
  assert.equal(events.find((e) => e.type === "usage.reported")._usage.transcriptPath, TRANSCRIPT);
});

test("the Claude version, written to the transcript after the first prompt, reaches the card at the end of the turn", () => {
  let known;
  const c = (now) => ({ ...claude({ runtimeVersion: undefined, probe: probe({ runtimeVersion: () => known }) }), now });
  const start = onHook(null, { ...base, hook_event_name: "SessionStart", source: "startup" }, c(T0));
  assert.equal(start.events[0].runtimeVersion, undefined);
  known = "claude 2.1.271";
  const stop = onHook(start.state, { ...base, hook_event_name: "Stop" }, c(T0 + MIN));
  const resent = stop.events.find((e) => e.type === "run.started");
  assert.equal(resent?.runtimeVersion, "claude 2.1.271");
  assert.equal(resent.claim, "resume");
  const again = onHook(stop.state, { ...base, hook_event_name: "Stop" }, c(T0 + 2 * MIN));
  assert.ok(!again.events.some((e) => e.type === "run.started"), "sent once");
});

test("a failed tool call arrives as PostToolUseFailure: it moves the card and counts toward a snag", () => {
  const fail = { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "pnpm test" }, error: "Exit code 1", is_interrupt: false };
  const { events } = play([[0, { hook_event_name: "UserPromptSubmit" }], [2, fail], [3, fail], [4, fail]]);
  assert.ok(brief(events).includes("step.entered agent:S3"));
  assert.equal(events.filter((e) => e.type === "snag.reported").length, 1);
  const push = play([[0, { hook_event_name: "UserPromptSubmit" }], [2, { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "git push" }, error: "rejected" }]]);
  assert.ok(!brief(push.events).includes("step.entered agent:S4"), "a failed push does not move to Pull request");
});

test("Claude's transcript gives the version, start time and session title", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipexp-claude-"));
  const path = join(dir, SID + ".jsonl");
  const rows = [
    { type: "queue-operation", operation: "enqueue", timestamp: "2026-09-24T08:59:58.000Z", sessionId: SID },
    { type: "user", timestamp: "2026-09-24T09:00:00.000Z", sessionId: SID, version: "2.1.271", message: { role: "user", content: "hi" } },
    { type: "custom-title", customTitle: "Fix login redirect", sessionId: SID },
  ];
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.equal(runtimeVersion("claude", path), "claude 2.1.271");
  assert.equal(sessionStart(path), Date.parse("2026-09-24T08:59:58.000Z"));
  assert.equal(threadName(SID, path), "Fix login redirect");
  const r = onHook(null, { ...base, transcript_path: path, hook_event_name: "SessionStart", source: "startup" }, { ...claude({ probe: probe({ threadName }) }), now: T0 });
  assert.equal(r.events[0].title, "Fix login redirect");
});

test("tokens for a Claude session come from its transcript: once per message, sub-agents included", () => {
  const agents = usage({ since: "2026-09-24T09:00:00Z", runtime: "claude", session: SID, transcriptPath: TRANSCRIPT });
  assert.equal(agents[0].agentId, SID);
  assert.equal(agents[0].role, "main");
  assert.equal(agents[0].runtimeVersion, "claude 2.1.270");
  assert.ok(agents.length >= 3, "sub-agents are included");
  assert.ok(agents.every((a) => a.tokens.input >= a.tokens.cachedInput));
});

test("the hook command names its harness, so Claude and Codex never mix up", () => {
  assert.equal(runtimeOf({}, ["node", "pipexp-hook.mjs", "--runtime", "claude"]), "claude");
  assert.equal(runtimeOf({ PLUGIN_ROOT: "/x", CLAUDE_PLUGIN_ROOT: "/x" }, ["node", "h"]), "codex");
  assert.equal(runtimeOf({ CLAUDE_PLUGIN_ROOT: "/x", CLAUDECODE: "1" }, ["node", "h"]), "claude");
  // Claude Code started from a Codex terminal inherits CODEX_THREAD_ID (seen live, 26 Sep 2026).
  assert.equal(runtimeOf({ CODEX_THREAD_ID: "01a0", CLAUDE_PLUGIN_ROOT: "/x", CLAUDE_CODE_SESSION_ID: "s", CLAUDECODE: "1" }, ["node", "h"]), "claude");
  assert.equal(runtimeOf({ CODEX_THREAD_ID: "01a0" }, ["node", "h"]), "codex");
  // One hooks file for both harnesses: Claude Code loads hooks/hooks.json AND a manifest hooks file, so a second
  // file would send every event twice (seen live, 26 Sep 2026).
  const hooks = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8")).hooks;
  for (const [event, [group]] of Object.entries(hooks)) assert.equal(group.hooks[0].command, 'node "$' + '{CLAUDE_PLUGIN_ROOT}/hooks/pipexp-hook.mjs"', event);
  assert.ok(hooks.PostToolUseFailure, "failed tool calls are reported");
  const manifest = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.hooks, undefined, "no second hooks file");
  assert.deepEqual(manifest.mcpServers.pipexp.args, ["$" + "{CLAUDE_PLUGIN_ROOT}/mcp/server.mjs"]);
});
