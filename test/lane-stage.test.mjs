// CMD-518 / CMD-370: a stage is only ever sent on its own lane. Seen on prod (MacBook, 27 Sep 20:45:41 UTC): the Boss's
// ship run finished blocked, then pipexp_report_stage manager:S3 on its existing manager run re-entered ship:S5 on the
// manager lane, and the board refused it (PipeXP lib/event-schema.ts:321-322: a stage must start with "<skill>:").
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ctx, freshHome } from "./helpers.mjs";
import { onHook, onReport } from "../core/session.mjs";
freshHome();

const T0 = Date.parse("2026-09-27T20:00:00Z");
const base = { session_id: "01a0d4f0-d676-7013-9cba-fea7effb6b95", cwd: "/repo", transcript_path: "/t.jsonl" };
// The board's rule, as the contract fixture's stage ids follow it.
const STAGE_ID = /^([a-z0-9-]{1,40}):([A-Za-z0-9-]{1,40})$/;
const boardTakes = (e) => !e.stage || (STAGE_ID.test(e.stage) && e.stage.startsWith(e.skill + ":"));

function play(steps) {
  let t = T0;
  let s = onHook(null, { ...base, hook_event_name: "UserPromptSubmit", turn_id: "t1" }, ctx(t)).state;
  const events = [];
  for (const step of steps) {
    t += 1000;
    const r = typeof step === "function" ? step(s, ctx(t)) : onReport(s, step, ctx(t));
    s = r.state;
    events.push(...r.events);
  }
  return { s, events };
}

test("the Boss's sequence: after the ship run finished blocked, manager:S3 on the existing manager run sends no ship stage on the manager lane", () => {
  const { s, events } = play([
    { type: "stage", stage: "ship:S4" },
    { type: "stage", stage: "manager:S3" },
    { type: "stage", stage: "ship:S5" },
    { type: "run.finished", fields: { outcome: "blocked", question: "Waiting on review" } },
    { type: "stage", stage: "manager:S3" },
  ]);
  const refused = events.filter((e) => !boardTakes(e));
  assert.deepEqual(refused.map((e) => e.type + " " + e.skill + " " + e.stage), [], "every event is one the board takes");
  const last = events.filter((e) => e.runId === s.runs.manager && e.type === "step.entered").at(-1);
  assert.equal(last.stage, "manager:S3");
  assert.equal(last.skill, "manager");
  assert.ok(boardTakes(last), "manager:S3 passes the board's stage rule");
  // The contract fixture's step.entered follows the same rule.
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/board-contract.json", import.meta.url), "utf8"))["step.entered"];
  assert.ok(boardTakes(fixture));
});

test("controls: a finished run resumed on its own lane re-enters its own stage; a switch to an unfinished existing lane works as before", () => {
  // (a) Same lane: ship finished, then the next prompt resumes it at its own stage.
  const a = play([
    { type: "stage", stage: "ship:S4" },
    { type: "run.finished", fields: { outcome: "ready", prNumber: 7 } },
    (s, c) => onHook(s, { ...base, hook_event_name: "UserPromptSubmit", turn_id: "t2" }, c),
  ]);
  const resumed = a.events.filter((e) => e.type === "step.entered").at(-1);
  assert.deepEqual([resumed.skill, resumed.stage], ["ship", "ship:S4"]);
  assert.ok(a.events.every(boardTakes));
  // (b) Unfinished: ship, then manager, then back to the existing ship run: its own run, the stage asked for.
  const b = play([
    { type: "stage", stage: "ship:S4" },
    { type: "stage", stage: "manager:S3" },
    { type: "stage", stage: "ship:S5" },
  ]);
  const back = b.events.filter((e) => e.type === "step.entered").at(-1);
  assert.deepEqual([back.skill, back.stage, back.runId], ["ship", "ship:S5", b.s.runs.ship]);
  assert.ok(b.events.every(boardTakes));
});

test("a waiting lane picks up only a stage of its own at the next prompt", () => {
  // A remembered stage from another lane (the agent and manager lanes share it) is never sent on this one.
  const s = { ...onHook(null, { ...base, hook_event_name: "UserPromptSubmit", turn_id: "t1" }, ctx(T0)).state };
  const waiting = onReport(s, { type: "stage", stage: "manager:S2" }, ctx(T0 + 1000)).state;
  const stopped = onHook(waiting, { ...base, hook_event_name: "Stop", turn_id: "t1" }, ctx(T0 + 2000)).state;
  assert.equal(stopped.stage, "manager:S4");
  const stale = { ...stopped, managerStage: "agent:S2" };
  const r = onHook(stale, { ...base, hook_event_name: "UserPromptSubmit", turn_id: "t2" }, ctx(T0 + 3000));
  assert.ok(r.events.every(boardTakes), r.events.map((e) => e.skill + " " + e.stage).join(", "));
  assert.equal(r.state.stage, "manager:S1");
});

