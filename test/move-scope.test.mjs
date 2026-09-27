// CMD-518: moving a real session to another project's repo, through the one path the MCP tools and the CLI share
// (core/run.mjs explicitReport). The destination is confirmed with the board first; a refusal moves and sends nothing.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { freshHome } from "./helpers.mjs";

const home = freshHome();
process.env.PIPEXP_RUNTIME = "codex";
const { explicitReport, hook, loadSession, sessionFile } = await import("../core/run.mjs");
const { queued } = await import("../core/queue.mjs");
const { stagesFor } = await import("../core/stages.mjs");
const { uuid5 } = await import("../core/session.mjs");

// The board: per repo, the status /plugin/config answers and the project's content level.
const boards = {};
const lanes = ["agent", "ship", "fix-pr-comments", "manager"].map((skill) => ({ skill, label: skill, stages: [1, 2, 3, 4, 5].map((n) => ({ id: skill + ":S" + n, label: "S" + n })) }));
const server = createServer((req, res) => {
  const repo = new URL(req.url, "http://x").searchParams.get("repo");
  const b = boards[repo] ?? { status: 403 };
  res.writeHead(b.status, { "content-type": "application/json" });
  res.end(JSON.stringify(b.status === 200 ? { lanes, contentLevel: b.content ?? "standard", capabilities: ["agent-activity-v1"] } : { error: "Project not found" }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
test.after(() => new Promise((r) => server.close(r)));
const board = "http://127.0.0.1:" + server.address().port;
process.env.PIPEXP_URL = board;
process.env.PIPEXP_KEY = "k".repeat(30);

let n = 0;
function repo(name) {
  const dir = mkdtempSync(join(tmpdir(), "pipexp-scope-"));
  execFileSync("git", ["init", "-q", "-b", "codex/abc-" + ++n + "-work", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/acme/" + name]);
  return dir;
}
const since = (i) => queued().slice(i);
const saved = (sid) => readFileSync(sessionFile(sid), "utf8");
async function start(sid, dir, stage = "agent:S2", ticket = "ABC-1") {
  await stagesFor(dir);
  hook({ session_id: sid, cwd: dir, hook_event_name: "UserPromptSubmit", turn_id: "t1" });
  const r = await explicitReport(sid, { type: "stage", stage, ticket }, dir);
  assert.equal(r.error, undefined, r.error);
  return loadSession(sid);
}

test("a destination the board refuses (key not allowed, no such project, archived, expired key, error, offline) moves and sends nothing", async () => {
  const a = repo("a1");
  boards["acme/a1"] = { status: 200 };
  const sid = "refused";
  await start(sid, a);
  const b = repo("b1");
  // The board answers "Project not found" (403) alike for a key that may not report there, a missing and an archived project.
  for (const answer of [403, 401, 500, "offline"]) {
    const before = queued().length;
    const state = saved(sid);
    if (answer === "offline") process.env.PIPEXP_URL = "http://127.0.0.1:9";
    else boards["acme/b1"] = { status: answer };
    const stage = await explicitReport(sid, { type: "stage", stage: "agent:S3" }, b);
    const status = await explicitReport(sid, { type: "activity", state: "blocked", note: "CI red" }, b);
    process.env.PIPEXP_URL = board;
    for (const r of [stage, status]) assert.match(r.error ?? "", /Nothing was moved/, String(answer));
    assert.equal(queued().length, before, answer + ": no event");
    assert.equal(saved(sid), state, answer + ": the session is as it was");
  }
});

test("each project's own content level: the old run's events as standard, the new run's as minimal", async () => {
  const a = repo("a2");
  const b = repo("b2");
  boards["acme/a2"] = { status: 200, content: "standard" };
  boards["acme/b2"] = { status: 200, content: "minimal" };
  const sid = "levels";
  const old = await start(sid, a);
  assert.ok((await explicitReport(sid, { type: "activity", state: "paused", note: "Review on the old repo" }, a)).state);
  const i = queued().length;
  const r = await explicitReport(sid, { type: "activity", state: "blocked", note: "Private reason in the new repo" }, b);
  assert.equal(r.error, undefined, r.error);
  const events = since(i);
  const oldEvents = events.filter((e) => e.runId === old.runId);
  const newEvents = events.filter((e) => e.runId === loadSession(sid).runId);
  assert.ok(oldEvents.length && newEvents.length);
  assert.ok(oldEvents.every((e) => e.repo === "acme/a2"));
  assert.equal(oldEvents.find((e) => e.type === "run.finished").activity.note, "Review on the old repo", "standard keeps the reason");
  const started = newEvents.find((e) => e.type === "run.started");
  assert.equal(started.branch, null, "minimal: no branch");
  assert.equal(started.owner, null, "minimal: no owner");
  assert.ok(newEvents.every((e) => e.repo === "acme/b2" && e.activity?.note === undefined), "minimal: no reason");
});

test("to B and back to A: each run stays in its project, and coming back starts a new run in A", async () => {
  const a = repo("a3");
  const b = repo("b3");
  boards["acme/a3"] = { status: 200 };
  boards["acme/b3"] = { status: 200 };
  const sid = "back";
  const a0 = (await start(sid, a)).runId;
  const i = queued().length;
  await explicitReport(sid, { type: "stage", stage: "agent:S3", ticket: "ABC-2" }, b);
  const b0 = loadSession(sid).runId;
  await explicitReport(sid, { type: "stage", stage: "agent:S4", ticket: "ABC-3" }, a);
  const a1 = loadSession(sid).runId;
  assert.equal(new Set([a0, b0, a1]).size, 3);
  const events = since(i);
  const repoOf = { [a0]: "acme/a3", [b0]: "acme/b3", [a1]: "acme/a3" };
  assert.ok(events.every((e) => e.repo === repoOf[e.runId]), "every event names its run's own repo");
  assert.deepEqual(events.filter((e) => e.runId === a0).map((e) => e.type), ["usage.reported", "run.finished"]);
  assert.equal(events.filter((e) => e.runId === b0).at(-1).type, "run.finished");
  assert.equal(loadSession(sid).sessionId, sid);
});

test("a late hook from a turn before the move changes nothing on the new run", async () => {
  const a = repo("a4");
  const b = repo("b4");
  boards["acme/a4"] = { status: 200 };
  boards["acme/b4"] = { status: 200 };
  const sid = "late";
  await start(sid, a);
  // The next turn (delegated: no prompt), where the work moves.
  hook({ session_id: sid, cwd: a, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, turn_id: "t2" });
  await explicitReport(sid, { type: "stage", stage: "agent:S2", ticket: "ABC-9" }, b);
  const moved = loadSession(sid);
  const file0 = saved(sid);
  const i = queued().length;
  hook({ session_id: sid, cwd: a, hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: {}, turn_id: "t1" });
  hook({ session_id: sid, cwd: a, hook_event_name: "Stop", turn_id: "t1" });
  assert.deepEqual(since(i), []);
  assert.equal(saved(sid), file0, "the session file is as it was");
  assert.equal(loadSession(sid).stage, moved.stage);
  assert.equal(loadSession(sid).activity.observedAt, moved.activity.observedAt);
  // The current turn still reports on the new run, in the new repo.
  hook({ session_id: sid, cwd: a, hook_event_name: "Stop", turn_id: "t2" });
  const now = since(i);
  assert.ok(now.length && now.every((e) => e.runId === moved.runId && e.repo === "acme/b4"));
});

test("several skill runs in one session: the current one ends in the old project, an earlier one is left alone, and new lane runs in B never reuse an id from A", async () => {
  const a = repo("a5");
  const b = repo("b5");
  boards["acme/a5"] = { status: 200 };
  boards["acme/b5"] = { status: 200 };
  const sid = "lanes";
  await start(sid, a, "fix-pr-comments:S2", "ABC-5");
  await explicitReport(sid, { type: "stage", stage: "ship:S4" }, a);
  const inA = loadSession(sid);
  const shipA = inA.runs.ship;
  const fixA = inA.runs["fix-pr-comments"];
  assert.ok(shipA && fixA && shipA !== fixA);
  const i = queued().length;
  await explicitReport(sid, { type: "stage", stage: "fix-pr-comments:S3" }, b);
  await explicitReport(sid, { type: "stage", stage: "ship:S5" }, b);
  const events = since(i);
  assert.equal(events.filter((e) => e.runId === fixA).length, 0, "the earlier fix-pr-comments run is left alone");
  assert.deepEqual(events.filter((e) => e.runId === shipA).map((e) => e.type), ["usage.reported", "run.finished"]);
  const inB = new Set(events.filter((e) => e.repo === "acme/b5").map((e) => e.runId));
  assert.equal(inB.size, 2);
  for (const id of inB) assert.ok(id !== shipA && id !== fixA && id !== inA.runId, "a run id in B is new");
  assert.ok(events.every((e) => (e.repo === "acme/a5") === [shipA, fixA].includes(e.runId)));
});

function mcp(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL("../mcp/server.mjs", import.meta.url).pathname], {
      env: { PATH: process.env.PATH, PIPEXP_HOME: home, PIPEXP_NO_FLUSH: "1", PIPEXP_TEST: "1", PIPEXP_URL: board, PIPEXP_KEY: process.env.PIPEXP_KEY },
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
function cli(sid, cwd, stage) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [new URL("../bin/pipexp.mjs", import.meta.url).pathname, "stage", stage, "--session", sid], {
      cwd, env: { PATH: process.env.PATH, PIPEXP_HOME: home, PIPEXP_NO_FLUSH: "1", PIPEXP_TEST: "1", PIPEXP_URL: board, PIPEXP_KEY: process.env.PIPEXP_KEY, PIPEXP_RUNTIME: "codex" },
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => resolve({ code, err: err.trim() }));
  });
}
const shape = (events, sid, a, b) => events.map((e) => [e.type, e.repo, e.runId === a ? "old" : e.runId === uuid5("pipexp/session/" + sid + "/repo/" + b) ? "new" : "other"].join(" "));

test("the CLI and the MCP tool give the same result for the same move: refused alike, then moved alike", async () => {
  const a = repo("a6");
  const b = repo("b6");
  boards["acme/a6"] = { status: 200 };
  boards["acme/b6"] = { status: 403 };
  const one = await start("via-mcp", a);
  const two = await start("via-cli", a);
  let i = queued().length;
  const m = await mcp({ session_id: "via-mcp", cwd: b, stage: "agent:S3" });
  const c = await cli("via-cli", b, "agent:S3");
  assert.equal(m.isError, true);
  assert.equal(c.code, 0, "a script is never failed");
  assert.equal("pipexp: " + m.content[0].text, c.err);
  assert.match(c.err, /Nothing was moved/);
  assert.equal(queued().length, i);
  boards["acme/b6"] = { status: 200 };
  i = queued().length;
  const m2 = await mcp({ session_id: "via-mcp", cwd: b, stage: "agent:S3" });
  const j = queued().length;
  const c2 = await cli("via-cli", b, "agent:S3");
  assert.equal(m2.isError, undefined, JSON.stringify(m2));
  assert.equal(c2.err, "");
  const viaMcp = shape(queued().slice(i, j), "via-mcp", one.runId, "acme/b6");
  const viaCli = shape(queued().slice(j), "via-cli", two.runId, "acme/b6");
  assert.deepEqual(viaCli, viaMcp);
  assert.ok(viaMcp.includes("run.finished acme/a6 old") && viaMcp.includes("run.started acme/b6 new"), viaMcp.join("; "));
});

function event(sid, cwd, type, json) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [new URL("../bin/pipexp.mjs", import.meta.url).pathname, "event", type, "--session", sid, "--json", JSON.stringify(json)], {
      cwd, env: { PATH: process.env.PATH, PIPEXP_HOME: home, PIPEXP_NO_FLUSH: "1", PIPEXP_TEST: "1", PIPEXP_URL: board, PIPEXP_KEY: process.env.PIPEXP_KEY, PIPEXP_RUNTIME: "codex" },
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => resolve({ code, err: err.trim() }));
  });
}
function tool(name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL("../mcp/server.mjs", import.meta.url).pathname], {
      env: { PATH: process.env.PATH, PIPEXP_HOME: home, PIPEXP_NO_FLUSH: "1", PIPEXP_TEST: "1", PIPEXP_URL: board, PIPEXP_KEY: process.env.PIPEXP_KEY },
    });
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

