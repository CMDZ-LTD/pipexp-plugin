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
  assert.equal(await fetchSteers({ url: b.url, key: "pipexp_rk_" + "k".repeat(43) }, s), 1);
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
  assert.equal(steerOutput("codex", "Stop", [NOTE]), "", "Stop cannot carry context");
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
  assert.equal(await fetchSteers({ url: "http://127.0.0.1:9", key: "k" }, { runId: "r", sessionId: "s", finished: true }), 0);
  assert.equal(await fetchSteers({ url: "http://127.0.0.1:9", key: "k" }, { runId: "r", sessionId: "s", shipOwned: true }), 0);
  // The board down: nothing, no throw.
  assert.equal(await fetchSteers({ url: "http://127.0.0.1:9", key: "k" }, { runId: "r", sessionId: "s" }), 0);
  void home;
});
