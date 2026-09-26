// Steers from the board (CMD-80): the flush fetches them for a live session, and the next tool hook shows them once,
// in each agent's own format; a stop ends a Codex or Claude Code turn.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { freshHome } from "./helpers.mjs";

const home = freshHome();
process.env.HOME = mkdtempSync(join(tmpdir(), "pipexp-steer-home-"));
const { saveCredentials } = await import("../core/config.mjs");
const { hook, loadSession } = await import("../core/run.mjs");
const { fetchSteers, steerDue, steerOutput, takeSteers } = await import("../core/steer.mjs");

async function board(steers) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, key: req.headers["x-api-key"] });
    res.writeHead(req.url.startsWith("/steer") ? 200 : 201, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url.startsWith("/steer") ? { steers: seen.filter((s) => s.url.startsWith("/steer")).length === 1 ? steers : [] } : { ok: true }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: "http://127.0.0.1:" + server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}
const NOTE = { kind: "note", message: "Note from sam@orbit.test on the PipeXP board: use the v2 export" };
const STOP = { kind: "stop", message: "Stopped from the PipeXP board by ana@orbit.test: wrong ticket. Do not call more tools; end your turn and say why." };

test("the flush fetches a live session's steers on its machine key, and the next tool hook shows each once", async () => {
  const b = await board([NOTE]);
  saveCredentials({ url: b.url, key: "pipexp_rk_" + "k".repeat(43) });
  hook({ session_id: "s-1", cwd: "/repo", hook_event_name: "UserPromptSubmit" }, "codex");
  const s = loadSession("s-1");
  assert.equal((await fetchSteers({ url: b.url, key: "pipexp_rk_" + "k".repeat(43) }, s)).length, 1);
  await b.close();
  const steer = b.seen.find((r) => r.url.startsWith("/steer"));
  assert.equal(steer.url, "/steer?runId=" + s.runId);
  assert.equal(steer.key, "pipexp_rk_" + "k".repeat(43));
  assert.deepEqual(takeSteers("s-1"), [NOTE]);
  assert.deepEqual(takeSteers("s-1"), [], "shown once");
});

test("a note is context for the next step; a stop also ends a Codex or Claude Code turn; Cursor gets context", () => {
  assert.deepEqual(JSON.parse(steerOutput("codex", "PostToolUse", [NOTE])), { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: NOTE.message } });
  const stop = JSON.parse(steerOutput("claude", "PostToolUse", [NOTE, STOP]));
  assert.equal(stop.continue, false);
  assert.equal(stop.stopReason, STOP.message);
  assert.equal(stop.hookSpecificOutput.additionalContext, NOTE.message + "\n" + STOP.message);
  assert.deepEqual(JSON.parse(steerOutput("cursor", "PostToolUse", [STOP])), { additional_context: STOP.message });
  // At the turn's end a note keeps the agent going with it; a stop, even with a note, lets the turn end.
  assert.deepEqual(JSON.parse(steerOutput("codex", "Stop", [NOTE])), { decision: "block", reason: NOTE.message });
  assert.equal(steerOutput("claude", "Stop", [NOTE, STOP]), "");
  assert.equal(steerOutput("cursor", "Stop", [NOTE]), "", "Cursor's stop hook cannot continue the turn");
  assert.equal(steerOutput("codex", "PostToolUse", []), "");
});

test("the hook command prints a waiting stop in Codex's format and exits 0 at once", async () => {
  const b = await board([STOP]);
  saveCredentials({ url: b.url, key: "pipexp_rk_" + "k".repeat(43) });
  hook({ session_id: "s-2", cwd: "/repo", hook_event_name: "UserPromptSubmit" }, "codex");
  await fetchSteers({ url: b.url, key: "pipexp_rk_" + "k".repeat(43) }, loadSession("s-2"));
  await b.close();
  const launcher = new URL("../hooks/pipexp-hook.mjs", import.meta.url).pathname;
  const run = spawnSync(process.execPath, [launcher, "--runtime", "codex"], { input: JSON.stringify({ session_id: "s-2", cwd: "/repo", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } }), env: { ...process.env }, encoding: "utf8", timeout: 5000 });
  assert.equal(run.status, 0);
  const out = JSON.parse(run.stdout);
  assert.equal(out.continue, false);
  assert.equal(out.stopReason, STOP.message);
});