test("Boss: a raw snag, gate or finish from another repo's folder never moves the session and is refused, with no event", async () => {
  const a = repo("a7");
  const b = repo("b7");
  boards["acme/a7"] = { status: 200 };
  boards["acme/b7"] = { status: 200 };
  const sid = "raw-events";
  const before = await start(sid, a);
  const i = queued().length;
  const file = saved(sid);
  const says = /Nothing was sent.*pipexp stage.*pipexp activity/;
  for (const [type, json] of [["snag.reported", { kind: "snag", theme: "ci", what: "Runner timed out", costMin: 5 }], ["gate.checked", { gate: "ci", result: "pass" }], ["run.finished", { outcome: "ready", prNumber: 7 }]]) {
    const r = await event(sid, b, type, json);
    assert.equal(r.code, 0, type + ": a script is never failed");
    assert.match(r.err, says, type);
  }
  for (const [name, args] of [["pipexp_report_snag", { what: "Flaky test" }], ["pipexp_finish", { outcome: "ready" }]]) {
    const r = await tool(name, { session_id: sid, cwd: b, ...args });
    assert.equal(r.isError, true, name);
    assert.match(r.content[0].text, says, name);
  }
  assert.deepEqual(since(i), [], "nothing queued, in either project");
  assert.equal(saved(sid), file);
  assert.equal(loadSession(sid).runId, before.runId);
  // The same events from the session's own repo, or from a folder that is no repository, still go to its run.
  const plain = mkdtempSync(join(tmpdir(), "pipexp-plain-"));
  for (const where of [a, plain]) {
    const r = await event(sid, where, "snag.reported", { kind: "snag", theme: "ci", what: "Runner timed out", costMin: 5 });
    assert.equal(r.err, "");
  }
  const sent = since(i);
  assert.equal(sent.filter((e) => e.type === "snag.reported").length, 2);
  assert.ok(sent.every((e) => e.runId === before.runId && e.repo === "acme/a7"));
  assert.ok(!realpathSync(loadSession(sid).cwd).startsWith(realpathSync(plain)), "a plain folder does not pin the session");
});
