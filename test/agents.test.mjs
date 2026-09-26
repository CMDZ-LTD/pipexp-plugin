// Cursor, Gemini CLI and OpenCode: their own hook payloads, turned into the board's events.
// Payload shapes: cursor.com/docs/hooks, gemini-cli docs/hooks/reference.md and chatRecordingService.ts,
// opencode packages/plugin/src/index.ts (read 25 Sep 2026).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ctx } from "./helpers.mjs";
import { adapt, noticeOutput } from "../core/adapt.mjs";
import { cursorCommand, installCursor, installOpencode, uninstallCursor } from "../core/install.mjs";
import { runtimeOf } from "../core/run.mjs";
import { onHook } from "../core/session.mjs";
import { usage } from "../core/usage.mjs";
import { makeHandlers } from "../opencode/pipexp.mjs";

const T0 = Date.parse("2026-09-26T09:00:00Z");
const MIN = 60_000;

function play(runtime, payloads) {
  let state = null;
  const events = [];
  payloads.forEach(([min, raw]) => {
    const input = adapt(runtime, raw, {});
    if (!input) return;
    const r = onHook(state, input, ctx(T0 + min * MIN, { runtime, runtimeVersion: undefined }));
    state = r.state;
    events.push(...r.events);
  });
  return { state, events };
}
const brief = (events) => events.map((e) => e.type + (e.stage ? " " + e.stage : ""));

test("Cursor: its camelCase events and conversation_id become a run in the agent lane, as runtime cursor", () => {
  const common = { conversation_id: "conv-1", generation_id: "g", model: "claude-opus-4-7-thinking-max", cursor_version: "3.20.17", workspace_roots: ["/repo"], transcript_path: null };
  const { events } = play("cursor", [
    [0, { ...common, hook_event_name: "sessionStart", session_id: "conv-1" }],
    [0, { ...common, hook_event_name: "beforeSubmitPrompt", prompt: "fix login" }],
    [2, { ...common, hook_event_name: "postToolUse", tool_name: "Write", tool_input: { file_path: "/repo/a.ts" }, tool_output: "{}", cwd: "/repo" }],
    [4, { ...common, hook_event_name: "postToolUse", tool_name: "Shell", tool_input: { command: "npm test" }, tool_output: JSON.stringify({ exitCode: 0, stdout: "ok" }) }],
    [6, { ...common, hook_event_name: "stop", status: "completed", loop_count: 0 }],
    [9, { ...common, hook_event_name: "sessionEnd", session_id: "conv-1", reason: "user_closed", final_status: "completed" }],
    [9, { ...common, hook_event_name: "afterAgentThought" }],
  ]);
  assert.deepEqual(brief(events), ["run.started", "step.entered agent:S1", "usage.reported agent:S1", "step.entered agent:S2", "usage.reported agent:S2", "step.entered agent:S3", "usage.reported agent:S3", "step.entered agent:S5", "run.finished"]);
  assert.ok(events.every((e) => e.runtime === "cursor"));
  assert.equal(events.at(-1).outcome, "ready");
});

test("Cursor: a failed test (exitCode) and postToolUseFailure both count toward the 3-failures snag", () => {
  const common = { conversation_id: "conv-2", workspace_roots: ["/repo"] };
  const failRun = { ...common, hook_event_name: "postToolUse", tool_name: "Shell", tool_input: { command: "pnpm test" }, tool_output: JSON.stringify({ exitCode: 1 }) };
  const failTool = { ...common, hook_event_name: "postToolUseFailure", tool_name: "Shell", tool_input: { command: "pnpm test" }, error_message: "timed out", failure_type: "timeout" };
  const { events } = play("cursor", [[0, { ...common, hook_event_name: "beforeSubmitPrompt" }], [1, failRun], [2, failTool], [3, failRun]]);
  assert.equal(events.filter((e) => e.type === "snag.reported").length, 1);
});

