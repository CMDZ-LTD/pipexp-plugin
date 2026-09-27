// CMD-518 release blocker (Boss, #37 at 734fa036): after an explicit finish, the turn's real Stop must still say idle,
// and a delegated turn after a finish must show new work. Codex puts turn_id on UserPromptSubmit, PostToolUse and Stop
// (its hook input schemas require it), so a hook from the turn that finished is told apart from a new turn by turn_id.
import assert from "node:assert/strict";
import test from "node:test";
import { ctx, freshHome } from "./helpers.mjs";
import { onHook, onReport } from "../core/session.mjs";
freshHome();

const T0 = Date.parse("2026-09-27T21:00:00Z");
const MIN = 60_000;
const base = { session_id: "thread-finish", cwd: "/repo", transcript_path: "/t.jsonl" };
const hook = (s, fields, ms, c) => onHook(s, { ...base, ...fields }, ctx(T0 + ms, c));
const tool = (turn) => ({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, ...(turn && { turn_id: turn }) });

/** A turn t1 that reports a stage, works, then finishes explicitly with this outcome. */
function finishedIn(outcome, extra = {}, before) {
  let s = hook(null, { hook_event_name: "UserPromptSubmit", turn_id: "t1" }, 0).state;
  s = onReport(s, { type: "stage", stage: "ship:S4", ticket: "ABC-1" }, ctx(T0 + MIN)).state;
  s = hook(s, tool("t1"), 2 * MIN).state;
  if (before) s = onReport(s, before, ctx(T0 + 2.5 * MIN)).state;
  return onReport(s, { type: "run.finished", fields: { outcome, prNumber: 7, ...extra } }, ctx(T0 + 3 * MIN)).state;
}

test("finish, then the turn's Stop: an activity-only idle, the workflow stays finished with its outcome", () => {
  for (const outcome of ["ready", "merged", "abandoned"]) {
    const s = finishedIn(outcome);
    assert.equal(s.finished, true);
    const stop = hook(s, { hook_event_name: "Stop", turn_id: "t1" }, 4 * MIN);
    assert.deepEqual(stop.events.map((e) => e.type), ["activity.reported"], outcome);
    assert.equal(stop.events[0].activity.state, "idle");
    assert.equal(stop.events[0].activity.observedAt, new Date(T0 + 4 * MIN).toISOString());
    assert.equal(stop.state.finished, true);
    assert.equal(stop.state.stage, "ship:S4");
  }
});

test("finish while blocked or paused: Stop keeps that status and sends nothing", () => {
  const blocked = finishedIn("blocked", { question: "Needs a product decision" });
  const a = hook(blocked, { hook_event_name: "Stop", turn_id: "t1" }, 4 * MIN);
  assert.deepEqual(a.events, []);
  assert.equal(a.state.activity.state, "blocked");
  const paused = finishedIn("ready", {}, { type: "activity", state: "paused", note: "Waiting for review" });
  const b = hook(paused, { hook_event_name: "Stop", turn_id: "t1" }, 4 * MIN);
  assert.deepEqual(b.events, []);
  assert.equal(b.state.activity.state, "paused");
});

test("a trailing tool hook from the turn that finished changes nothing", () => {
  const s = finishedIn("ready");
  const late = hook(s, tool("t1"), 3.1 * MIN);
  assert.deepEqual(late.events, []);
  assert.equal(late.state.finished, true);
  // A runtime that names no turn cannot prove a new one: finished stays finished until a prompt.
  const unnamed = hook(s, tool(), 20 * MIN);
  assert.deepEqual(unnamed.events, []);
  assert.equal(unnamed.state.finished, true);
});

test("a delegated turn after a finish (no UserPromptSubmit) is Working at its first tool call, without reopening the workflow", () => {
  let s = finishedIn("ready");
  s = hook(s, { hook_event_name: "Stop", turn_id: "t1" }, 4 * MIN).state;
  const next = hook(s, tool("t2"), 30 * MIN);
  assert.deepEqual(next.events.map((e) => e.type), ["activity.reported"]);
  assert.equal(next.events[0].activity.state, "working");
  assert.equal(next.events[0].activity.observedAt, new Date(T0 + 30 * MIN).toISOString());
  assert.equal(next.state.finished, true, "the finished workflow keeps its outcome");
  // Busy in that turn: activity stays fresh (a beat within 4 minutes); the turn ends idle.
  const later = hook(next.state, tool("t2"), 35 * MIN);
  assert.equal(later.events.find((e) => e.type === "activity.reported")?.activity.observedAt, new Date(T0 + 35 * MIN).toISOString());
  const end = hook(later.state, { hook_event_name: "Stop", turn_id: "t2" }, 36 * MIN);
  assert.deepEqual(end.events.map((e) => e.activity?.state), ["idle"]);
  // A person did not write: no human turn counted.
  assert.equal(next.state.turns, s.turns);
});

