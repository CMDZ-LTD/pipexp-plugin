// CMD-518: a real session whose work moves to another repository (seen on the Pipeline Boss thread 01a0d4f0: bound to the
// monorepo, reporting PipeXP work that landed on the monorepo's board). Its run there ends as it is; the same session
// starts a new run for the new repo, only when the board confirmed this key may report there. No run moves project.
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
const { queued } = await import("../core/queue.mjs");

function repo(name) {
  const dir = mkdtempSync(join(tmpdir(), "pipexp-move-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/acme/" + name]);
  return dir;
}
const since = (n) => queued().slice(n);

test("a session that moves repo ends its old run there and reports the new repo on a new run, same session id", () => {
  const first = repo("monorepo");
  const next = repo("pipexp");
  const sid = "move-1";
  hook({ session_id: sid, cwd: first, hook_event_name: "UserPromptSubmit", turn_id: "t1" });
  report(sid, { type: "stage", stage: "manager:S3", ticket: "ABC-1" }, "codex", first);
  const old = loadSession(sid);
  // Without the board's go-ahead nothing moves.
  const before = queued().length;
  assert.throws(() => report(sid, { type: "stage", stage: "agent:S2", ticket: "ABC-2" }, "codex", next), /another project. Nothing was sent/);
  assert.equal(queued().length, before);
  report(sid, { type: "stage", stage: "agent:S2", ticket: "ABC-2" }, "codex", next, { move: true });
  const events = since(before);
  const finish = events.find((e) => e.type === "run.finished");
  assert.equal(finish.runId, old.runId);
  assert.equal(finish.repo, "acme/monorepo", "the old run ends on the old project's board");
  assert.equal(finish.outcome, "abandoned");
  const now = loadSession(sid);
  assert.equal(now.sessionId, sid);
  assert.notEqual(now.runId, old.runId);
  const started = events.find((e) => e.type === "run.started" && e.runId === now.runId);
  assert.equal(started.repo, "acme/pipexp");
  assert.equal(started.ticket, "ABC-2");
  assert.ok(events.filter((e) => e.runId === old.runId).every((e) => e.repo === "acme/monorepo"), "no old-run event names the new repo");
  assert.ok(events.filter((e) => e.runId === now.runId).every((e) => e.repo === "acme/pipexp"), "no new-run event names the old repo");
  // The harness still sends its start folder with every hook: the session stays on the new repo.
  const mark = queued().length;
  hook({ session_id: sid, cwd: first, hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: {}, turn_id: "t1" });
  hook({ session_id: sid, cwd: first, hook_event_name: "Stop", turn_id: "t1" });
  assert.ok(since(mark).length > 0);
  assert.ok(since(mark).every((e) => e.runId === now.runId && e.repo === "acme/pipexp"));
  assert.equal(loadSession(sid).cwd, next);
});

function call(env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL("../mcp/server.mjs", import.meta.url).pathname], {
      env: { PATH: process.env.PATH, PIPEXP_HOME: home, PIPEXP_NO_FLUSH: "1", PIPEXP_TEST: "1", ...env },
    });
    let output = "";
    child.on("error", reject);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const line = output.split("\n").find((s) => s.includes('"id":1'));
      if (line) { child.kill(); resolve(JSON.parse(line).result); }
    });
    child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pipexp_report_stage", arguments: args } }) + "\n");
  });
}

test("the MCP tool moves a session only when the board confirms the key may report to the new repo", async () => {
  const first = repo("monorepo");
  const next = repo("pipexp");
  const sid = "move-2";
  hook({ session_id: sid, cwd: first, hook_event_name: "UserPromptSubmit", turn_id: "t1" });
  const runBefore = loadSession(sid).runId;
  let allowed = false;
  const server = createServer((req, res) => {
    const ok = allowed && req.url.startsWith("/plugin/config");
    res.writeHead(ok ? 200 : 403, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { lanes: [{ skill: "agent", label: "Agent sessions", stages: [{ id: "agent:S2", label: "Build" }] }], contentLevel: "standard" } : { error: "Project not found" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const env = { PIPEXP_URL: "http://127.0.0.1:" + server.address().port, PIPEXP_KEY: "k".repeat(30) };
  try {
    const before = queued().length;
    const refused = await call(env, { session_id: sid, cwd: next, stage: "agent:S2" });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /Nothing was moved/);
    assert.equal(queued().length, before);
    assert.equal(loadSession(sid).runId, runBefore);
    allowed = true;
    const moved = await call(env, { session_id: sid, cwd: next, stage: "agent:S2" });
    assert.equal(moved.isError, undefined, JSON.stringify(moved));
    assert.notEqual(loadSession(sid).runId, runBefore);
    assert.equal(loadSession(sid).sessionId, sid);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

