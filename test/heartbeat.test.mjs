// CMD-518: activity stays fresh without flooding a run's history (the board keeps 2,000 events per run, and after a 429
// the plugin sends only run.finished), follows what hooks really observed, and never finishes or idles a workflow.
import assert from "node:assert/strict";
import test from "node:test";
import { ctx, freshHome } from "./helpers.mjs";
import { onHook, onIdle, onReport } from "../core/session.mjs";
freshHome();

const T0 = Date.parse("2026-09-27T09:00:00Z");
const MIN = 60_000;
const input = { session_id: "thread-beat", cwd: "/repo", transcript_path: "/t.jsonl" };
// The board's rule (PipeXP #520 lib/agent-activity.ts ACTIVITY_FRESH_MS, lib/agent-lanes.ts agentState): "working"
// observed more than 5 minutes ago reads as Unverified.
const FRESH_MS = 5 * MIN;
const tool = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "rg x" } };

function play(state, steps) {
  const events = [];
  for (const [ms, hook, c] of steps) {
    const r = onHook(state, { ...input, ...hook }, ctx(T0 + ms, c));
    state = r.state;
    events.push(...r.events.map((e) => ({ ...e, at: T0 + ms })));
  }
  return { state, events };
}
const reported = (s) => onReport(onHook(null, { ...input, hook_event_name: "UserPromptSubmit" }, ctx(T0)).state, { type: "stage", stage: "agent:S2" }, ctx(T0)).state;

test("a busy 10-hour turn keeps working fresh with a bounded number of events", () => {
  // A tool call every 30 s for 10 hours: 1,200 hooks.
  const steps = Array.from({ length: 1200 }, (_, i) => [(i + 1) * 30_000, tool]);
  const { events } = play(reported(), steps);
  // At most one activity beat per 4 minutes and one stage heartbeat per 30 minutes: well under the run's 2,000 cap.
  assert.ok(events.length <= 10 * (15 + 2) + 5, events.length + " events in 10 hours");
  // Fresh the whole time: no gap between observations the board receives is longer than its 5-minute window.
  const seen = events.filter((e) => e.activity?.state === "working").map((e) => Date.parse(e.activity.observedAt));
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] - seen[i - 1] < FRESH_MS, "gap of " + (seen[i] - seen[i - 1]) / MIN + " min");
  // Every observation is a real hook's time, never a made-up one.
  assert.ok(events.every((e) => !e.activity || Date.parse(e.activity.observedAt) <= e.at));
});

test("activity heartbeats stop at a per-run budget, so a run that works for days never reaches the board's cap", () => {
  const steps = Array.from({ length: 6000 }, (_, i) => [(i + 1) * 30_000, tool]); // 50 hours
  const { events } = play(reported(), steps);
  const beats = events.filter((e) => e.type === "activity.reported").length;
  assert.ok(beats <= 300, beats + " activity beats");
  assert.ok(events.length < 1000, events.length + " events in 50 hours");
});

test("a board without activity support gets no activity beats", () => {
  const steps = Array.from({ length: 120 }, (_, i) => [(i + 1) * 30_000, tool, { activity: false }]);
  const { events } = play(reported(), steps);
  assert.equal(events.filter((e) => e.type === "activity.reported").length, 0);
});

test("a delegated turn (no UserPromptSubmit) shows Working at its first observed tool call", () => {
  // The last turn ended; the next one arrives as a message from another thread, so Codex runs no UserPromptSubmit.
  let { state } = play(reported(), [[30_000, { hook_event_name: "Stop" }]]);
  assert.equal(state.activity.state, "idle");
  const { events } = play(state, [[40_000, tool]]);
  const working = events.find((e) => e.activity?.state === "working");
  assert.ok(working, "the first tool call reports working");
  assert.equal(working.activity.observedAt, new Date(T0 + 40_000).toISOString());
});

