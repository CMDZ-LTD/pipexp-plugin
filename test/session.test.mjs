import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ctx, probe } from "./helpers.mjs";
import { onHook, onReport, stageForTool, ticketOf, uuid5 } from "../core/session.mjs";
import { VERSION } from "../core/config.mjs";

const T0 = Date.parse("2026-09-25T10:00:00Z");
const MIN = 60_000;
const SID = "01a0da36-9343-7353-9749-98859e2a4764";
const base = { session_id: SID, cwd: "/repo", transcript_path: "/t.jsonl" };

/** Runs hooks in order: [minutesFromStart, hook fields]. Returns every event and the final state. */
function play(steps, c = {}) {
  let state = null;
  const events = [];
  for (const [min, hook] of steps) {
    const r = onHook(state, { ...base, ...hook }, ctx(T0 + min * MIN, c));
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
}
const brief = (events) => events.map((e) => e.type + (e.stage ? " " + e.stage : ""));

test("a plain Codex session: start, explore, build, test, PR, waiting, end", () => {
  const { events, state } = play([
    [0, { hook_event_name: "SessionStart", source: "startup" }],
    [0, { hook_event_name: "UserPromptSubmit", prompt: "fix login" }],
    [2, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "rg login" } }],
    [3, { hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: { command: "*** Begin Patch" } }],
    [5, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: "ok" }],
    [8, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "gh pr create --fill" }, tool_response: "https://github.com/acme/shop/pull/42" }],
    [9, { hook_event_name: "Stop", last_assistant_message: "done" }],
    [40, { hook_event_name: "SessionEnd", reason: "other" }],
  ]);
  assert.deepEqual(brief(events), [
    "run.started",
    "step.entered agent:S1",
    "usage.reported agent:S1",
    "step.entered agent:S2",
    "usage.reported agent:S2",
    "step.entered agent:S3",
    "usage.reported agent:S3",
    "step.entered agent:S4",
    "usage.reported agent:S4",
    "step.entered agent:S5",
    "run.finished",
  ]);
  const [started] = events;
  assert.equal(started.skill, "agent");
  assert.equal(started.runtime, "codex");
  assert.equal(started.ticket, "ABC-12");
  assert.equal(started.title, "shop · codex/abc-12-fix-login");
  assert.equal(started.pluginVersion, "pipexp " + VERSION);
  assert.equal(started.runtimeVersion, "codex 0.155.1");
  assert.equal(started.claim, "new");
  assert.equal(started.runId, uuid5("pipexp/session/" + SID));
  assert.ok(events.every((e) => e.runId === started.runId));
  assert.equal(new Set(events.map((e) => e.eventId)).size, events.length);
  assert.deepEqual(events.at(-1), { ...events.at(-1), type: "run.finished", outcome: "ready", prNumber: 42 });
  assert.equal(state.finished, true);
});

test("every event the hooks make matches the board's schema fixtures (lib/plugin-contract.test.ts)", () => {
  const fixtures = JSON.parse(readFileSync(new URL("./fixtures/board-contract.json", import.meta.url), "utf8"));
  const { events } = play([
    [0, { hook_event_name: "SessionStart", source: "startup" }],
    [3, { hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: {} }],
    [9, { hook_event_name: "Stop" }],
    [40, { hook_event_name: "SessionEnd", reason: "other" }],
  ]);
  for (const e of events) {
    const want = fixtures[e.type];
    assert.ok(want, "no fixture for " + e.type);
    const { _usage, agents, ...rest } = e;
    for (const key of Object.keys(rest)) assert.ok(key in want || ["ticket", "attemptId"].includes(key), e.type + " sends " + key + ", which the board fixture does not have");
  }
});

test("a session that ends after its turn is ready; one cut off mid-turn is abandoned", () => {
  const done = play([[0, { hook_event_name: "UserPromptSubmit" }], [2, { hook_event_name: "Stop" }], [40, { hook_event_name: "SessionEnd", reason: "other" }]]);
  assert.equal(done.events.at(-1).outcome, "ready");
  const cut = play([[0, { hook_event_name: "UserPromptSubmit" }], [2, { hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: {} }], [3, { hook_event_name: "SessionEnd", reason: "other" }]]);
  assert.equal(cut.events.at(-1).outcome, "abandoned");
});

test("a quick edit-test loop moves the card at most once a minute; a PR always moves it", () => {
  const { events } = play([
    [0, { hook_event_name: "UserPromptSubmit" }],
    [0.1, { hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: {} }],
    [0.2, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pnpm test" } }],
    [0.3, { hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: {} }],
    [0.4, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git push -u origin HEAD" } }],
  ]);
  assert.deepEqual(brief(events).filter((e) => e.startsWith("step")), ["step.entered agent:S1", "step.entered agent:S2", "step.entered agent:S4"]);
});

test("a long test run re-sends its stage every 30 minutes, so the card never shows Stalled", () => {
  const { events } = play([
    [0, { hook_event_name: "UserPromptSubmit" }],
    [1, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npx playwright test" } }],
    [20, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "sleep 600" } }],
    [32, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "gh run watch" } }],
  ]);
  assert.deepEqual(brief(events).slice(-2), ["step.entered agent:S3", "step.entered agent:S3"]);
});

