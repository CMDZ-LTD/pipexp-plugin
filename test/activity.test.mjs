import assert from "node:assert/strict";
import test from "node:test";
import { ctx, freshHome, probe } from "./helpers.mjs";
import { onHook, onIdle, onReport } from "../core/session.mjs";
freshHome();

const at = Date.parse("2026-09-27T12:00:00Z");
const input = { session_id: "thread-1", cwd: "/repo" };
const started = () => onHook(null, { ...input, hook_event_name: "UserPromptSubmit" }, ctx(at)).state;

test("every lane reports turn activity without finishing the workflow", () => {
  for (const stage of ["agent:S4", "ship:S4", "manager:S3"]) {
    const active = onReport(started(), { type: "stage", stage }, ctx(at + 100));
    const stopped = onHook(active.state, { ...input, hook_event_name: "Stop" }, ctx(at + 200));
    assert.equal(stopped.state.finished, false);
    assert.equal(stopped.events.some((e) => e.type === "run.finished"), false);
    assert.equal(stopped.events.at(-1).activity?.state, "idle");
    assert.equal(stopped.events.at(-1).sessionId, input.session_id);
    const resumed = onHook(stopped.state, { ...input, hook_event_name: "UserPromptSubmit" }, ctx(at + 300));
    assert.equal(resumed.events.at(-1).activity?.state, "working");
  }
});

test("an explicit pause or blocker survives Stop and passive tool hooks, until work resumes", () => {
  for (const state of ["paused", "blocked", "waiting"]) {
    const reported = onReport(started(), { type: "activity", state, note: "Waiting for the agreed review" }, ctx(at + 100));
    assert.equal(reported.events.at(-1).activity?.state, state);
    const stop = onHook(reported.state, { ...input, hook_event_name: "Stop" }, ctx(at + 200));
    assert.equal(stop.events.at(-1).activity?.state, state);
    const tool = onHook(stop.state, { ...input, hook_event_name: "PostToolUse", tool_name: "read" }, ctx(at + 70_000));
    assert.equal(tool.state.activity?.state, state);
    const resume = onHook(tool.state, { ...input, hook_event_name: "UserPromptSubmit" }, ctx(at + 80_000));
    assert.equal(resume.events.at(-1).activity?.state, "working");
  }
});

test("silence never fabricates a fresh idle observation", () => {
  const state = started();
  const later = onIdle(state, at + 3 * 3_600_000);
  assert.equal(later.state.activity?.observedAt, new Date(at).toISOString());
});

test("changing the ticket at the same stage updates metadata and drops the previous PR", () => {
  const initial = onReport(started(), { type: "stage", stage: "ship:S4", ticket: "ABC-12" }, ctx(at));
  initial.state.prNumber = 123;
  const changed = onReport(initial.state, { type: "stage", stage: "ship:S4", ticket: "ABC-13" }, ctx(at + 100));
  const metadata = changed.events.find((e) => e.type === "run.started");
  assert.equal(metadata?.ticket, "ABC-13");
  assert.equal(metadata?.prNumber, null);
  const next = onHook(changed.state, { ...input, hook_event_name: "PostToolUse", tool_name: "read" }, ctx(at + 200, { probe: probe({ pr: () => 123 }) }));
  assert.equal(next.state.prNumber, null, "the previous branch's cached PR must not attach to the new ticket");
});

test("reporting the same stage after a checkout change refreshes the current ticket", () => {
  const first = onReport(started(), { type: "stage", stage: "ship:S4" }, ctx(at));
  const next = onReport(first.state, { type: "stage", stage: "ship:S4" }, ctx(at + 100, { probe: probe({ git: () => ({ branch: "codex/abc-99-new", repo: "shop" }) }) }));
  assert.equal(next.events.find((e) => e.type === "run.started")?.ticket, "ABC-99");
});