test("a long tool call with no hook sends nothing, so the board reads its last working as stale, not fresh", () => {
  const start = onReport(onHook(null, { ...input, hook_event_name: "UserPromptSubmit" }, ctx(T0)).state, { type: "stage", stage: "agent:S2" }, ctx(T0));
  // What the board last received: working, observed at the stage report.
  const last = Date.parse(start.events.filter((e) => e.activity).at(-1).activity.observedAt);
  const { state, events } = play(start.state, [[MIN, tool]]);
  assert.equal(events.length, 0, "a tool call a minute later adds nothing: working was sent a minute ago");
  // A 12-minute test run: no hook fires. The flush's idle sweep may run meanwhile; it invents no observation.
  const swept = onIdle(state, T0 + 13 * MIN);
  assert.equal(swept.events.length, 0);
  assert.equal(swept.state.activitySentAt, last);
  assert.ok(T0 + 13 * MIN - last > FRESH_MS, "the board shows this as Unverified");
  // When the tool call ends, the new observation goes at once.
  const after = play(state, [[13 * MIN, tool]]).events.find((e) => e.activity?.state === "working");
  assert.equal(after?.activity.observedAt, new Date(T0 + 13 * MIN).toISOString());
});

test("finishing a workflow run never reports the session idle", () => {
  const s = reported();
  const r = onReport(s, { type: "run.finished", fields: { outcome: "ready", prNumber: 7 } }, ctx(T0 + MIN));
  assert.notEqual(r.state.activity.state, "idle");
  assert.ok(r.events.every((e) => e.activity?.state !== "idle"));
});

test("an agent-lane session that reports its own stage waits for you at turn end and picks its stage up again; a custom lane keeps its stage", () => {
  let s = onReport(onHook(null, { ...input, hook_event_name: "UserPromptSubmit" }, ctx(T0)).state, { type: "stage", stage: "agent:S4" }, ctx(T0 + MIN)).state;
  const entered = [];
  for (const [min, name] of [[2, "Stop"], [9, "UserPromptSubmit"], [10, "Stop"]]) {
    const r = onHook(s, { ...input, hook_event_name: name }, ctx(T0 + min * MIN));
    s = r.state;
    entered.push(...r.events.filter((e) => e.type === "step.entered").map((e) => e.stage + " " + e.activity?.state));
  }
  assert.deepEqual(entered, ["agent:S5 idle", "agent:S4 working", "agent:S5 idle"]);
  assert.equal(onHook(s, { ...input, hook_event_name: "SessionEnd" }, ctx(T0 + 20 * MIN)).events.find((e) => e.type === "run.finished").outcome, "ready");
  // A custom workflow lane is left where it is: its stage is the workflow's, only its activity goes idle.
  let c = onReport(onHook(null, { ...input, session_id: "thread-ship", hook_event_name: "UserPromptSubmit" }, ctx(T0)).state, { type: "stage", stage: "ship:S4" }, ctx(T0 + MIN)).state;
  const stop = onHook(c, { ...input, session_id: "thread-ship", hook_event_name: "Stop" }, ctx(T0 + 2 * MIN));
  assert.equal(stop.state.stage, "ship:S4");
  assert.equal(stop.events.some((e) => e.type === "step.entered"), false);
  assert.equal(stop.events.at(-1).activity.state, "idle");
});
test("on a board without activity support the live hook spends none of the run's beat budget", async () => {
  const { hook, loadSession } = await import("../core/run.mjs");
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pipexp-beat-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/acme/old-board"]);
  const real = Date.now;
  let now = T0;
  Date.now = () => now;
  try {
    hook({ session_id: "old-board", cwd: dir, hook_event_name: "UserPromptSubmit" }, "codex");
    for (let i = 1; i <= 10; i++) {
      now = T0 + i * 5 * MIN;
      hook({ session_id: "old-board", cwd: dir, ...tool }, "codex");
    }
  } finally {
    Date.now = real;
  }
  assert.equal(loadSession("old-board").beats, undefined);
});
