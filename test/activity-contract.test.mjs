import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { freshHome } from "./helpers.mjs";

const home = freshHome();
const { hook, report, loadSession } = await import("../core/run.mjs");
const { stagesFor } = await import("../core/stages.mjs");
const { queued } = await import("../core/queue.mjs");

function call(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL("../mcp/server.mjs", import.meta.url).pathname], {
      env: { PATH: process.env.PATH, PIPEXP_HOME: home, PIPEXP_NO_FLUSH: "1", PIPEXP_TEST: "1" },
    });
    let output = "";
    child.on("error", reject);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const line = output.split("\n").find((s) => s.includes('"id":1'));
      if (line) { child.kill(); resolve(JSON.parse(line).result); }
    });
    child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pipexp_report_status", arguments: args } }) + "\n");
  });
}

test("capability gates new reports; MCP status is scrubbed, works without usage, and rejects invalid states", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pipexp-activity-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/acme/status"]);
  const input = { session_id: "activity-contract", cwd: dir };
  hook({ ...input, hook_event_name: "UserPromptSubmit" });
  hook({ ...input, hook_event_name: "Stop" });
  assert.ok(queued().every((e) => !e.activity && !e.sessionId && e.type !== "activity.reported"), "old boards receive only their existing contract");
  let minimal = false;
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ lanes: [], capabilities: ["agent-activity-v1"], contentLevel: minimal ? "minimal" : "standard" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.PIPEXP_URL = "http://127.0.0.1:" + server.address().port;
  process.env.PIPEXP_KEY = "k".repeat(30);
  try {
    await stagesFor(dir);
    const r = await call({ ...input, state: "paused", note: "Review at /Users/example/private/file" });
    assert.equal(r.isError, undefined);
    const event = queued().at(-1);
    assert.equal(event.type, "activity.reported");
    assert.equal(event.sessionId, input.session_id);
    assert.deepEqual(event.activity, { state: "paused", source: "agent", observedAt: event.occurredAt, note: "Review at ~/private/file" });
    assert.equal(loadSession(input.session_id).finished, false);
    for (const args of [{ state: "done" }, { state: "blocked" }, { state: "paused", note: 7 }]) {
      const before = queued().length;
      assert.equal((await call({ ...input, ...args })).isError, true);
      assert.equal(queued().length, before);
    }
    minimal = true;
    await stagesFor(dir);
    report(input.session_id, { type: "activity", state: "blocked", note: "Private review reason" }, "codex", dir);
    assert.equal(queued().at(-1).activity.note, undefined);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("a report follows an explicit same-repo cwd; an unrelated repo cannot inherit its history", () => {
  const first = mkdtempSync(join(tmpdir(), "pipexp-first-"));
  const next = mkdtempSync(join(tmpdir(), "pipexp-next-"));
  for (const dir of [first, next]) {
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/acme/same"]);
  }
  hook({ session_id: "cwd-change", cwd: first, hook_event_name: "UserPromptSubmit" });
  report("cwd-change", { type: "stage", stage: "agent:S2" }, "codex", next);
  assert.equal(loadSession("cwd-change").cwd, next);
  hook({ session_id: "cwd-change", cwd: first, hook_event_name: "PostToolUse", tool_name: "read" });
  assert.equal(loadSession("cwd-change").cwd, next, "the harness start folder does not undo the explicit work folder");
  execFileSync("git", ["-C", first, "remote", "set-url", "origin", "https://github.com/acme/other"]);
  assert.throws(() => report("cwd-change", { type: "stage", stage: "agent:S2" }, "codex", first), /another project. Nothing was sent/);
  assert.equal(loadSession("cwd-change").cwd, next);
});
