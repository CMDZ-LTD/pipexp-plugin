import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ctx, freshHome, probe } from "./helpers.mjs";
freshHome();
import { IDLE_MS, onHook, onIdle, onReport, stageForTool, ticketOf, uuid5 } from "../core/session.mjs";
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
    "activity.reported",
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
  // A Cursor session's run.started also says its tokens are not reported, a field the board fixture has.
  const cursor = onHook(null, { hook_event_name: "SessionStart", session_id: "c-1", cwd: "/repo" }, ctx(T0, { runtime: "cursor" })).events[0];
  assert.equal(cursor.tokensReported, false);
  for (const key of Object.keys(cursor)) assert.ok(key in fixtures["run.started"] || ["ticket", "attemptId"].includes(key), "cursor run.started sends " + key);
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

test("a long test run re-sends its stage every 30 minutes, so the card never shows Stalled; activity between goes as its own beat", () => {
  const { events } = play([
    [0, { hook_event_name: "UserPromptSubmit" }],
    [1, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npx playwright test" } }],
    [20, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "sleep 600" } }],
    [32, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "gh run watch" } }],
  ]);
  assert.deepEqual(brief(events).slice(-2), ["activity.reported", "step.entered agent:S3"]);
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

const SHIP_RUN = "197441e4-3447-4267-b828-227a562b74ba";
const shipRun = (over = {}) => ({ ticket: "NJ-3321", runId: SHIP_RUN, fields: { title: "Penalties looks flat", owner: null, profile: "standard", branch: "codex/nj-3321" }, step: null, ...over });

test("a session the ship scripts claim reports onto their run: its own run closes once, the card keeps moving", () => {
  // NJ-3321, 29 Sep: the claim froze the card at Take the ticket for 2 hours while the agent built and proved the fix.
  let ship = null;
  const c = { probe: probe({ shipRun: () => ship }) };
  const first = play([[0, { hook_event_name: "UserPromptSubmit" }]], c);
  ship = shipRun();
  const r = onHook(first.state, { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "bash .claude/skills/ship/scripts/claim-run.sh NJ-3321 " + SID } }, ctx(T0 + 5 * MIN, c));
  assert.deepEqual(brief(r.events), ["run.finished", "run.started"]);
  assert.equal(r.events[0].runId, first.state.runId, "the plugin's own run closes");
  assert.equal(r.events[0].outcome, "abandoned");
  const started = r.events[1];
  assert.equal(started.runId, SHIP_RUN);
  assert.equal(started.skill, "ship");
  assert.equal(started.ticket, "NJ-3321");
  // The scripts' own title, profile and branch stay; the plugin adds who is on it and its version.
  assert.deepEqual([started.title, started.profile, started.branch, started.claim], ["Penalties looks flat", "standard", "codex/nj-3321", "resume"]);
  assert.equal(started.owner, null, "no GitHub login known in the test");
  assert.equal(started.pluginVersion, "pipexp " + VERSION);
  assert.equal(started.attemptId, undefined, "never a new attempt on the scripts' run");
  // Ship's state.json moves to step 5: the next check (a minute on) moves the card, and tool calls guess nothing.
  ship = shipRun({ step: 5 });
  const soon = onHook(r.state, { ...base, hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: {} }, ctx(T0 + 5 * MIN + 30_000, c));
  assert.ok(!soon.events.some((e) => e.type === "step.entered"), "checked at most once a minute");
  const later = onHook(soon.state, { ...base, hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: {} }, ctx(T0 + 7 * MIN, c));
  const step = later.events.find((e) => e.type === "step.entered");
  assert.equal(step.stage, "ship:S5");
  assert.equal(step.runId, SHIP_RUN);
  // A turn ends: ship's run gets the session idle, never a Waiting stage and never a finish.
  const stop = onHook(later.state, { ...base, hook_event_name: "Stop" }, ctx(T0 + 8 * MIN, c));
  assert.ok(stop.events.every((e) => e.runId === SHIP_RUN && e.type !== "run.finished" && !(e.stage ?? "").startsWith("agent:")));
  assert.equal(stop.state.activity.state, "idle");
  const end = onHook(stop.state, { ...base, hook_event_name: "SessionEnd" }, ctx(T0 + 9 * MIN, c));
  assert.ok(!end.events.some((e) => e.type === "run.finished"), "the scripts finish their own run");
});

