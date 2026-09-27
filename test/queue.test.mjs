import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fakeBoard, freshHome } from "./helpers.mjs";

const home = freshHome();
const { enqueue, flush, pending, MAX_FILES, MAX_TRIES } = await import("../core/queue.mjs");
const { post } = await import("../core/send.mjs");
const RUN = "11111111-1111-4111-8111-111111111111";
const ev = (n, type = "step.entered", runId = RUN) => ({ eventId: "00000000-0000-4000-8000-" + String(n).padStart(12, "0"), runId, type });

test("offline: events wait in order, then all go out once the board is back, each under its own id", async () => {
  enqueue(ev(1), ev(2), ev(3));
  const down = await flush(async () => "retry");
  assert.equal(down.left, 3);
  const board = await fakeBoard();
  const creds = { url: board.url, key: "k".repeat(30) };
  const up = await flush((e) => post(creds, e));
  await board.close();
  assert.equal(up.sent, 3);
  assert.equal(pending(), 0);
  assert.deepEqual(board.requests.map((r) => r.body.eventId), [ev(1), ev(2), ev(3)].map((e) => e.eventId));
  assert.ok(board.requests.every((r) => r.key === creds.key && r.url === "/events"));
});

test("a resend after a lost answer carries the same eventId, so the board keeps one", async () => {
  enqueue(ev(10));
  const board = await fakeBoard([503]);
  const creds = { url: board.url, key: "k".repeat(30) };
  await flush((e) => post(creds, e));
  await flush((e) => post(creds, e));
  await board.close();
  assert.equal(board.requests.length, 2);
  assert.equal(board.requests[0].body.eventId, board.requests[1].body.eventId);
});

test("events queued while a flush is running are sent by that flush, never stranded", async () => {
  enqueue(ev(60));
  const seen = [];
  await flush(async (e) => {
    seen.push(e.eventId.slice(-2));
    if (seen.length === 1) enqueue(ev(61)); // A hook fires mid-flush and finds the lock taken.
    return "sent";
  });
  assert.deepEqual(seen, ["60", "61"]);
  assert.equal(pending(), 0);
});

test("kept by age: nothing younger than 7 days is dropped, older is dropped and counted; a server error uses one try an hour", async () => {
  const { droppedCount, MAX_AGE_MS, TRY_GAP_MS } = await import("../core/queue.mjs");
  const before = droppedCount();
  enqueue(ev(100), ev(101));
  const now = Date.now();
  // Six days of the board being out of reach: nothing goes, and "retry" uses no try.
  for (let day = 1; day <= 6; day++) await flush(async () => "retry", () => now + day * 86_400_000);
  assert.equal(pending(), 2);
  assert.equal(droppedCount(), before);
  // Past 7 days both are dropped at the next flush, and counted for the next audit.
  await flush(async () => "retry", () => now + MAX_AGE_MS + 60_000);
  assert.equal(pending(), 0);
  assert.equal(droppedCount(), before + 2);
  // A board that answers 500: one try an hour, however often it flushes, and dropped after MAX_TRIES of them.
  enqueue(ev(102));
  let calls = 0;
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) await flush(async () => (calls++, "error"), () => t0 + i * 60_000);
  assert.equal(pending(), 1, "ten flushes inside an hour use one try");
  for (let h = 1; h < MAX_TRIES; h++) await flush(async () => "error", () => t0 + h * TRY_GAP_MS);
  assert.equal(pending(), 0);
  assert.equal(droppedCount(), before + 3);
  assert.ok(calls >= 10);
});

test("repeats merge: one heartbeat per stage and one usage snapshot per stage and attempt wait, never a stage entry", async () => {
  const run = "33333333-3333-4333-8333-333333333333";
  const beat = (n, stage) => ({ ...ev(200 + n, "step.entered", run), stage, _beat: true });
  const usage = (n, stage, attemptId) => ({ ...ev(300 + n, "usage.reported", run), stage, attemptId, _usage: { since: "x" } });
  enqueue({ ...ev(199, "step.entered", run), stage: "agent:S2" });
  for (let i = 0; i < 20; i++) enqueue(beat(i, "agent:S2"));
  enqueue(usage(1, "agent:S2", "A"), usage(2, "agent:S2", "A"));
  enqueue({ ...ev(198, "step.entered", run), stage: "agent:S3" }, usage(3, "agent:S3", "A"), usage(4, "agent:S3", "A"));
  const { queued } = await import("../core/queue.mjs");
  const left = queued().filter((e) => e.runId === run).map((e) => e.type + " " + e.stage + (e._beat ? " beat" : ""));
  assert.deepEqual(left, ["step.entered agent:S2", "step.entered agent:S2 beat", "usage.reported agent:S2", "step.entered agent:S3", "usage.reported agent:S3"]);
  await flush(async () => "sent");
  assert.equal(pending(), 0);
});

test("a refusal is dropped and logged as type, status and field, never a value", async () => {
  enqueue({ ...ev(20, "snag.reported"), what: "secret-value-here" });
  const board = await fakeBoard([400]);
  await flush((e) => post({ url: board.url, key: "k".repeat(30) }, e));
  await board.close();
  assert.equal(pending(), 0);
  const log = readFileSync(join(home, "state", "errors.log"), "utf8");
  assert.match(log, /\tsnag\.reported\t400\twhat\n$/);
  assert.ok(!log.includes("secret-value-here"));
});

test("after a 429 a run sends only its run.finished", async () => {
  const capped = "22222222-2222-4222-8222-222222222222";
  enqueue(ev(30, "step.entered", capped));
  const board = await fakeBoard([429]);
  const creds = { url: board.url, key: "k".repeat(30) };
  await flush((e) => post(creds, e));
  enqueue(ev(31, "step.entered", capped), ev(32, "run.finished", capped), ev(33));
  await flush((e) => post(creds, e));
  await board.close();
  assert.deepEqual(board.requests.map((r) => r.body.eventId.slice(-2)), ["30", "32", "33"], "another run still sends");
});

test("a revoked key keeps events and marks the machine disconnected", async () => {
  enqueue(ev(40));
  const board = await fakeBoard([401]);
  await flush((e) => post({ url: board.url, key: "k".repeat(30) }, e));
  await board.close();
  assert.equal(pending(), 1);
  assert.match(readFileSync(join(home, "state", "disconnected.json"), "utf8"), /"at"/);
  assert.ok(readdirSync(join(home, "state", "outbox")).length === 1);
});

test("never sends a key over plain http to another host, or anywhere but localhost under a test", async () => {
  assert.equal(await post({ url: "http://board.example.com", key: "k".repeat(30) }, ev(50)), "retry");
  assert.equal(await post({ url: "https://board.example.com", key: "k".repeat(30) }, ev(51)), "retry");
});