test("R3: a hold (board stop, blocked, paused, waiting, reported idle) stays for its turn, and a delegated turn's first tool call clears it", () => {
  for (const [state, source] of [["paused", "hook"], ["blocked", "agent"], ["paused", "agent"], ["waiting", "agent"], ["idle", "agent"]]) {
    let s = hook(null, { hook_event_name: "UserPromptSubmit", turn_id: "t1" }, 0).state;
    s = onReport(s, { type: "stage", stage: "agent:S2" }, ctx(T0 + MIN)).state;
    s = onReport(s, { type: "activity", state, source, note: "Held for a reason" }, ctx(T0 + 2 * MIN)).state;
    // The same turn: the hold is kept by its tool calls and by its Stop.
    s = hook(s, tool("t1"), 3 * MIN).state;
    assert.equal(s.activity.state, state, state + " kept in its turn");
    s = hook(s, { hook_event_name: "Stop", turn_id: "t1" }, 4 * MIN).state;
    assert.equal(s.activity.state, state, state + " kept at its Stop");
    // A delegated turn: no prompt, a new turn id.
    const next = hook(s, tool("t2"), 20 * MIN);
    assert.equal(next.state.activity.state, "working", state + " cleared by a new turn");
    assert.equal(next.events.find((e) => e.type === "activity.reported")?.activity.state, "working");
  }
  // A runtime that names no turn keeps the hold until a prompt.
  let c = hook(null, { hook_event_name: "UserPromptSubmit" }, 0).state;
  c = onReport(c, { type: "activity", state: "paused", note: "Stopped from the board" }, ctx(T0 + MIN)).state;
  c = hook(c, { hook_event_name: "Stop" }, 2 * MIN).state;
  assert.equal(hook(c, tool(), 20 * MIN).state.activity.state, "paused");
});

test("R3: a session id the board would refuse is left off the event, never the event itself", () => {
  for (const id of ["thread:1", "a/b", "x".repeat(101), "ok id"]) {
    const r = onHook(null, { ...base, session_id: id, hook_event_name: "UserPromptSubmit", turn_id: "t1" }, ctx(T0));
    assert.ok(r.events.length > 0);
    assert.ok(r.events.every((e) => !("sessionId" in e)), id);
  }
  const ok = onHook(null, { ...base, session_id: "01a0da36-9343.thread_1", hook_event_name: "UserPromptSubmit" }, ctx(T0));
  assert.ok(ok.events.every((e) => e.sessionId === "01a0da36-9343.thread_1"));
});

test("no event carries an observation later than itself", () => {
  let s = hook(null, { hook_event_name: "UserPromptSubmit", turn_id: "t1" }, 10 * MIN).state;
  // A report made at an earlier moment than the last hook (clocks, a queued call): its event leaves the activity off.
  const r = onReport(s, { type: "snag.reported", fields: { kind: "snag", theme: "t", what: "w" } }, ctx(T0 + 5 * MIN));
  for (const e of r.events) assert.ok(!e.activity || Date.parse(e.activity.observedAt) <= Date.parse(e.occurredAt), e.type);
});
test("R5: a repeated start on the same branch keeps the PR linked; only the change of checkout sends prNumber null, once", () => {
  let branch = "codex/abc-1-first";
  const c = (ms) => ctx(T0 + ms, { probe: { ...ctx(0).probe, git: () => ({ branch, repo: "shop" }), pr: () => null } });
  let s = onHook(null, { ...base, hook_event_name: "UserPromptSubmit", turn_id: "t1" }, c(0)).state;
  s.prNumber = 42;
  // The checkout changes: the old branch's PR is dropped, once.
  branch = "codex/abc-2-second";
  let r = onHook(s, { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git checkout -b codex/abc-2-second" }, turn_id: "t1" }, c(MIN));
  const first = r.events.filter((e) => e.type === "run.started");
  assert.equal(first.length, 1);
  assert.equal(first[0].prNumber, null);
  // The board links this branch's PR by itself; the machine's lookup finds nothing. Later starts on the same branch
  // (a resumed session, a renamed thread) must not unlink it.
  for (const [ms, hook] of [[10 * MIN, { hook_event_name: "SessionStart", source: "resume" }], [20 * MIN, { hook_event_name: "UserPromptSubmit", turn_id: "t2" }]]) {
    r = onHook(r.state, { ...base, ...hook }, c(ms));
    for (const e of r.events.filter((e) => e.type === "run.started")) assert.ok(!("prNumber" in e), hook.hook_event_name + " sent prNumber " + e.prNumber);
  }
});
test("R5, Boss: a new ticket with no PR clears the PR once; repeating the same work keeps whatever PR is linked", () => {
  let s = onHook(null, { ...base, hook_event_name: "UserPromptSubmit", turn_id: "t1" }, ctx(T0)).state;
  s = onReport(s, { type: "stage", stage: "ship:S4", ticket: "ABC-1" }, ctx(T0 + MIN)).state;
  s.prNumber = 7;
  // Real new work: the old ticket's PR is cleared.
  let r = onReport(s, { type: "stage", stage: "ship:S4", ticket: "ABC-2" }, ctx(T0 + 2 * MIN));
  assert.equal(r.events.find((e) => e.type === "run.started")?.prNumber, null);
  // The same work again (same ticket, same stage, a resumed session): nothing unlinks the PR the board has.
  for (const [ms, next] of [[3 * MIN, (st, c) => onReport(st, { type: "stage", stage: "ship:S4", ticket: "ABC-2" }, c)],
    [4 * MIN, (st, c) => onHook(st, { ...base, hook_event_name: "SessionStart", source: "resume" }, c)],
    [5 * MIN, (st, c) => onReport(st, { type: "activity", state: "working", ticket: "ABC-2" }, c)]]) {
    r = next(r.state, ctx(T0 + ms));
    for (const e of r.events) assert.ok(!("prNumber" in e && e.prNumber === null && e.type === "run.started"), "repeat at " + ms / MIN + " min cleared the PR");
  }
});