test("the plugin lets go of a ship run the scripts finish, release or hand over, and never refuses a lane switch", () => {
  const OTHER = "6f1c2d3e-4a5b-4c6d-8e7f-8091a2b3c4d5";
  let ship = shipRun({ step: 4 });
  let state = { ticket: "NJ-3321", locked: true, runId: SHIP_RUN, owner: SID, status: "in_progress", pr: null };
  const c = { probe: probe({ shipRun: () => ship, shipState: () => state }) };
  const joined = onReport(play([[0, { hook_event_name: "UserPromptSubmit" }]], c).state, { type: "stage", stage: "ship:S4", ticket: "NJ-3321" }, ctx(T0 + MIN, c)).state;
  assert.equal(joined.runId, SHIP_RUN);
  // Released after handover: finished again with the outcome ship's own finish reports, and the session goes back to its own run.
  ship = null;
  state = { ticket: "NJ-3321", locked: false, runId: null, owner: null, status: "ready", pr: 4860 };
  const done = onHook(joined, { ...base, hook_event_name: "Stop" }, ctx(T0 + 3 * MIN, c));
  const fin = done.events.find((e) => e.type === "run.finished");
  assert.deepEqual([fin.runId, fin.skill, fin.outcome, fin.prNumber], [SHIP_RUN, "ship", "ready", 4860]);
  assert.equal(done.state.joined, null);
  assert.notEqual(done.state.runId, SHIP_RUN);
  // Nothing reaches the finished ship run again: no beat, no stage, however long the session goes on.
  const later = onHook(done.state, { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } }, ctx(T0 + 45 * MIN, c));
  assert.ok(later.events.every((e) => e.runId !== SHIP_RUN));
  // A takeover by another task: the run is the new owner's, so nothing is finished.
  ship = shipRun({ step: 4 });
  state = { ticket: "NJ-3321", locked: true, runId: SHIP_RUN, owner: SID, status: "in_progress", pr: null };
  const again = onReport(play([[0, { hook_event_name: "UserPromptSubmit" }]], c).state, { type: "stage", stage: "ship:S4", ticket: "NJ-3321" }, ctx(T0 + MIN, c)).state;
  ship = null;
  state = { ticket: "NJ-3321", locked: true, runId: null, owner: "someone-else", status: "in_progress", pr: null };
  const taken = onHook(again, { ...base, hook_event_name: "Stop" }, ctx(T0 + 3 * MIN, c));
  assert.ok(!taken.events.some((e) => e.type === "run.finished" && e.runId === SHIP_RUN));
  assert.equal(taken.state.joined, null);
  // A probe that can't read git says nothing either way.
  ship = shipRun({ step: 4 });
  const held = onReport(play([[0, { hook_event_name: "UserPromptSubmit" }]], c).state, { type: "stage", stage: "ship:S4", ticket: "NJ-3321" }, ctx(T0 + MIN, c)).state;
  ship = undefined;
  assert.equal(onHook(held, { ...base, hook_event_name: "Stop" }, ctx(T0 + 3 * MIN, c)).state.joined, SHIP_RUN);
  // A read caught mid-heartbeat (owner.json empty, lock still there, same run) is no proof: the run stays open.
  ship = null;
  state = { ticket: "NJ-3321", locked: true, owner: null, runId: SHIP_RUN, status: "in_progress", pr: null };
  const blip = onHook(held, { ...base, hook_event_name: "Stop" }, ctx(T0 + 3 * MIN, c));
  assert.ok(!blip.events.some((e) => e.type === "run.finished"));
  assert.equal(blip.state.joined, SHIP_RUN);
  // An agent stage while on the ship run is only the session working, never a second card.
  ship = shipRun({ step: 4 });
  const explore = onReport(held, { type: "stage", stage: "agent:S2", note: "Reading the scoreboard code" }, ctx(T0 + 4 * MIN, c));
  assert.deepEqual(brief(explore.events), ["activity.reported"]);
  assert.equal(explore.events[0].runId, SHIP_RUN);
  // A lane switch while joined: the shepherd run is the plugin's own (a child of the ship run), and ship's steps stay off it.
  ship = shipRun({ step: 6 });
  const shep = onReport(held, { type: "stage", stage: "shepherd:S1" }, ctx(T0 + 5 * MIN, c));
  const started = shep.events.find((e) => e.type === "run.started");
  assert.equal(started.parentRunId, SHIP_RUN);
  assert.notEqual(started.title, "Penalties looks flat");
  const next = onHook(shep.state, { ...base, hook_event_name: "Stop" }, ctx(T0 + 8 * MIN, c));
  assert.ok(next.events.every((e) => !e.stage || e.stage.startsWith(e.skill + ":")), "no ship stage on the shepherd run");
  void OTHER;
});