test("Gemini CLI: BeforeAgent, AfterTool and AfterAgent map to prompt, tool and stop; the exit code is read from its text", () => {
  const common = { session_id: "gem-1", cwd: "/repo", transcript_path: null, timestamp: "2026-09-26T09:00:00Z" };
  const { events } = play("gemini", [
    [0, { ...common, hook_event_name: "SessionStart", source: "startup" }],
    [0, { ...common, hook_event_name: "BeforeAgent", prompt: "fix" }],
    [2, { ...common, hook_event_name: "AfterTool", tool_name: "replace", tool_input: { file_path: "/repo/a.ts" }, tool_response: { llmContent: "ok" } }],
    [4, { ...common, hook_event_name: "AfterTool", tool_name: "run_shell_command", tool_input: { command: "git push" }, tool_response: { llmContent: "Output: rejected\nExit Code: 1" } }],
    [5, { ...common, hook_event_name: "AfterAgent", prompt_response: "done" }],
  ]);
  assert.deepEqual(brief(events), ["run.started", "step.entered agent:S1", "usage.reported agent:S1", "step.entered agent:S2", "usage.reported agent:S2", "step.entered agent:S5"]);
  assert.ok(events.every((e) => e.runtime === "gemini"));
  assert.equal(adapt("gemini", { hook_event_name: "AfterTool", session_id: "g", tool_name: "x", tool_response: { error: { message: "no" } } }, {}).hook_event_name, "PostToolUseFailure");
  assert.equal(adapt("gemini", { hook_event_name: "BeforeModel", session_id: "g" }, {}), null);
});

test("Gemini CLI: tokens come from its transcript, each message counted once at its latest copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipexp-gemini-"));
  const path = join(dir, "session-1.jsonl");
  const rows = [
    { sessionId: "gem-1", projectHash: "h", startTime: "2026-09-26T09:00:00Z", lastUpdated: "2026-09-26T09:00:00Z", kind: "main" },
    { id: "u1", type: "user", timestamp: "2026-09-26T09:00:01Z", content: "hi" },
    { id: "m1", type: "gemini", timestamp: "2026-09-26T09:00:05Z", model: "gemini-3-pro", content: "", tokens: null },
    { id: "m1", type: "gemini", timestamp: "2026-09-26T09:00:05Z", model: "gemini-3-pro", content: "a", tokens: { input: 1000, output: 50, cached: 400, thoughts: 20, tool: 10, total: 1080 } },
    { id: "m2", type: "gemini", timestamp: "2026-09-26T09:01:05Z", model: "gemini-3-pro", content: "b", tokens: { input: 2000, output: 70, cached: 1500, thoughts: 0, tool: 0, total: 2070 } },
  ];
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const [agent] = usage({ since: "2026-09-26T09:00:00Z", runtime: "gemini", session: "gem-1", transcriptPath: path });
  assert.deepEqual(agent.tokens, { input: 3010, cachedInput: 1900, output: 120, reasoning: 20 });
  assert.equal(agent.model, "gemini-3-pro");
  assert.equal(agent.wallSeconds, 60);
});

test("OpenCode: the plugin turns its events into launcher payloads and sums tokens per message for Stop", async () => {
  const sent = [];
  const h = makeHandlers({ directory: "/repo" }, (p) => sent.push(p));
  await h.event({ event: { type: "session.created", properties: { info: { id: "ses_1", directory: "/repo" } } } });
  await h["chat.message"]({ sessionID: "ses_1", model: { providerID: "anthropic", modelID: "claude-opus-5" } });
  await h["tool.execute.after"]({ tool: "bash", sessionID: "ses_1", callID: "c", args: { command: "npm test", workdir: "/repo" } }, { title: "npm test", output: "x".repeat(5000), metadata: { exit: 1 } });
  for (const tokens of [{ input: 10, output: 1 }, { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 5 } }])
    await h.event({ event: { type: "message.updated", properties: { info: { id: "msg_1", role: "assistant", sessionID: "ses_1", modelID: "claude-opus-5", tokens } } } });
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
  await h.event({ event: { type: "message.part.updated", properties: { part: { type: "tool", sessionID: "ses_1", tool: "edit", state: { status: "error", input: {}, error: "denied" } } } } });
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_1" } } } });
  assert.deepEqual(sent.map((p) => p.hook_event_name), ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "PostToolUseFailure", "SessionEnd"]);
  const tool = sent[2];
  assert.equal(tool.tool_input.command, "npm test");
  assert.equal(tool.tool_response.exit, 1);
  assert.ok(tool.tool_response.output.length <= 2000, "command output is cut before it leaves OpenCode");
  assert.deepEqual(sent[3].pipexp_usage, { model: "claude-opus-5", input: 155, cachedInput: 50, output: 20, reasoning: 5 });
  // A sub-session (parentID) is part of its parent's run, not its own card.
  await h.event({ event: { type: "session.created", properties: { info: { id: "ses_child", parentID: "ses_1" } } } });
  assert.equal(sent.length, 6);
});

