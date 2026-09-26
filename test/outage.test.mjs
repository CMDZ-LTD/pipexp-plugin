// CMD-95: never lose a session on a flaky network. A day with the board out of reach, then the board comes back.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ctx, fakeBoard, freshHome } from "./helpers.mjs";

const home = freshHome();
const { saveCredentials } = await import("../core/config.mjs");
const { clearDropped, droppedCount, enqueue, flush, pending, MAX_AGE_MS } = await import("../core/queue.mjs");
const { onHook } = await import("../core/session.mjs");
const { scrubEvent } = await import("../core/scrub.mjs");
const { sendOne } = await import("../bin/flush.mjs");
const { audit } = await import("../core/health.mjs");
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/board-contract.json", import.meta.url), "utf8"));
const MIN = 60_000;

test("a 24-hour outage: the board ends with every stage and the finish, and repeats merged on the way", async () => {
  const base = Date.now();
  let t = 0;
  let state = null;
  const fire = (hook) => {
    const r = onHook(state, { session_id: "outage-1", cwd: "/repo", transcript_path: null, ...hook }, ctx(base + t));
    state = r.state;
    enqueue(...r.events.map(scrubEvent));
  };
  const tryToSend = () => flush(async () => "retry", () => base + t);
  fire({ hook_event_name: "SessionStart", source: "startup" });
  fire({ hook_event_name: "UserPromptSubmit" });
  // A day of work, a tool call every 10 minutes, the board out of reach the whole time.
  for (t = 10 * MIN; t < 24 * 60 * MIN; t += 10 * MIN) {
    const hour = t / (60 * MIN);
    const call = hour < 1 ? { tool_name: "Bash", tool_input: { command: "rg login" } }
      : hour < 6 ? { tool_name: "apply_patch", tool_input: {} }
      : hour < 20 ? { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } }
      : { tool_name: "Bash", tool_input: { command: "git push -u origin HEAD" }, tool_response: { exit_code: 0 } };
    fire({ hook_event_name: "PostToolUse", ...call });
    await tryToSend();
  }
  fire({ hook_event_name: "Stop" });
  t += 30 * MIN;
  fire({ hook_event_name: "SessionEnd", reason: "other" });
  await tryToSend();
  const waiting = pending();
  // 144 tool calls and a heartbeat every 30 minutes, kept as a handful of events.
  assert.ok(waiting < 20, waiting + " waiting");
  // The board is back.
  const board = await fakeBoard();
  saveCredentials({ url: board.url, key: "pipexp_rk_" + "k".repeat(43) });
  const creds = { url: board.url, key: "pipexp_rk_" + "k".repeat(43) };
  const result = await flush((e) => sendOne(creds, e), () => base + t);
  await board.close();
  assert.equal(result.left, 0);
  const sent = board.requests.filter((r) => r.url === "/events").map((r) => r.body);
  const stages = [...new Set(sent.filter((e) => e.type === "step.entered").map((e) => e.stage))];
  assert.deepEqual(stages, ["agent:S1", "agent:S2", "agent:S3", "agent:S4", "agent:S5"]);
  assert.deepEqual(sent.filter((e) => e.type === "run.finished").map((e) => e.outcome), ["ready"]);
  assert.equal(sent[0].type, "run.started");
  // Only board fields go out: the outbox's own marks never do.
  for (const e of sent) for (const key of Object.keys(e)) assert.ok(key in fixtures[e.type] || ["ticket", "attemptId"].includes(key), e.type + " sends " + key);
  assert.equal(droppedCount(), 0, "nothing lost");
});

test("flush --verbose says what waits by type and age and why it stopped, never a value", async () => {
  saveCredentials({ url: "http://127.0.0.1:9", key: "pipexp_rk_" + "k".repeat(43) });
  enqueue({ eventId: "00000000-0000-4000-8000-000000000901", runId: "44444444-4444-4444-8444-444444444444", type: "snag.reported", what: "secret-plan-for-orbit" });
  enqueue({ eventId: "00000000-0000-4000-8000-000000000902", runId: "44444444-4444-4444-8444-444444444444", type: "step.entered", stage: "agent:S2" });
  const cli = new URL("../bin/pipexp.mjs", import.meta.url).pathname;
  const r = spawnSync(process.execPath, [cli, "flush", "--verbose"], { env: { ...process.env, PIPEXP_HOME: home }, encoding: "utf8", timeout: 20000 });
  // The flush also queues this machine's daily audit, which waits with them.
  assert.match(r.stdout, /^Sent 0, left 3$/m);
  assert.match(r.stdout, /could not be reached/);
  assert.match(r.stdout, /snag\.reported: 1, oldest 1 min/);
  assert.match(r.stdout, /step\.entered: 1, oldest 1 min/);
  assert.doesNotMatch(r.stdout, /secret-plan|agent:S2|44444444/);
  const status = spawnSync(process.execPath, [cli, "status"], { env: { ...process.env, PIPEXP_HOME: home }, encoding: "utf8", timeout: 20000 });
  assert.match(status.stdout, /Queued events: 3 \(oldest 1 min; pipexp flush --verbose says why\)/);
  await flush(async () => "sent");
});

test("events past 7 days are dropped and counted; the next machine.audit reports them, and they are cleared once the board has it", async () => {
  await flush(async () => "sent");
  clearDropped(droppedCount());
  assert.equal(pending(), 0);
  enqueue({ eventId: "00000000-0000-4000-8000-000000000911", runId: "55555555-5555-4555-8555-555555555555", type: "step.entered", stage: "agent:S2" });
  await flush(async () => "retry", () => Date.now() + MAX_AGE_MS + MIN);
  assert.equal(droppedCount(), 1);
  const a = audit();
  assert.equal(a.plugin.dropped, 1);
  assert.equal(typeof fixtures["machine.audit"].plugin.dropped, "number", "the board contract has the field");
  const board = await fakeBoard();
  const creds = { url: board.url, key: "pipexp_rk_" + "k".repeat(43) };
  assert.equal(await sendOne(creds, a), "sent");
  await board.close();
  assert.equal(droppedCount(), 0);
  // Nothing dropped: the audit leaves the field out, as it always did.
  assert.equal("dropped" in audit().plugin, false);
});