test("CMD-535: a session on a stale claim's run moves to the ticket it now works on, and leaves the old run alone", () => {
  const STALE = "d68a5dc3-d7ff-464b-9847-442dea379adc";
  let ship = shipRun({ ticket: "NJ-3256", runId: STALE, step: 4 });
  // NJ-3256 stays claimed by this session, locked, same run: no proof to leave it.
  const c = { probe: probe({ shipRun: () => ship, shipState: () => ({ ticket: "NJ-3256", locked: true, runId: STALE, owner: SID, status: "claimed", pr: null }) }) };
  const onStale = onReport(play([[0, { hook_event_name: "UserPromptSubmit" }]], c).state, { type: "stage", stage: "ship:S4", ticket: "NJ-3256" }, ctx(T0 + MIN, c)).state;
  assert.equal(onStale.runId, STALE);
  ship = shipRun({ ticket: "NJ-3331", step: 4 });
  const r = onHook(onStale, { ...base, hook_event_name: "Stop" }, ctx(T0 + 3 * MIN, c));
  assert.equal(r.state.runId, SHIP_RUN);
  assert.equal(r.state.joinedTicket, "NJ-3331");
  assert.ok(!r.events.some((e) => e.runId === STALE), "nothing sent to the old run: the scripts finish it");
  assert.ok(r.events.some((e) => e.type === "run.started" && e.runId === SHIP_RUN && e.ticket === "NJ-3331"));
});

test("a joined start under minimal content names nobody and no branch", () => {
  const c = { content: "minimal", probe: probe({ shipRun: () => shipRun(), shipState: () => null }) };
  const r = onReport(play([[0, { hook_event_name: "UserPromptSubmit" }]], { content: "minimal", probe: probe() }).state, { type: "stage", stage: "ship:S2", ticket: "NJ-3321" }, ctx(T0 + MIN, c));
  const started = r.events.find((e) => e.type === "run.started" && e.runId === SHIP_RUN);
  assert.deepEqual([started.title, started.owner, started.branch], ["NJ-3321", null, null]);
});

test("an older session that went quiet under a claim joins the ship run at its next turn edge", () => {
  const c = { probe: probe({ shipRun: () => shipRun({ step: 3 }), shipState: () => null }) };
  const quiet = { ...play([[0, { hook_event_name: "UserPromptSubmit" }]], { probe: probe() }).state, shipOwned: true, finished: true };
  const r = onHook(quiet, { ...base, hook_event_name: "UserPromptSubmit" }, ctx(T0 + 5 * MIN, c));
  assert.equal(r.state.shipOwned, false);
  assert.ok(r.events.some((e) => e.type === "step.entered" && e.stage === "ship:S3" && e.runId === SHIP_RUN));
  assert.ok(!r.events.some((e) => e.type === "run.finished"), "its own run was already finished");
});