test("a session asks the board at most every 30 seconds, and a finished or ship-owned one never", async () => {
  const now = Date.now();
  const { markChecked } = await import("../core/steer.mjs");
  assert.equal(steerDue("s-3", now), true);
  markChecked("s-3", now);
  assert.equal(steerDue("s-3", now + 10_000), false);
  assert.equal(steerDue("s-3", now + 31_000), true);
  assert.equal((await fetchSteers({ url: "http://127.0.0.1:9", key: "k" }, { runId: "r", sessionId: "s", finished: true })).length, 0);
  assert.equal((await fetchSteers({ url: "http://127.0.0.1:9", key: "k" }, { runId: "r", sessionId: "s", shipOwned: true })).length, 0);
  // The board down: nothing, no throw.
  assert.equal((await fetchSteers({ url: "http://127.0.0.1:9", key: "k" }, { runId: "r", sessionId: "s" })).length, 0);
  void home;
});

test("a stop shown to an agent moves its card to Waiting for you; a ship run keeps its lane", async () => {
  const b = await board([STOP]);
  saveCredentials({ url: b.url, key: "pipexp_rk_" + "k".repeat(43) });
  const launcher = new URL("../hooks/pipexp-hook.mjs", import.meta.url).pathname;
  const fire = (sid, event, extra = {}) =>
    spawnSync(process.execPath, [launcher, "--runtime", "codex"], { input: JSON.stringify({ session_id: sid, cwd: "/repo", hook_event_name: event, ...extra }), env: { ...process.env, PIPEXP_NO_FLUSH: "1" }, encoding: "utf8", timeout: 5000 });
  hook({ session_id: "s-4", cwd: "/repo", hook_event_name: "UserPromptSubmit" }, "codex");
  hook({ session_id: "s-4", cwd: "/repo", hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: {} }, "codex");
  await fetchSteers({ url: b.url, key: "pipexp_rk_" + "k".repeat(43) }, loadSession("s-4"));
  await b.close();
  const run = fire("s-4", "PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" } });
  assert.equal(JSON.parse(run.stdout).continue, false);
  assert.equal(loadSession("s-4").stage, "agent:S5");
  assert.equal(loadSession("s-4").skill, "agent");
  // A ship run stopped the same way stays in its lane.
  const { report } = await import("../core/run.mjs");
  hook({ session_id: "s-5", cwd: "/repo", hook_event_name: "UserPromptSubmit" }, "codex");
  report("s-5", { type: "stage", stage: "ship:S4", ticket: "ABC-12" }, "codex", "/repo");
  const b2 = await board([STOP]);
  saveCredentials({ url: b2.url, key: "pipexp_rk_" + "k".repeat(43) });
  await fetchSteers({ url: b2.url, key: "pipexp_rk_" + "k".repeat(43) }, loadSession("s-5"));
  await b2.close();
  assert.equal(JSON.parse(fire("s-5", "PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }).stdout).continue, false);
  assert.equal(loadSession("s-5").skill, "ship");
  assert.equal(loadSession("s-5").stage, "ship:S4");
});

test("review: a steer the board sends again (its reply was lost) is shown once, and the next call acknowledges it", async () => {
  const ID = "0b5c7c1e-4a8e-4d3a-9c55-2f1e6a7b8c90";
  const seen = [];
  const { createServer: serve } = await import("node:http");
  const server = serve((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ steers: [{ steerId: ID, kind: "stop", message: STOP.message }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const creds = { url: "http://127.0.0.1:" + server.address().port, key: "pipexp_rk_" + "k".repeat(43) };
  hook({ session_id: "s-ack", cwd: "/repo", hook_event_name: "UserPromptSubmit" }, "codex");
  const s = loadSession("s-ack");
  assert.equal((await fetchSteers(creds, s)).length, 1);
  assert.equal((await fetchSteers(creds, s)).length, 0, "the same id again: not shown twice");
  await new Promise((r) => server.close(r));
  assert.doesNotMatch(seen[0], /ack=/);
  assert.match(seen[1], new RegExp("&ack=" + ID));
  assert.equal(takeSteers("s-ack").length, 1);
});

test("a restart from the board ends this turn like a stop; the flush starts the new run", () => {
  const RESTART = { kind: "restart", model: "gpt-6-sol", message: "Restarted on gpt-6-sol from the PipeXP board by sam@orbit.test. Do not call more tools; end your turn: a new run on gpt-6-sol carries on." };
  const out = JSON.parse(steerOutput("codex", "PostToolUse", [RESTART]));
  assert.equal(out.continue, false);
  assert.equal(out.stopReason, RESTART.message);
  assert.equal(steerOutput("codex", "Stop", [RESTART]), "", "at the turn's end it just ends");
});
