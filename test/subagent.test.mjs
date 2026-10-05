// CMD-535 (NJ-3454, 4 Oct): Codex runs each subagent as its own thread that reports hooks under the parent's session_id,
// with its own turn_id and its own transcript. Those turns took over the session's turn, so the parent's own tool calls
// were then dropped as late hooks and the card froze while the chat worked; a subagent's Stop also ended the parent's turn.
import assert from "node:assert/strict";
import test from "node:test";
import { ctx, freshHome } from "./helpers.mjs";
import { onHook } from "../core/session.mjs";
freshHome();

const T0 = Date.parse("2026-10-04T09:04:00Z");
const MIN = 60_000;
const PARENT = "01a10328-2afe-7071-a5aa-085c223cd35a";
const CHILD = "01a10629-c5d6-7571-accc-f946b86dd995";
const parentPath = "/Users/x/.codex/sessions/2026/10/03/rollout-2026-10-03T20-05-26-" + PARENT + ".jsonl";
const childPath = "/Users/x/.codex/sessions/2026/10/04/rollout-2026-10-04T10-06-03-" + CHILD + ".jsonl";
const parent = (fields, ms) => [{ session_id: PARENT, cwd: "/repo", transcript_path: parentPath, ...fields }, ms];
const child = (fields, ms) => [{ session_id: PARENT, cwd: "/repo", transcript_path: childPath, ...fields }, ms];
const tool = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } };
const run = (s, [input, ms]) => onHook(s, input, ctx(T0 + ms));

function withSubagent() {
  let s = run(null, parent({ hook_event_name: "UserPromptSubmit", turn_id: "t1" }, 0)).state;
  s = run(s, parent({ ...tool, turn_id: "t1" }, MIN)).state;
  s = run(s, child({ hook_event_name: "UserPromptSubmit", turn_id: "s1" }, 2 * MIN)).state;
  s = run(s, child({ ...tool, turn_id: "s1" }, 3 * MIN)).state;
  return run(s, child({ hook_event_name: "Stop", turn_id: "s1" }, 4 * MIN)).state;
}

test("a subagent's turn never takes over the parent's: the parent's next tool call still counts", () => {
  const s = withSubagent();
  assert.equal(s.turnId, "t1");
  assert.equal(s.transcriptPath, parentPath, "usage reads the parent's transcript, which finds its subagents itself");
  assert.equal(s.turns, 1, "a subagent's prompt is not a person's");
  assert.equal(s.inTurn, true, "a subagent's Stop does not end the parent's turn");
  assert.equal(s.activity.state, "working");
  const r = run(s, parent({ ...tool, turn_id: "t1" }, 9 * MIN));
  assert.equal(r.state.lastSeenAt, T0 + 9 * MIN);
  assert.ok(r.events.length > 0, "the parent's tool call reaches the board");
});

test("a subagent's tool call keeps the parent's card alive", () => {
  const s = withSubagent();
  const r = run(s, child({ ...tool, turn_id: "s1" }, 9 * MIN));
  assert.equal(r.state.lastSeenAt, T0 + 9 * MIN);
  assert.equal(r.state.turnId, "t1");
  assert.ok(r.events.length > 0);
});

test("a session a subagent already took over recovers at the parent's next hook", () => {
  // State as 0.1.22 left it: the subagent's turn current, the parent's past, its transcript in place of the parent's.
  let s = run(null, parent({ hook_event_name: "UserPromptSubmit", turn_id: "t1" }, 0)).state;
  s = { ...s, turnId: "s1", pastTurns: ["t1"], transcriptPath: childPath };
  const r = run(s, parent({ ...tool, turn_id: "t1" }, 9 * MIN));
  assert.equal(r.state.lastSeenAt, T0 + 9 * MIN);
  assert.equal(r.state.turnId, "t1");
  assert.equal(r.state.transcriptPath, parentPath);
  assert.ok(r.events.length > 0);
});

test("other runtimes' transcripts are left alone", () => {
  const s = onHook(null, { session_id: "abc", cwd: "/repo", transcript_path: "/t.jsonl", hook_event_name: "UserPromptSubmit", turn_id: "t1" }, ctx(T0)).state;
  const r = onHook(s, { session_id: "abc", cwd: "/repo", transcript_path: "/t.jsonl", ...tool, turn_id: "t2" }, ctx(T0 + MIN));
  assert.equal(r.state.turnId, "t2");
});
test("a subagent's tool call after the chat's turn ended does not reopen it", () => {
  let s = withSubagent();
  s = run(s, parent({ hook_event_name: "Stop", turn_id: "t1" }, 5 * MIN)).state;
  assert.equal(s.activity.state, "idle");
  const r = run(s, child({ ...tool, turn_id: "s1" }, 6 * MIN));
  assert.equal(r.state.activity.state, "idle", "the chat waits for its person, whatever a subagent still does");
  assert.deepEqual(r.events, []);
});

test("a subagent's own ship claim is not adopted by the chat", () => {
  let s = withSubagent();
  s = run(s, parent({ ...tool, turn_id: "t1" }, 5 * MIN)).state;
  const r = run(s, child({ ...tool, tool_input: { command: "bash .claude/skills/ship/scripts/claim-run.sh NJ-3501 " + CHILD }, turn_id: "s1" }, 6 * MIN));
  assert.equal(r.state.shipTask ?? null, null);
});