test("a claim whose scripts started no run leaves the session to the plugin, and an older quiet session wakes up", () => {
  // NJ-3326, 29 Sep: telemetry off for the scripts, so nothing reached the board while the plugin stayed quiet.
  const c = { probe: probe({ shipRun: () => null }) };
  const s = { ...play([[0, { hook_event_name: "UserPromptSubmit" }]], c).state, shipOwned: true };
  const r = onReport(s, { type: "stage", stage: "ship:S7", ticket: "NJ-3326" }, ctx(T0 + MIN, c));
  assert.deepEqual(brief(r.events), ["usage.reported agent:S1", "run.started", "step.entered ship:S7"]);
  assert.equal(r.state.shipOwned, false);
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
  // No stage guessed: only the activity beat (4 minutes after the report said working).
  assert.deepEqual(brief(tool.events), ["activity.reported"]);
  assert.equal(tool.events[0].activity.state, "working");
  const next = onReport(tool.state, { type: "stage", stage: "ship:S4", fields: { counters: { reviewRound: 2 } } }, ctx(T0 + 9 * MIN));
  assert.deepEqual(brief(next.events), ["usage.reported ship:S1", "step.entered ship:S4"]);
  assert.deepEqual(next.events[1].counters, { humanTurns: 1, interrupts: 0, reviewRound: 2 });
});

