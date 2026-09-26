// A report from a git worktree the session did not start in (CMD-370): found by the thread id, else by the one session
// in another worktree of the same repo. The MCP server's error names the folder it looked in.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { freshHome } from "./helpers.mjs";

freshHome();
process.env.PIPEXP_RUNTIME = "codex";
const { findSession, hook } = await import("../core/run.mjs");

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
function repoWithWorktree(name) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pipexp-wt-")));
  const main = join(base, name);
  execFileSync("git", ["init", "-q", main]);
  git(main, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  const tree = join(base, name + "-feature");
  git(main, "worktree", "add", "-q", "-b", "feature", tree);
  return { main, tree };
}

// Calls one MCP tool on a fresh server process, as Codex does: a bare environment plus PIPEXP_HOME.
function call(name, args, env = {}) {
  return new Promise((done) => {
    const server = spawn(process.execPath, [new URL("../mcp/server.mjs", import.meta.url).pathname], {
      env: { PATH: process.env.PATH, PIPEXP_HOME: process.env.PIPEXP_HOME, PIPEXP_NO_FLUSH: "1", PIPEXP_TEST: "1", ...env },
    });
    let out = "";
    server.stdout.on("data", (d) => {
      out += d;
      const line = out.split("\n").find((l) => l.includes('"id":1'));
      if (line) {
        server.kill();
        done(JSON.parse(line).result);
      }
    });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
}

test("a report from another worktree of the same repo finds the one session there", async () => {
  const { main, tree } = repoWithWorktree("shop");
  hook({ session_id: "s-main", cwd: main, hook_event_name: "UserPromptSubmit" });
  assert.deepEqual(findSession(tree, {}), { id: "s-main", via: "worktree" });
  // The thread id, when the process has one, names it outright.
  assert.deepEqual(findSession(tree, { CODEX_THREAD_ID: "thread-7" }), { id: "thread-7", via: "env" });
  const r = await call("pipexp_report_stage", { cwd: tree, stage: "agent:S2", ticket: "ABC-12" });
  assert.equal(r.isError, undefined);
  assert.equal(r.content[0].text, "On the board: agent:S2 for ABC-12");
});

test("with two sessions in other worktrees it picks none, and the error names the folder and says pass session_id", async () => {
  const { main, tree } = repoWithWorktree("app");
  const other = tree + "-2";
  git(main, "worktree", "add", "-q", "-b", "other", other);
  hook({ session_id: "s-a", cwd: main, hook_event_name: "UserPromptSubmit" });
  hook({ session_id: "s-b", cwd: other, hook_event_name: "UserPromptSubmit" });
  assert.deepEqual(findSession(tree, {}), { id: null, why: "several" });
  const r = await call("pipexp_report_stage", { cwd: tree, stage: "agent:S2" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, new RegExp("^No PipeXP session found for " + tree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ": several sessions"));
  assert.match(r.content[0].text, /Pass session_id/);
  // A folder in no repo at all: named too.
  const lone = realpathSync(mkdtempSync(join(tmpdir(), "pipexp-lone-")));
  const r2 = await call("pipexp_report_stage", { cwd: lone, stage: "agent:S2" });
  assert.match(r2.content[0].text, new RegExp("No PipeXP session found for " + lone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // A Codex thread id in the server's own environment wins, from any folder.
  const r3 = await call("pipexp_report_stage", { cwd: lone, stage: "agent:S3" }, { CODEX_THREAD_ID: "thread-9" });
  assert.equal(r3.content[0].text, "On the board: agent:S3");
});

