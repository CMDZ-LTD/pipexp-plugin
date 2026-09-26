// pipexp_finish (CMD-370): every way an agent calls it gives a run.finished the board accepts, or a clear refusal.
// Through the MCP server as a process, as Codex runs it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { freshHome } from "./helpers.mjs";

const home = freshHome();
process.env.PIPEXP_RUNTIME = "codex";
const { hook } = await import("../core/run.mjs");
const { finishProblem } = await import("../mcp/server.mjs");
const contract = JSON.parse(readFileSync(new URL("./fixtures/board-contract.json", import.meta.url), "utf8"))["run.finished"];
const OUTCOMES = ["ready", "merged", "blocked", "abandoned"];

function call(args) {
  return new Promise((done) => {
    const server = spawn(process.execPath, [new URL("../mcp/server.mjs", import.meta.url).pathname], {
      env: { PATH: process.env.PATH, PIPEXP_HOME: home, PIPEXP_NO_FLUSH: "1", PIPEXP_TEST: "1" },
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
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pipexp_finish", arguments: args } }) + "\n");
  });
}
const outbox = () => {
  try {
    return readdirSync(join(home, "state", "outbox")).filter((n) => n.endsWith(".json")).sort().map((n) => JSON.parse(readFileSync(join(home, "state", "outbox", n), "utf8")).event);
  } catch {
    return [];
  }
};
const finishes = () => outbox().filter((e) => e.type === "run.finished");
/** A run.finished the board would take: its outcome, its PR and nothing the contract fixture lacks. */
function accepted(e) {
  assert.ok(OUTCOMES.includes(e.outcome), "outcome " + e.outcome);
  assert.ok(e.prNumber === null || (Number.isInteger(e.prNumber) && e.prNumber > 0), "prNumber " + e.prNumber);
  for (const key of Object.keys(e)) assert.ok(key in contract || ["ticket", "attemptId", "repo", "question"].includes(key), "run.finished sends " + key);
}

test("each outcome is recorded with its PR, and the answer names both", async () => {
  let n = 0;
  for (const outcome of OUTCOMES) {
    const sid = "fin-" + outcome;
    hook({ session_id: sid, cwd: "/repo", hook_event_name: "UserPromptSubmit" });
    const before = finishes().length;
    const r = await call({ session_id: sid, outcome, pr_number: 355 + n++ });
    assert.equal(r.isError, undefined, r.content[0].text);
    assert.equal(r.content[0].text, "Marked " + outcome + ", PR #" + (354 + n) + ".");
    const e = finishes().slice(before);
    assert.equal(e.length, 1);
    accepted(e[0]);
    assert.equal(e[0].outcome, outcome);
  }
});

test("prNumber and pr work like pr_number; no PR says so", async () => {
  for (const [key, pr] of [["prNumber", 401], ["pr", 402]]) {
    hook({ session_id: "alias-" + key, cwd: "/repo", hook_event_name: "UserPromptSubmit" });
    const r = await call({ session_id: "alias-" + key, outcome: "ready", [key]: pr });
    assert.equal(r.content[0].text, "Marked ready, PR #" + pr + ".");
    assert.equal(finishes().at(-1).prNumber, pr);
  }
  hook({ session_id: "no-pr", cwd: "/repo", hook_event_name: "UserPromptSubmit" });
  const r = await call({ session_id: "no-pr", outcome: "abandoned" });
  assert.equal(r.content[0].text, "Marked abandoned, no PR.");
  accepted(finishes().at(-1));
});

test("wrong or missing fields are refused with what to use, and nothing is queued", async () => {
  hook({ session_id: "bad", cwd: "/repo", hook_event_name: "UserPromptSubmit" });
  const before = finishes().length;
  const cases = [
    [{ status: "ready", prNumber: 340 }, /^unknown field status; use outcome\./],
    [{}, /^outcome is required: ready, merged, blocked or abandoned$/],
    [{ outcome: "done" }, /outcome is required.*\(got "done"\)/],
    [{ outcome: "ready", pr_number: "340" }, /pr_number is the PR's number/],
    [{ outcome: "ready", pr_number: 1, pr: 2 }, /pass the PR once/],
    [{ outcome: "ready", colour: "blue" }, /^unknown field colour\. pipexp_finish takes outcome/],
  ];
  for (const [args, want] of cases) {
    const r = await call({ session_id: "bad", ...args });
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.content[0].text, want);
    assert.doesNotMatch(r.content[0].text, /undefined/);
  }
  assert.equal(finishes().length, before, "no refused call queues anything");
  assert.equal(finishProblem({ outcome: "ready", pr_number: 5, prNumber: 5 }), null, "the same PR under two names is fine");
});

test("a finish stays: the rest of that turn's hooks do not bring the card back; the next prompt does", async () => {
  const sid = "stays";
  hook({ session_id: sid, cwd: "/repo", hook_event_name: "UserPromptSubmit" });
  await call({ session_id: sid, outcome: "ready", pr_number: 343 });
  const before = outbox().length;
  // The tool call that ran pipexp_finish, then the turn's end: 144 ms later on the board (CMD-370).
  assert.deepEqual(hook({ session_id: sid, cwd: "/repo", hook_event_name: "PostToolUse", tool_name: "mcp__pipexp__pipexp_finish", tool_input: {} }), []);
  assert.deepEqual(hook({ session_id: sid, cwd: "/repo", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" } }), []);
  assert.deepEqual(hook({ session_id: sid, cwd: "/repo", hook_event_name: "Stop" }), []);
  assert.equal(outbox().length, before);
  // New work: the next prompt reopens it.
  const next = hook({ session_id: sid, cwd: "/repo", hook_event_name: "UserPromptSubmit" });
  assert.deepEqual(next.map((e) => e.type).filter((t) => t === "run.started"), ["run.started"]);
});