test("OpenCode: its counted tokens become the run's usage", () => {
  const reported = { model: "claude-opus-5", input: 155, cachedInput: 50, output: 20, reasoning: 5 };
  const s = onHook(null, { session_id: "ses_9", cwd: "/repo", hook_event_name: "UserPromptSubmit" }, ctx(T0, { runtime: "opencode" })).state;
  const stop = onHook(s, { session_id: "ses_9", cwd: "/repo", hook_event_name: "Stop", pipexp_usage: reported }, ctx(T0 + MIN, { runtime: "opencode" }));
  const marker = stop.events.find((e) => e.type === "usage.reported");
  assert.deepEqual(marker._usage.reported.input, 155);
  const [agent] = usage({ since: T0, runtime: "opencode", session: "ses_9", reported: marker._usage.reported });
  assert.deepEqual(agent.tokens, { input: 155, cachedInput: 50, output: 20, reasoning: 5 });
  assert.equal(agent.model, "claude-opus-5");
});

test("the launcher knows each agent; Cursor wins over the Claude hooks it also runs", () => {
  assert.equal(runtimeOf({}, ["node", "h", "--runtime", "gemini"]), "gemini");
  assert.equal(runtimeOf({ CURSOR_VERSION: "3.20", CLAUDE_PLUGIN_ROOT: "/x", CLAUDECODE: "1" }, ["node", "h"]), "cursor");
  assert.equal(runtimeOf({ GEMINI_SESSION_ID: "g" }, ["node", "h"]), "gemini");
  assert.equal(runtimeOf({}, ["node", "h", "--runtime", "not-an-agent"]), "codex");
  assert.equal(noticeOutput("cursor", "hi"), JSON.stringify({ additional_context: "hi" }));
  assert.equal(noticeOutput("gemini", "hi"), JSON.stringify({ systemMessage: "hi" }));
  const hooks = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8")).hooks;
  for (const ev of ["BeforeAgent", "AfterTool", "AfterAgent"]) assert.equal(hooks[ev][0].hooks[0].command, 'node "$' + '{extensionPath}/hooks/pipexp-hook.mjs" --runtime gemini', ev);
  const ext = JSON.parse(readFileSync(new URL("../gemini-extension.json", import.meta.url), "utf8"));
  assert.equal(ext.name, "pipexp");
});

test("pipexp install cursor merges into ~/.cursor/hooks.json: other hooks stay, running it twice changes nothing, uninstall removes only ours", () => {
  const home = mkdtempSync(join(tmpdir(), "pipexp-cursor-"));
  const other = { command: "/opt/vibe/bridge --source cursor" };
  mkdirSync(join(home, ".cursor"));
  writeFileSync(join(home, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { stop: [other], afterAgentThought: [other] } }));
  installCursor(home, "/plugins/pipexp/hooks/pipexp-hook.mjs");
  installCursor(home, "/plugins/pipexp/hooks/pipexp-hook.mjs");
  const config = JSON.parse(readFileSync(join(home, ".cursor", "hooks.json"), "utf8"));
  assert.deepEqual(config.hooks.stop, [other, { command: "node /plugins/pipexp/hooks/pipexp-hook.mjs --runtime cursor", timeout: 5 }]);
  assert.deepEqual(config.hooks.afterAgentThought, [other]);
  assert.equal(config.hooks.beforeSubmitPrompt.length, 1);
  assert.ok(readFileSync(join(home, ".cursor", "hooks.json.before-pipexp"), "utf8").includes("vibe"), "the old file is kept");
  assert.equal(cursorCommand("/My Plugins/pipexp-hook.mjs"), 'node "/My Plugins/pipexp-hook.mjs" --runtime cursor');
  uninstallCursor(home);
  const after = JSON.parse(readFileSync(join(home, ".cursor", "hooks.json"), "utf8"));
  assert.deepEqual(after.hooks, { stop: [other], afterAgentThought: [other] });
  const broken = mkdtempSync(join(tmpdir(), "pipexp-cursor-bad-"));
  mkdirSync(join(broken, ".cursor"));
  writeFileSync(join(broken, ".cursor", "hooks.json"), "{ not json");
  assert.equal(installCursor(broken).ok, false, "a broken file is left alone");
});

test("pipexp install opencode writes a one-line plugin that loads this checkout", () => {
  const home = mkdtempSync(join(tmpdir(), "pipexp-oc-"));
  // An explicit config folder, so the test does not depend on the runner's XDG_CONFIG_HOME.
  const { path } = installOpencode(home, join(home, "xdg"));
  assert.equal(path, join(home, "xdg", "opencode", "plugins", "pipexp.js"));
  assert.match(readFileSync(path, "utf8"), /export \{ PipeXP, PipeXP as default \} from ".*opencode\/pipexp\.mjs";/);
});
