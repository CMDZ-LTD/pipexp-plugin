// CMD-518: the CLI follows the same rule as the MCP tools. A command that sends or changes a session needs --session or
// the identity the harness gives its shells (Codex sets CODEX_THREAD_ID in each thread's shell; Claude Code sets
// CLAUDE_CODE_SESSION_ID); never a session found by folder or recency.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { freshHome } from "./helpers.mjs";

const home = freshHome();
process.env.PIPEXP_RUNTIME = "codex";
const { hook, sessionFile } = await import("../core/run.mjs");
const { queued } = await import("../core/queue.mjs");

const dir = mkdtempSync(join(tmpdir(), "pipexp-cli-identity-"));
execFileSync("git", ["init", "-q", dir]);
execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/acme/shared-cli"]);
const A = "01a0da36-9343-7353-9749-98859e2a4764";
const B = "01a0d4f0-d676-7013-9cba-fea7effb6b95";
hook({ session_id: A, cwd: dir, hook_event_name: "UserPromptSubmit", turn_id: "a1" });
await new Promise((r) => setTimeout(r, 20));
hook({ session_id: B, cwd: dir, hook_event_name: "UserPromptSubmit", turn_id: "b1" });
// This repo's board takes activity (as /plugin/config said), so a status can go.
mkdirSync(join(home, "state", "stages"), { recursive: true });
writeFileSync(join(home, "state", "stages", "acme_shared-cli.json"), JSON.stringify({ lanes: [{ skill: "agent", label: "Agent sessions", stages: [{ id: "agent:S2", label: "Build" }] }], contentLevel: "standard", capabilities: ["agent-activity-v1"], at: new Date().toISOString() }));

// A clean environment: nothing from the shell running the tests (it may be a Codex thread with its own id).
const cli = (args, extra = {}) =>
  spawnSync(process.execPath, [new URL("../bin/pipexp.mjs", import.meta.url).pathname, ...args], {
    cwd: dir, encoding: "utf8", timeout: 20_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PIPEXP_HOME: home, PIPEXP_NO_FLUSH: "1", PIPEXP_TEST: "1", PIPEXP_RUNTIME: "codex", ...extra },
  });
const saved = (sid) => readFileSync(sessionFile(sid), "utf8");

test("with no --session and no harness identity, no session command picks one by folder: nothing sent, neither changed", () => {
  const before = queued().length;
  const [a, b] = [saved(A), saved(B)];
  for (const args of [
    ["stage", "agent:S2", "--ticket", "CMD-518"],
    ["activity", "working", "--note", "Fixing the lookup"],
    ["event", "snag.reported", "--json", JSON.stringify({ kind: "snag", theme: "ci", what: "Runner timed out", costMin: 5 })],
    ["event", "run.finished", "--json", JSON.stringify({ outcome: "ready" })],
    ["ask", "Ship it?", "--timeout-min", "1"],
  ]) {
    const r = cli(args);
    assert.match(r.stderr, /--session/, args[0] + ": says what to pass");
    assert.match(r.stderr, /Nothing was sent/, args[0]);
    assert.notEqual(r.status, 2, args[0] + ": a script is not failed as if its arguments were wrong");
  }
  assert.equal(queued().length, before, "no event");
  assert.equal(saved(A), a);
  assert.equal(saved(B), b);
});

test("an explicit --session, or the thread id Codex puts in its shell, lands on that session only", () => {
  let before = queued().length;
  const b = saved(B);
  let r = cli(["stage", "agent:S2", "--ticket", "CMD-518", "--session", A]);
  assert.equal(r.stderr, "");
  let sent = queued().slice(before);
  assert.ok(sent.length && sent.every((e) => e.runId === JSON.parse(saved(A)).runId));
  assert.equal(saved(B), b);
  before = queued().length;
  r = cli(["activity", "working", "--note", "Reviewing the CLI"], { CODEX_THREAD_ID: A });
  assert.equal(r.stderr, "");
  sent = queued().slice(before);
  assert.ok(sent.length && sent.every((e) => e.runId === JSON.parse(saved(A)).runId), "CODEX_THREAD_ID names A");
  assert.equal(saved(B), b);
  // A Codex thread id leaked into a Claude Code shell is not Claude's identity: refused.
  before = queued().length;
  r = cli(["stage", "agent:S3"], { CODEX_THREAD_ID: A, PIPEXP_RUNTIME: "claude" });
  assert.match(r.stderr, /Nothing was sent/);
  assert.equal(queued().length, before);
});

test("read-only and machine commands still work with no id", () => {
  const before = queued().length;
  const [a, b] = [saved(A), saved(B)];
  for (const args of [["status"], ["stages"], ["preview"], ["content", "standard"]]) {
    const r = cli(args);
    assert.notEqual(r.status, 2, args[0] + ": " + r.stderr);
    assert.doesNotMatch(r.stderr, /Nothing was sent/, args[0]);
  }
  assert.equal(queued().length, before);
  assert.equal(saved(A), a);
  assert.equal(saved(B), b);
});

test("R3: an id the board would not take is refused up front, so two ids never share one session file", () => {
  const before = queued().length;
  const a = saved(A);
  // "a/b" and "a_b" would name the same state file; neither odd id is ever used.
  for (const odd of [A.replace(/-/g, "/"), "x".repeat(101), "a b", "../" + A]) {
    const r = cli(["stage", "agent:S2", "--session", odd]);
    assert.match(r.stderr, /not one PipeXP takes.*Nothing was sent/, JSON.stringify(odd));
  }
  assert.equal(queued().length, before);
  assert.equal(saved(A), a);
  // "s/1" would have named the same state file as "s_1": only the second is ever used.
  hook({ session_id: "s_1", cwd: dir, hook_event_name: "UserPromptSubmit", turn_id: "c1" });
  const s1 = saved("s_1");
  assert.match(cli(["stage", "agent:S3", "--session", "s/1"]).stderr, /not one PipeXP takes/);
  assert.equal(saved("s_1"), s1);
  assert.ok(existsSync(sessionFile("s_1")));
});
