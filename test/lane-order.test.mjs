// CMD-518: when work goes back to an earlier lane (ship, shepherd, ship), only the lane in use carries a fresh activity
// observation. The board keeps a session's row on the run with the newest observation, ties broken by lastEventAt
// (PipeXP lib/agent-lanes.ts:26-27, :72-73; convex/pipeline.ts:102, :115), so a tie could show the lane just left.
import assert from "node:assert/strict";
import test from "node:test";
import { ctx, freshHome } from "./helpers.mjs";
import { onHook, onReport } from "../core/session.mjs";
freshHome();

const T0 = Date.parse("2026-09-27T22:00:00Z");
const MIN = 60_000;
const base = { session_id: "lane-order", cwd: "/repo", transcript_path: "/t.jsonl" };

/** The board's row for one session: each run's activity and lastEventAt as ingest keeps them, then the newest wins. */
function boardRow(events, reversed) {
  const runs = new Map();
  for (const e of events) {
    const r = runs.get(e.runId) ?? { runId: e.runId, lastEventAt: e.occurredAt };
    r.lastEventAt = e.occurredAt > r.lastEventAt ? e.occurredAt : r.lastEventAt;
    if (e.activity && (!r.activity || Date.parse(e.activity.observedAt) >= Date.parse(r.activity.observedAt))) r.activity = e.activity;
    runs.set(e.runId, r);
  }
  const observed = (r) => r.activity?.observedAt ?? r.lastEventAt;
  const rows = [...runs.values()];
  if (reversed) rows.reverse();
  return rows.sort((a, b) => Date.parse(observed(b)) - Date.parse(observed(a)) || b.lastEventAt.localeCompare(a.lastEventAt))[0].runId;
}

test("ship, shepherd, back to ship: the lane left gets its usage only, and the board's row is the ship run whatever the order", () => {
  let s = onHook(null, { ...base, hook_event_name: "UserPromptSubmit", turn_id: "t1" }, ctx(T0)).state;
  const events = [];
  for (const [m, stage] of [[1, "ship:S4"], [5, "shepherd:S2"], [9, "ship:S5"]]) {
    const r = onReport(s, { type: "stage", stage }, ctx(T0 + m * MIN));
    s = r.state;
    events.push(...r.events);
  }
  const ship = s.runs.ship;
  const shepherd = s.runs.shepherd;
  assert.equal(s.runId, ship);
  const back = new Date(T0 + 9 * MIN).toISOString();
  const left = events.filter((e) => e.runId === shepherd && e.occurredAt === back);
  assert.deepEqual(left.map((e) => e.type), ["usage.reported"]);
  assert.ok(!left[0].activity || left[0].activity.observedAt < back, "the lane left is not observed as working now");
  assert.ok(events.filter((e) => e.runId === ship && e.occurredAt === back).every((e) => e.activity?.observedAt === back));
  assert.equal(boardRow(events, false), ship);
  assert.equal(boardRow(events, true), ship);
});