test("the next prompt after the session was ended starts it again as a resume", () => {
  const { events, state } = play([
    [0, { hook_event_name: "UserPromptSubmit" }],
    [5, { hook_event_name: "SessionEnd", reason: "other" }],
    [90, { hook_event_name: "UserPromptSubmit" }],
  ]);
  assert.deepEqual(brief(events).slice(-3), ["run.finished", "run.started", "step.entered agent:S1"]);
  assert.equal(events.filter((e) => e.type === "run.started").at(-1).claim, "resume");
  assert.equal(state.finished, false);
});

test("three failing test runs in a row report a snag, once", () => {
  const fail = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 1, output: "FAIL" } };
  const { events } = play([[0, { hook_event_name: "UserPromptSubmit" }], [1, fail], [2, fail], [3, fail], [4, fail]]);
  const snags = events.filter((e) => e.type === "snag.reported");
  assert.equal(snags.length, 1);
  assert.equal(snags[0].theme, "checks failing");
  assert.equal(snags[0].costMin, null);
});

test("a session holding a Nudj ship claim is left to the ship skill; its guessed run is closed", () => {
  let claimed = false;
  const c = { probe: probe({ shipClaim: () => (claimed ? "NJ-3236" : null) }) };
  const first = play([[0, { hook_event_name: "UserPromptSubmit" }]], c);
  claimed = true;
  const plain = onHook(first.state, { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" } }, ctx(T0 + 2 * MIN, c));
  assert.equal(plain.state.shipOwned, false, "an ordinary tool call does not look for a claim");
  const r = onHook(plain.state, { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "bash .claude/skills/ship/scripts/claim-run.sh NJ-3236 " + SID } }, ctx(T0 + 5 * MIN, c));
  assert.deepEqual(brief(r.events), ["run.finished"]);
  assert.equal(r.events[0].outcome, "abandoned");
  const later = onHook(r.state, { ...base, hook_event_name: "Stop" }, ctx(T0 + 6 * MIN, c));
  assert.deepEqual(later.events, []);
});

test("a skill reporting ship stages moves the run into the ship lane, with its fingerprint; hooks stop guessing", () => {
  const start = play([[0, { hook_event_name: "UserPromptSubmit" }]]);
  const r = onReport(start.state, { type: "stage", stage: "ship:S1", ticket: "NJ-3236" }, ctx(T0 + MIN));
  assert.deepEqual(brief(r.events), ["usage.reported agent:S1", "run.started", "step.entered ship:S1"]);
  const [, started] = r.events;
  assert.equal(started.skill, "ship");
  assert.equal(started.ticket, "NJ-3236");
  assert.equal(started.skillVersion, "3.2.0");
  assert.equal(started.skillTree, "0123456789abcdef");
  assert.equal(started.runId, start.state.runId, "the session's card becomes the ship card");
  const tool = onHook(r.state, { ...base, hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: {} }, ctx(T0 + 5 * MIN));
  assert.deepEqual(tool.events, []);
  const next = onReport(tool.state, { type: "stage", stage: "ship:S4", fields: { counters: { reviewRound: 2 } } }, ctx(T0 + 9 * MIN));
  assert.deepEqual(brief(next.events), ["usage.reported ship:S1", "step.entered ship:S4"]);
  assert.deepEqual(next.events[1].counters, { reviewRound: 2 });
});

test("while ship's own scripts hold a claim on the session, a stage report adds nothing (no second card)", () => {
  const s = play([[0, { hook_event_name: "UserPromptSubmit" }]]).state;
  const r = onReport(s, { type: "stage", stage: "ship:S4", ticket: "NJ-1" }, ctx(T0 + MIN, { probe: probe({ shipClaim: () => "NJ-1" }) }));
  assert.deepEqual(r.events, []);
  assert.equal(r.state.shipOwned, true);
});

test("a second skill lane in one session is its own run, a child of the ship run (no ship scripts)", () => {
  let s = play([[0, { hook_event_name: "UserPromptSubmit" }]]).state;
  s = onReport(s, { type: "stage", stage: "ship:S8", ticket: "NJ-1" }, ctx(T0 + MIN)).state;
  const ship = s.runId;
  const r = onReport(s, { type: "stage", stage: "shepherd:S1" }, ctx(T0 + 2 * MIN));
  const started = r.events.find((e) => e.type === "run.started");
  assert.equal(started.skill, "shepherd");
  assert.notEqual(started.runId, ship);
  assert.equal(started.parentRunId, ship);
});

test("a takeover finishes the displaced task's run by its session id, in its lane, without resending its start", () => {
  const OLD = "01a0aaaa-0000-7000-8000-000000000001";
  const fresh = onHook(null, { session_id: OLD, cwd: "/repo", hook_event_name: "none" }, ctx(T0)).state;
  const r = onReport(fresh, { type: "run.finished", lane: "ship", ticket: "NJ-7", fields: { outcome: "abandoned" } }, ctx(T0 + MIN));
  assert.deepEqual(brief(r.events), ["run.finished"]);
  assert.equal(r.events[0].runId, uuid5("pipexp/session/" + OLD), "the same run the other task reported");
  assert.equal(r.events[0].skill, "ship");
  assert.equal(r.events[0].ticket, "NJ-7");
  assert.equal(r.events[0].prNumber, null);
});

test("a claim starts a new attempt: its run.started says takeover, and every later event carries the attempt", () => {
  const s = play([[0, { hook_event_name: "UserPromptSubmit" }]]).state;
  const first = onReport(s, { type: "stage", stage: "ship:S1", ticket: "NJ-9", claim: "new" }, ctx(T0 + MIN));
  const again = onReport(first.state, { type: "stage", stage: "ship:S1", claim: "takeover" }, ctx(T0 + 2 * MIN));
  const a1 = first.events.find((e) => e.type === "run.started").attemptId;
  const started = again.events.find((e) => e.type === "run.started");
  assert.ok(a1 && started.attemptId && a1 !== started.attemptId);
  assert.equal(started.claim, "takeover");
  const step = onReport(again.state, { type: "stage", stage: "ship:S2" }, ctx(T0 + 3 * MIN)).events.at(-1);
  assert.equal(step.attemptId, started.attemptId);
});

test("explicit reports: snag, gate, review and finish carry their own fields; finish reports usage first", () => {
  let s = onReport(play([[0, { hook_event_name: "UserPromptSubmit" }]]).state, { type: "stage", stage: "ship:S5" }, ctx(T0 + MIN)).state;
  const head = "f".repeat(40);
  const gate = onReport(s, { type: "gate.checked", fields: { gate: "gate-snapshot", head, verdict: "in_progress", reasons: ["2 required checks pending"] } }, ctx(T0 + 2 * MIN));
  assert.deepEqual(brief(gate.events), ["gate.checked"]);
  s = gate.state;
  const review = onReport(s, { type: "review.done", fields: { reviewer: "security", round: 1, dispatch: 1, head, verdict: "clean" } }, ctx(T0 + 3 * MIN));
  assert.equal(review.events[0].reviewer, "security");
  const fin = onReport(review.state, { type: "run.finished", fields: { outcome: "blocked", stopReason: "decision", question: "Refund points?" } }, ctx(T0 + 4 * MIN));
  assert.deepEqual(brief(fin.events), ["usage.reported ship:S5", "run.finished"]);
  assert.equal(fin.events[1].prNumber, null);
  assert.equal(fin.events[1].stopReason, "decision");
});

test("minimal content: no session names or branch names leave the machine", () => {
  const c = { content: "minimal", probe: probe({ threadName: () => "Fix Acme refunds for Big Customer" }) };
  const { events } = play([[0, { hook_event_name: "SessionStart", source: "startup" }]], c);
  assert.equal(events[0].title, "shop");
  assert.equal(events[0].branch, null);
});

test("ticket ids come from the start of a branch segment only", () => {
  assert.equal(ticketOf("codex/nj-3236-plugin"), "NJ-3236");
  assert.equal(ticketOf("feature/ABC-12"), "ABC-12");
  assert.equal(ticketOf("fix/utf-8-names"), null);
  assert.equal(ticketOf("main"), null);
  assert.equal(ticketOf("release-2026"), null);
});

test("tool calls map to stages; reads and searches do not move the card", () => {
  assert.equal(stageForTool("apply_patch", {}), "agent:S2");
  assert.equal(stageForTool("Edit", {}), "agent:S2");
  assert.equal(stageForTool("Bash", { command: "cargo test" }), "agent:S3");
  assert.equal(stageForTool("Bash", { command: "gh pr create" }), "agent:S4");
  assert.equal(stageForTool("Bash", { command: "cat README.md" }), null);
  assert.equal(stageForTool("mcp__fs__read", {}), null);
});

test("a failed push (no remote, no auth) does not move the card to Pull request", () => {
  const { events } = play([
    [0, { hook_event_name: "UserPromptSubmit" }],
    [1, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git push" }, tool_response: { exit_code: 128, output: "fatal: No configured push destination." } }],
  ]);
  assert.ok(!brief(events).includes("step.entered agent:S4"));
});

test("uuid5 matches Python's uuid5(NAMESPACE_URL, ...), so ids agree with the ship scripts", () => {
  // python3 -c 'import uuid; print(uuid.uuid5(uuid.NAMESPACE_URL, "run/abandoned"))'
  assert.equal(uuid5("run/abandoned"), "bd21981f-1f72-5ab1-89ef-2b75421d85c2");
});
