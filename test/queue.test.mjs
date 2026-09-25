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

test("bounded: past MAX_FILES the oldest are dropped, and an event failing MAX_TRIES times is dropped", async () => {
  for (let i = 0; i < MAX_FILES + 5; i++) enqueue(ev(100 + i));
  assert.equal(pending(), MAX_FILES);
  let calls = 0;
  for (let i = 0; i < MAX_TRIES; i++) await flush(async () => (calls++, "retry"));
  assert.equal(calls, MAX_TRIES);
  assert.equal(pending(), MAX_FILES - 1);
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