test("an agent's stage report under a ship claim lands on the scripts' run, and ship's state never moves it back", () => {
  // NJ-3331, 29 Sep: the agent's reports were dropped and its early run stayed at Take the ticket beside the real one.
  const c = { probe: probe({ shipRun: () => shipRun({ ticket: "NJ-3331", step: 2 }) }) };
  const s = play([[0, { hook_event_name: "UserPromptSubmit" }]], { probe: probe() }).state;
  const r = onReport(s, { type: "stage", stage: "ship:S4", ticket: "NJ-3331" }, ctx(T0 + MIN, c));
  assert.deepEqual(brief(r.events), ["run.finished", "run.started", "step.entered ship:S2", "usage.reported ship:S2", "step.entered ship:S4"]);
  assert.ok(r.events.slice(1).every((e) => e.runId === SHIP_RUN));
  const again = onHook(r.state, { ...base, hook_event_name: "Stop" }, ctx(T0 + 3 * MIN, c));
  assert.ok(!again.events.some((e) => e.type === "step.entered" && e.stage === "ship:S2"), "a stage ahead of ship's state stays");
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

test("CMD-370: the card follows the branch the session is on now: ticket, branch and PR change with it", () => {
  let branch = "codex/nj-3235-old-work";
  const c = { probe: probe({ git: () => ({ branch, repo: "shop", top: "/repo", common: "/repo/.git" }) }) };
  const first = play([[0, { hook_event_name: "UserPromptSubmit" }], [1, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "gh pr create --fill" }, tool_response: "https://github.com/acme/shop/pull/7" }]], c);
  assert.equal(first.events.find((e) => e.type === "run.started").ticket, "NJ-3235");
  assert.equal(first.state.prNumber, 7);
  // The agent moves to new work on another branch.
  branch = "codex/cmd-161-scope-creep";
  const moved = onHook(first.state, { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git switch -c codex/cmd-161-scope-creep" } }, ctx(T0 + 5 * MIN, c));
  const again = moved.events.find((e) => e.type === "run.started");
  assert.ok(again, "the switch resends the run's start");
  assert.equal(again.ticket, "CMD-161");
  assert.equal(again.branch, "codex/cmd-161-scope-creep");
  assert.equal(moved.state.prNumber, null, "the old branch's PR does not follow it");
  // Checked again when the next turn starts, even with no git command in between (a switch made in a terminal).
  branch = "codex/cmd-186-projects";
  const next = onHook(moved.state, { ...base, hook_event_name: "UserPromptSubmit" }, ctx(T0 + 9 * MIN, c));
  assert.equal(next.events.find((e) => e.type === "run.started")?.ticket, "CMD-186");
  // Nothing changed: nothing resent.
  const same = onHook(next.state, { ...base, hook_event_name: "UserPromptSubmit" }, ctx(T0 + 10 * MIN, c));
  assert.equal(same.events.filter((e) => e.type === "run.started").length, 0);
});

test("CMD-370: a ticket the agent reported stays when the new branch names none, and is replaced when it does", () => {
  let branch = "main";
  const c = { probe: probe({ git: () => ({ branch, repo: "shop", top: "/repo", common: "/repo/.git" }) }) };
  const s = play([[0, { hook_event_name: "UserPromptSubmit" }]], c).state;
  const reported = onReport(s, { type: "stage", stage: "agent:S2", ticket: "CMD-370" }, ctx(T0 + MIN, c)).state;
  branch = "scratch";
  const plain = onHook(reported, { ...base, hook_event_name: "UserPromptSubmit" }, ctx(T0 + 2 * MIN, c));
  assert.equal(plain.state.ticket, "CMD-370");
  branch = "codex/cmd-99-ship";
  const named = onHook(plain.state, { ...base, hook_event_name: "UserPromptSubmit" }, ctx(T0 + 3 * MIN, c));
  assert.equal(named.state.ticket, "CMD-99");
});

test("CMD-370: cards say who started them (the machine's GitHub login), and minimal content names nobody", () => {
  const c = { probe: probe({ githubLogin: () => "octo-dev" }) };
  const started = play([[0, { hook_event_name: "UserPromptSubmit" }]], c).events.find((e) => e.type === "run.started");
  assert.equal(started.owner, "octo-dev");
  const quiet = onHook(null, { ...base, hook_event_name: "UserPromptSubmit" }, ctx(T0, { ...c, content: "minimal" })).events.find((e) => e.type === "run.started");
  assert.equal(quiet.owner, null);
});

test("CMD-370: a session no hook has heard from for two hours waits for its person; a skill step or a waiting card stays", () => {
  const s = play([[0, { hook_event_name: "UserPromptSubmit" }], [1, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" } }]]).state;
  assert.equal(s.stage, "agent:S3");
  assert.deepEqual(onIdle(s, s.lastSeenAt + IDLE_MS - 1).events, []);
  const idle = onIdle(s, s.lastSeenAt + IDLE_MS);
  assert.deepEqual(brief(idle.events), ["usage.reported agent:S3", "step.entered agent:S5"]);
  assert.deepEqual(onIdle(idle.state, idle.state.lastSeenAt + 2 * IDLE_MS).events, [], "once is enough");
  const ship = onReport(s, { type: "stage", stage: "ship:S4", ticket: "NJ-1" }, ctx(T0 + 2 * MIN)).state;
  assert.deepEqual(onIdle(ship, ship.lastSeenAt + IDLE_MS).events, [], "a ship step keeps its stage");
  // The next prompt moves it on as usual.
  const back = onHook(idle.state, { ...base, hook_event_name: "UserPromptSubmit" }, ctx(T0 + 4 * 60 * MIN));
  assert.deepEqual(brief(back.events).filter((e) => e.startsWith("step")), ["step.entered agent:S1"]);
});

test("CMD-370: after a finish, that turn's tool calls and its end leave the card at Done; the next prompt reopens it", () => {
  const s = play([[0, { hook_event_name: "UserPromptSubmit" }], [1, { hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: {} }]]).state;
  const done = onReport(s, { type: "run.finished", fields: { outcome: "ready", prNumber: 343 } }, ctx(T0 + 2 * MIN));
  assert.equal(done.events.at(-1).outcome, "ready");
  const tool = onHook(done.state, { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" } }, ctx(T0 + 2 * MIN + 144));
  assert.deepEqual(tool.events, [], "144 ms later: nothing");
  const stop = onHook(tool.state, { ...base, hook_event_name: "Stop" }, ctx(T0 + 3 * MIN));
  // CMD-518: the finished workflow stays Done; only the session's activity goes idle at the turn's end.
  assert.deepEqual(brief(stop.events), ["activity.reported"]);
  assert.equal(stop.events[0].activity.state, "idle");
  assert.equal(stop.state.finished, true);
  const next = onHook(stop.state, { ...base, hook_event_name: "UserPromptSubmit" }, ctx(T0 + 60 * MIN));
  assert.deepEqual(brief(next.events).slice(0, 1), ["run.started"]);
});

test("CMD-428: human turns and interrupts are counted, and no prompt text is in any event or the saved state", () => {
  const SECRET = "refund the loyalty points for orbit-customer-77";
  const { events, state } = play([
    [0, { hook_event_name: "SessionStart", source: "startup" }],
    [0, { hook_event_name: "UserPromptSubmit", prompt: SECRET }],
    [1, { hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: {} }],
    // Sent while the turn was still running: an interrupt.
    [2, { hook_event_name: "UserPromptSubmit", prompt: SECRET + " now" }],
    [3, { hook_event_name: "Stop" }],
    [5, { hook_event_name: "UserPromptSubmit", prompt: "and " + SECRET }],
    [6, { hook_event_name: "Stop" }],
  ]);
  assert.equal(state.turns, 3);
  assert.equal(state.interrupts, 1);
  const last = events.filter((e) => e.type === "step.entered").at(-1);
  assert.equal(last.stage, "agent:S5");
  assert.deepEqual(last.counters, { humanTurns: 3, interrupts: 1 });
  assert.doesNotMatch(JSON.stringify(events), /refund|orbit-customer|loyalty/);
  assert.doesNotMatch(JSON.stringify(state), /refund|orbit-customer|loyalty/);
});

test("CMD-427: a session learns its branch's PR from the flush's lookup; the card links to it at once, and a finished run's finish is sent again", () => {
  let pr = null;
  const c = { probe: probe({ pr: (_sid, branch) => (branch === "codex/abc-12-fix-login" ? pr : null) }) };
  const first = play([
    [0, { hook_event_name: "SessionStart", source: "startup" }],
    [1, { hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: {} }],
  ], c);
  assert.ok(first.events.every((e) => e.prNumber === undefined));
  // The flush found PR 57 (a push to a branch with an open PR, no gh pr create in this session).
  pr = 57;
  const learned = onHook(first.state, { ...base, hook_event_name: "PrFound" }, ctx(T0 + 2 * MIN, c));
  assert.deepEqual(learned.events.map((e) => [e.type, e.stage, e.prNumber]), [["step.entered", "agent:S2", 57]]);
  // Known already: nothing to resend.
  assert.deepEqual(onHook(learned.state, { ...base, hook_event_name: "PrFound" }, ctx(T0 + 3 * MIN, c)).events, []);
  // A session that ended before the lookup answered: its finish goes again with the PR, and the card stays finished.
  pr = null;
  const done = play([
    [0, { hook_event_name: "SessionStart", source: "startup" }],
    [1, { hook_event_name: "Stop" }],
    [2, { hook_event_name: "SessionEnd", reason: "other" }],
  ], c);
  pr = 58;
  const late = onHook(done.state, { ...base, hook_event_name: "PrFound" }, ctx(T0 + 3 * MIN, c));
  assert.deepEqual(late.events.map((e) => [e.type, e.outcome, e.prNumber]), [["run.finished", "ready", 58]]);
  assert.equal(late.state.finished, true);
});

test("CMD-427: the flush asks gh for the branch's PR at most every ten minutes, at once after a push, never for main", async () => {
  const { cachedPr, lookUpPr, markPrChecked, prDue, CHECK_MS } = await import("../core/pr.mjs");
  const calls = [];
  const gh = (answer) => (cmd, args, opts) => { calls.push([cmd, args, opts.cwd]); return answer; };
  const s = { sessionId: "pr-1", cwd: "/repo", gitBranch: "codex/abc-12-x" };
  assert.equal(prDue("pr-1", "main"), false);
  assert.equal(prDue("pr-1", "codex/abc-12-x", false, T0), true, "a branch never looked up");
  markPrChecked("pr-1", "codex/abc-12-x", T0);
  assert.equal(prDue("pr-1", "codex/abc-12-x", false, T0 + MIN), false, "asked a minute ago");
  assert.equal(prDue("pr-1", "codex/abc-12-x", true, T0 + MIN), true, "a push asks again");
  const repo = () => "acme/shop";
  assert.equal(lookUpPr(s, gh({ status: 1, stdout: "" }), T0, repo), null, "no PR yet");
  assert.equal(prDue("pr-1", "codex/abc-12-x", false, T0 + CHECK_MS), true);
  // gh answers with another branch's PR (a fork's same-named branch): not this session's.
  assert.equal(lookUpPr(s, gh({ status: 0, stdout: JSON.stringify({ number: 9, headRefName: "other" }) }), T0, repo), null);
  assert.equal(lookUpPr(s, gh({ status: 0, stdout: JSON.stringify({ number: 57, headRefName: "codex/abc-12-x" }) }), T0, repo), 57);
  assert.equal(cachedPr("pr-1", "codex/abc-12-x"), 57);
  assert.equal(cachedPr("pr-1", "codex/other"), null, "another branch has not been looked up");
  assert.equal(prDue("pr-1", "codex/abc-12-x", true, T0 + CHECK_MS * 10), false, "found: never asked again for this branch");
  assert.deepEqual(calls.at(-1), ["gh", ["pr", "view", "codex/abc-12-x", "--repo", "acme/shop", "--json", "number,headRefName"], "/repo"]);
  assert.equal(lookUpPr({ ...s, gitBranch: "main" }, gh({ status: 0, stdout: "{}" })), null);
});

test("the board contract has run.started with ticket: null, which only run.started may send (CMD-452, board #344)", () => {
  const fixtures = JSON.parse(readFileSync(new URL("./fixtures/board-contract.json", import.meta.url), "utf8"));
  const none = fixtures["run.started (no ticket)"];
  assert.equal(none.type, "run.started");
  assert.equal(none.ticket, null);
  assert.deepEqual({ ...none, ticket: undefined, eventId: undefined }, { ...fixtures["run.started"], ticket: undefined, eventId: undefined });
  assert.ok(Object.entries(fixtures).every(([k, e]) => k === "run.started (no ticket)" || e.ticket !== null), "no other event sends ticket: null");
});

test("CMD-452: a session that moves to a branch with no ticket sends ticket: null, so the card drops the old one; one that never had a ticket sends none", () => {
  let branch = "codex/nj-3235-old-work";
  const c = { probe: probe({ git: () => ({ branch, repo: "shop", top: "/repo", common: "/repo/.git" }) }) };
  const first = play([[0, { hook_event_name: "UserPromptSubmit" }]], c);
  assert.equal(first.events.find((e) => e.type === "run.started").ticket, "NJ-3235");
  branch = "main";
  const back = onHook(first.state, { ...base, hook_event_name: "UserPromptSubmit" }, ctx(T0 + 5 * MIN, c));
  const started = back.events.find((e) => e.type === "run.started");
  assert.ok(started && "ticket" in started, "the start is resent with the ticket field");
  assert.equal(started.ticket, null);
  // Only run.started carries null; the board refuses it anywhere else.
  assert.ok(back.events.filter((e) => e.type !== "run.started").every((e) => !("ticket" in e)));
  // Every field it sends is one the board's contract fixture has, ticket: null included.
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/board-contract.json", import.meta.url), "utf8"))["run.started (no ticket)"];
  for (const key of Object.keys(started)) assert.ok(key in fixture || ["attemptId"].includes(key), "run.started sends " + key);
  // A new ticket on the next branch replaces null.
  branch = "codex/cmd-99-ship";
  assert.equal(onHook(back.state, { ...base, hook_event_name: "UserPromptSubmit" }, ctx(T0 + 6 * MIN, c)).events.find((e) => e.type === "run.started").ticket, "CMD-99");
  // A session that never had a ticket never sends the field.
  branch = "main";
  const plain = play([[0, { hook_event_name: "SessionStart", source: "startup" }]], c).events.find((e) => e.type === "run.started");
  assert.ok(!("ticket" in plain));
});
