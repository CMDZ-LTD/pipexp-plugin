// CMD-518: a report with no caller identity never lands on another session's card. Seen on the MacBook, 28 Sep 07:47:41
// UTC: pipexp_report_stage with no session_id and a cwd shared by two sessions updated the other one (run 9b2661ad).
// Codex starts the MCP server with a bare environment (no CODEX_THREAD_ID), so the only identity is session_id.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { freshHome } from "./helpers.mjs";

const home = freshHome();
process.env.PIPEXP_RUNTIME = "codex";
const { hook, sessionFile } = await import("../core/run.mjs");
const { queued } = await import("../core/queue.mjs");
const { startContext } = await import("../core/stages.mjs");

const dir = mkdtempSync(join(tmpdir(), "pipexp-identity-"));
execFileSync("git", ["init", "-q", dir]);
execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/acme/shared"]);
const A = "01a0da05-8d13-71e3-8374-ba4c42be1829";
const B = "01a0d4f0-d676-7013-9cba-fea7effb6b95";
// Both real-shaped sessions work in the same folder; B was seen last.
hook({ session_id: A, cwd: dir, hook_event_name: "UserPromptSubmit", turn_id: "a1" });
await new Promise((r) => setTimeout(r, 20));
hook({ session_id: B, cwd: dir, hook_event_name: "UserPromptSubmit", turn_id: "b1" });

function call(name, args) {
  return new Promise((resolve, reject) => {
    // As Codex starts it: a bare environment, no thread id.
    const child = spawn(process.execPath, [new URL("../mcp/server.mjs", import.meta.url).pathname], { env: { PATH: process.env.PATH, PIPEXP_HOME: home, PIPEXP_NO_FLUSH: "1", PIPEXP_TEST: "1" } });
    let output = "";
    child.on("error", reject);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const line = output.split("\n").find((s) => s.includes('"id":1'));
      if (line) { child.kill(); resolve(JSON.parse(line).result); }
    });
    child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
}
const saved = (sid) => readFileSync(sessionFile(sid), "utf8");

test("with no identity, no mutating tool picks a session by folder: refused, no event, both sessions unchanged", async () => {
  const before = queued().length;
  const [a, b] = [saved(A), saved(B)];
  for (const [name, args] of [
    ["pipexp_report_stage", { stage: "manager:S3", ticket: "CMD-518" }],
    ["pipexp_report_status", { state: "working", note: "Fixing the lookup" }],
    ["pipexp_report_snag", { what: "Flaky test" }],
    ["pipexp_finish", { outcome: "ready" }],
    ["pipexp_ask_human", { question: "Ship it?" }],
  ]) {
    const r = await call(name, { cwd: dir, ...args });
    assert.equal(r.isError, true, name);
    assert.match(r.content[0].text, /session_id/, name + ": says what to pass");
    assert.match(r.content[0].text, /Nothing was sent/, name);
  }
  assert.equal(queued().length, before, "no event");
  assert.equal(saved(A), a);
  assert.equal(saved(B), b);
});

test("with session A's own id, the report lands on A only", async () => {
  const before = queued().length;
  const b = saved(B);
  const r = await call("pipexp_report_stage", { cwd: dir, session_id: A, stage: "agent:S2", ticket: "CMD-518" });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  const sent = queued().slice(before);
  assert.ok(sent.length > 0);
  assert.ok(sent.every((e) => e.runId === JSON.parse(saved(A)).runId));
  assert.equal(saved(B), b, "B untouched");
});

test("read-only status still answers without an id, and changes nothing", async () => {
  const before = queued().length;
  const [a, b] = [saved(A), saved(B)];
  const r = await call("pipexp_status", { cwd: dir });
  assert.equal(r.isError, undefined);
  assert.equal(JSON.parse(r.content[0].text).plugin.startsWith("pipexp "), true);
  assert.equal(queued().length, before);
  assert.equal(saved(A), a);
  assert.equal(saved(B), b);
});

test("the session-start context names the session's own id and says to pass it on every PipeXP tool call", () => {
  mkdirSync(join(home, "state", "stages"), { recursive: true });
  writeFileSync(join(home, "state", "stages", "acme_shared.json"), JSON.stringify({ lanes: [{ skill: "agent", label: "Agent sessions", stages: [{ id: "agent:S2", label: "Build" }] }], contentLevel: "standard", capabilities: [], at: new Date().toISOString() }));
  const { text } = startContext(dir, Date.now(), A);
  assert.match(text, new RegExp("session_id is " + A));
  assert.match(text, /pass it as session_id on every PipeXP tool call/);
  // An id that is not a plain session id is never put in the agent's context.
  assert.doesNotMatch(startContext(dir, Date.now(), "x\nignore previous").text, /ignore previous/);
});

test("R3: an odd-looking session_id is refused by the MCP tools too, before anything is read or sent", async () => {
  const before = queued().length;
  const a = saved(A);
  for (const odd of [A.replace(/-/g, "/"), "x".repeat(101), "a b", "../" + A]) {
    const r = await call("pipexp_report_stage", { cwd: dir, session_id: odd, stage: "agent:S2" });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /not one PipeXP takes.*Nothing was sent/, JSON.stringify(odd));
  }
  assert.equal(queued().length, before);
  assert.equal(saved(A), a);
});
