// CMD-518, before release (the Boss): the one-line work note survives the same work's hooks, and a machine upgraded from
// 0.1.18 starts sending status at its first work after the board is read again, without a manual pipexp stages.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { ctx, freshHome } from "./helpers.mjs";

const home = freshHome();
process.env.PIPEXP_RUNTIME = "codex";
const { onHook, onReport } = await import("../core/session.mjs");
const { hook, loadSession, stagesDue } = await import("../core/run.mjs");
const { queued } = await import("../core/queue.mjs");
const { stagesFor, startContext } = await import("../core/stages.mjs");

const T0 = Date.parse("2026-09-27T23:00:00Z");
const MIN = 60_000;
const base = { session_id: "note", cwd: "/repo", transcript_path: "/t.jsonl" };
const tool = (turn, command = "npm test") => ({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, turn_id: turn });

test("the work note stays through the same work's hooks and beats, and goes on a new turn, a stage, a branch or a new status", () => {
  let s = onHook(null, { ...base, hook_event_name: "UserPromptSubmit", turn_id: "t1" }, ctx(T0)).state;
  s = onReport(s, { type: "activity", state: "working", note: "Fixing the login redirect" }, ctx(T0 + MIN)).state;
  const events = [];
  for (let m = 2; m <= 12; m += 1) {
    const r = onHook(s, { ...base, ...tool("t1") }, ctx(T0 + m * MIN));
    s = r.state;
    events.push(...r.events);
  }
  assert.equal(s.activity.note, "Fixing the login redirect", "kept through the same work's tool calls");
  const beats = events.filter((e) => e.type === "activity.reported");
  assert.ok(beats.length >= 2);
  assert.ok(beats.every((e) => e.activity.note === "Fixing the login redirect"), "every beat carries it");
  // Never taken from what the tools ran or returned.
  assert.ok(events.every((e) => !JSON.stringify(e).includes("npm test")));
  // Cleared by: a new turn, a stage report, a branch switch, an explicit status.
  const noted = s;
  assert.equal(onHook(noted, { ...base, ...tool("t2") }, ctx(T0 + 20 * MIN)).state.activity.note, undefined, "new turn");
  assert.equal(onReport(noted, { type: "stage", stage: "agent:S3" }, ctx(T0 + 20 * MIN)).state.activity.note, undefined, "stage");
  assert.equal(onReport(noted, { type: "activity", state: "working" }, ctx(T0 + 20 * MIN)).state.activity.note, undefined, "status");
  const moved = onHook(noted, { ...base, ...tool("t1", "git checkout -b codex/abc-9-other") }, ctx(T0 + 20 * MIN, { probe: { ...ctx(0).probe, git: () => ({ branch: "codex/abc-9-other", repo: "shop" }) } }));
  assert.equal(moved.state.activity.note, undefined, "branch switch");
  // Minimal content: no note is kept at all.
  const min = onReport(onHook(null, { ...base, session_id: "min", hook_event_name: "UserPromptSubmit", turn_id: "t1" }, ctx(T0, { content: "minimal" })).state,
    { type: "activity", state: "working", note: "Private work" }, ctx(T0 + MIN, { content: "minimal" }));
  assert.equal(min.state.activity.note, undefined);
});

function repoDir() {
  const dir = mkdtempSync(join(tmpdir(), "pipexp-upgrade-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/acme/upgraded"]);
  return dir;
}

test("upgraded from 0.1.18: a fresh cache with no capabilities is read again at the next hook, and the first work after sends status", async () => {
  const dir = repoDir();
  // What 0.1.18 wrote a minute ago: lanes, content level and time, no capabilities.
  mkdirSync(join(home, "state", "stages"), { recursive: true });
  writeFileSync(join(home, "state", "stages", "acme_upgraded.json"), JSON.stringify({
    lanes: [{ skill: "agent", label: "Agent sessions", stages: [{ id: "agent:S2", label: "Build" }] }], contentLevel: "standard", at: new Date(Date.now() - MIN).toISOString(),
  }));
  assert.equal(startContext(dir).stale, true, "no capabilities: read the board once more, however fresh");
  const sid = "upgraded";
  // A long-lived thread: no SessionStart after the upgrade, only its next tool calls.
  hook({ session_id: sid, cwd: dir, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, turn_id: "t1" });
  assert.equal(stagesDue({ session_id: sid, cwd: dir, hook_event_name: "PostToolUse" }), dir, "any hook asks the flush to read the board");
  assert.equal(loadSession(sid).activitySent, undefined, "an observation the old board could not take is not marked sent");
  // The flush reads the board (what PIPEXP_STAGES_CWD makes it do); the board now takes activity.
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ lanes: [{ skill: "agent", label: "Agent sessions", stages: [{ id: "agent:S2", label: "Build" }] }], contentLevel: "standard", capabilities: ["agent-activity-v1"] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.PIPEXP_URL = "http://127.0.0.1:" + server.address().port;
  process.env.PIPEXP_KEY = "k".repeat(30);
  try {
    await stagesFor(dir);
  } finally {
    await new Promise((r) => server.close(r));
    delete process.env.PIPEXP_URL;
    delete process.env.PIPEXP_KEY;
  }
  assert.equal(stagesDue({ session_id: sid, cwd: dir, hook_event_name: "PostToolUse" }), null, "read once, not again");
  const i = queued().length;
  hook({ session_id: sid, cwd: dir, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, turn_id: "t1" });
  const sent = queued().slice(i).find((e) => e.activity?.state === "working");
  assert.ok(sent, "the next work sends status straight away: " + queued().slice(i).map((e) => e.type).join(", "));
  assert.equal(sent.sessionId, sid);
});

