// The machine's own health: the one-line status, the daily audit the Machines tab reads, and the untrusted-hooks line.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fakeBoard, freshHome } from "./helpers.mjs";

const home = freshHome();
const codex = mkdtempSync(join(tmpdir(), "pipexp-codex-"));
process.env.CODEX_HOME = codex;
// No real key files: the legacy key lives under the real home folder.
process.env.HOME = codex;
const { VERSION, saveCredentials } = await import("../core/config.mjs");
const { audit, hooksTrusted, noteAudit, problem, queueAudit, tellOnce } = await import("../core/health.mjs");
const { hook } = await import("../core/run.mjs");
const { pending } = await import("../core/queue.mjs");
const outbox = () => {
  try {
    return readdirSync(join(home, "state", "outbox")).filter((n) => n.endsWith(".json")).sort().map((n) => JSON.parse(readFileSync(join(home, "state", "outbox", n), "utf8")).event);
  } catch {
    return [];
  }
};
const { run: flushNow } = await import("../bin/flush.mjs");

const T = Date.parse("2026-09-26T09:00:00Z");
const config = (trusted) =>
  writeFileSync(join(codex, "config.toml"), '[plugins."pipexp@personal"]\nenabled = true\n\n' + (trusted ? '[hooks.state."pipexp@personal:hooks/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:ab"\n' : ""));
const fixture = JSON.parse(readFileSync(new URL("./fixtures/board-contract.json", import.meta.url), "utf8"))["machine.audit"];

test("status names the first thing to fix, with its fix, in one line", () => {
  assert.equal(problem(T).code, "not_connected");
  saveCredentials({ url: "http://127.0.0.1:9", key: "k".repeat(30) });
  assert.equal(hooksTrusted(), null, "no Codex plugin entry: no trust step to check");
  config(false);
  assert.deepEqual(problem(T), { code: "hooks_untrusted", line: "PipeXP's hooks are not trusted, so sessions do not show on the board. Fix: in Codex, open /hooks and trust PipeXP" });
  config(true);
  assert.equal(problem(T), null);
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "state", "disconnected.json"), JSON.stringify({ at: "2026-09-26T08:00:00Z" }));
  assert.match(problem(T).line, /refused this machine's key\. Fix: pipexp connect$/);
  writeFileSync(join(home, "state", "disconnected.json"), "null");
});

test("an untrusted session hears it once a day, on the first tool reply", () => {
  config(false);
  assert.match(tellOnce(T), /open \/hooks and trust PipeXP/);
  assert.equal(tellOnce(T + 60_000), "");
  assert.match(tellOnce(T + 86_400_000), /trust PipeXP/);
  config(true);
  assert.equal(tellOnce(T + 3 * 86_400_000), "");
});

test("the audit carries versions, trust, queue and an error code only, in the board's shape", () => {
  config(false);
  hook({ session_id: "h-1", cwd: "/repo", hook_event_name: "UserPromptSubmit" }, "codex");
  const a = audit(T);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(fixture).sort());
  // dropped goes only when something was dropped (CMD-95): every other field always goes.
  assert.deepEqual(Object.keys(a.plugin).sort(), Object.keys(fixture.plugin).filter((k) => k !== "dropped").sort());
  assert.equal(a.plugin.version, VERSION);
  assert.deepEqual(a.plugin.harnesses.map((h) => h.name), ["codex"]);
  assert.equal(a.plugin.hooksTrusted, false);
  assert.equal(a.plugin.lastError, "hooks_untrusted");
  assert.equal(a.plugin.queued, pending());
  assert.deepEqual(a.rows, []);
});

test("the audit goes out on connect and then once a day with the next flush, and records the last event", async () => {
  config(true);
  const board = await fakeBoard();
  saveCredentials({ url: board.url, key: "k".repeat(30) });
  // The flush below asks queueAudit() on the real clock, so this test does too: a fixed day turns stale the day after.
  const now = Date.now();
  assert.equal(queueAudit(true, now), true, "connect always sends one");
  assert.equal(queueAudit(false, now + 3_600_000), false, "not again the same day");
  await flushNow();
  await flushNow();
  await board.close();
  const audits = board.requests.filter((r) => r.body.type === "machine.audit");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].body.plugin.hooksTrusted, true);
  assert.ok(JSON.parse(readFileSync(join(home, "state", "flush.json"), "utf8")).sentAt, "the last event time is kept for the next audit");
});

test("CMD-370: an audit the board refused is sent again an hour later, not a day; a stored one waits a day", async () => {
  writeFileSync(join(home, "state", "audit.json"), "{}");
  const board = await fakeBoard([400]);
  saveCredentials({ url: board.url, key: "k".repeat(30) });
  const T2 = T + 10 * 86_400_000;
  assert.equal(queueAudit(false, T2), true);
  await flushNow();
  assert.equal(queueAudit(false, T2 + 30 * 60_000), false, "not within the hour");
  assert.equal(queueAudit(false, T2 + 61 * 60_000), true, "refused, so tried again after an hour");
  await flushNow();
  assert.equal(queueAudit(false, T2 + 3 * 3_600_000), false, "stored: not again the same day");
  await board.close();
  assert.deepEqual(board.requests.filter((r) => r.body.type === "machine.audit").length, 2);
  noteAudit(true);
});

test("CMD-370: a refusal names the event and the board's reason, and says an upgrade will not help on the newest plugin", async () => {
  config(true);
  const state = join(home, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "errors.log"), "2026-09-26T08:10:00.000Z\tmachine.audit\t400\trows\n2026-09-26T08:45:47.972Z\trun.finished\t400\toutcome\n");
  const { lastRefusal } = await import("../core/health.mjs");
  assert.deepEqual(lastRefusal(T), { at: "2026-09-26T08:45:47.972Z", type: "run.finished", status: 400, field: "outcome" });
  const p = problem(T);
  assert.equal(p.code, "event_refused");
  assert.match(p.line, /^The board refused a run\.finished event \(400, field outcome\) at 08:45 UTC\./);
  // Never read the tags: no upgrade advice, and no claim to be the newest.
  assert.doesNotMatch(p.line, /marketplace upgrade|is the newest/);
  writeFileSync(join(state, "latest.json"), JSON.stringify({ at: T, version: VERSION }));
  // This is the newest: still no upgrade advice, and it says so.
  assert.doesNotMatch(problem(T).line, /marketplace upgrade/);
  assert.match(problem(T).line, new RegExp("This plugin \\(" + VERSION.replace(/\./g, "\\.") + "\\) is the newest"));
  // Older than a day: nothing to say.
  assert.equal(problem(T + 86_400_000)?.code ?? null, null);
});

test("CMD-370: status suggests an upgrade only when the newest release tag is ahead of this plugin", async () => {
  const { checkLatest, behind, newer } = await import("../core/health.mjs");
  assert.equal(newer("0.1.10", "0.1.9"), true);
  assert.equal(newer("0.1.4", "0.1.4"), false);
  const state = join(home, "state");
  writeFileSync(join(state, "latest.json"), "null");
  const ahead = VERSION.replace(/\d+$/, (n) => String(Number(n) + 1));
  const asked = [];
  const tags = async (url) => { asked.push(url); return { ok: true, json: async () => [{ name: "v" + ahead }, { name: "v" + VERSION }, { name: "not-a-version" }] }; };
  assert.equal(await checkLatest(T, tags), ahead);
  assert.equal(behind(), true);
  assert.match(problem(T).line, new RegExp("Fix: a newer plugin is out \\(" + ahead.replace(/\./g, "\\.") + "\\): codex plugin marketplace upgrade pipexp$"));
  // Read at most once a day, and a failed read keeps what was known.
  await checkLatest(T + 1000, tags);
  assert.equal(asked.length, 1);
  assert.equal(await checkLatest(T + 86_400_001, async () => { throw new Error("offline"); }), ahead);
  writeFileSync(join(state, "errors.log"), "");
});


test("review: before the release tags are read, status does not claim this plugin is the newest", async () => {
  const { refusedLine } = await import("../core/health.mjs");
  const r = { at: "2026-09-26T12:30:55.612Z", type: "run.finished", status: 400, field: "outcome" };
  assert.doesNotMatch(refusedLine(r, null), /is the newest|upgrade/);
  assert.match(refusedLine(r, null), /No newer plugin is known: tell whoever runs the board/);
});

test("CMD-370: after a fault the last audit showed clears, the next SessionStart sends a fresh audit; a clean one sends none", () => {
  saveCredentials({ url: "http://127.0.0.1:9", key: "k".repeat(30) });
  writeFileSync(join(home, "state", "errors.log"), "");
  // The last audit went out while the hooks were untrusted.
  config(false);
  assert.equal(queueAudit(true), true);
  noteAudit(true);
  const audits = () => outbox().filter((e) => e.type === "machine.audit");
  const before = audits().length;
  assert.equal(audits().at(-1).plugin.lastError, "hooks_untrusted");
  // A person trusts them; the next session starts.
  config(true);
  hook({ session_id: "trust-1", cwd: "/repo", hook_event_name: "SessionStart" }, "codex");
  assert.equal(audits().length, before + 1, "a fresh audit, at once");
  assert.equal(audits().at(-1).plugin.hooksTrusted, true);
  assert.equal(audits().at(-1).plugin.lastError, null);
  noteAudit(true);
  // All clean now: another session sends no audit.
  hook({ session_id: "trust-2", cwd: "/repo", hook_event_name: "SessionStart" }, "codex");
  assert.equal(audits().length, before + 1);
});

test("CMD-88: a session start says once a day when events wait on a board it cannot reach, or the board refused one, with the fix", async () => {
  const { startNotice } = await import("../core/health.mjs");
  const { enqueue } = await import("../core/queue.mjs");
  config(true);
  saveCredentials({ url: "http://127.0.0.1:9", key: "k".repeat(30) });
  writeFileSync(join(home, "state", "errors.log"), "");
  writeFileSync(join(home, "state", "disconnected.json"), "null");
  const now = Date.now();
  assert.equal(startNotice(now), "", "all well: nothing to say");
  // A flush left events behind: the board could not be reached.
  enqueue({ eventId: "00000000-0000-4000-8000-000000000888", runId: "88888888-8888-4888-8888-888888888888", type: "step.entered" });
  writeFileSync(join(home, "state", "flush.json"), JSON.stringify({ at: now, left: 1 }));
  assert.equal(startNotice(now), "PipeXP: Events are waiting: the board could not be reached. Fix: check the network, then run pipexp flush");
  assert.equal(startNotice(now + 60_000), "", "once a day");
  // Through the real hook, as the agent shows it: the next day, a session start carries it as its notice.
  const launcher = new URL("../hooks/pipexp-hook.mjs", import.meta.url).pathname;
  writeFileSync(join(home, "state", "start-notice.json"), JSON.stringify({ board_unreachable: now - 2 * 86_400_000 }));
  const run = spawnSync(process.execPath, [launcher, "--runtime", "codex"], { input: JSON.stringify({ session_id: "notice-88", cwd: "/repo", hook_event_name: "SessionStart", source: "startup" }), env: { ...process.env, PIPEXP_NO_FLUSH: "1" }, encoding: "utf8", timeout: 5000 });
  assert.match(JSON.parse(run.stdout).systemMessage, /board could not be reached\. Fix: check the network, then run pipexp flush$/);
  writeFileSync(join(home, "state", "flush.json"), JSON.stringify({ at: now, left: 0 }));
});

test("CMD-370: a release list read before this plugin was tagged is read again within the hour, and status says how old it is", async () => {
  const { checkLatest, latestAge } = await import("../core/health.mjs");
  const state = join(home, "state");
  // Read at 13:26, when 0.1.4 was the newest tag; this plugin is newer.
  writeFileSync(join(state, "latest.json"), JSON.stringify({ at: T, version: "0.1.4" }));
  assert.equal(latestAge(T + 3 * 3_600_000), "read 3 h ago");
  const asked = [];
  const tags = async (url) => { asked.push(url); return { ok: true, json: async () => [{ name: "v" + VERSION }, { name: "v0.1.4" }] }; };
  assert.equal(await checkLatest(T + 30 * 60_000, tags), "0.1.4", "not within the hour");
  assert.equal(asked.length, 0);
  assert.equal(await checkLatest(T + 3_600_001, tags), VERSION, "read again: this plugin is now the newest known");
  assert.equal(asked.length, 1);
  // Read hourly either way, so a release reaches every machine within the hour (core/live.mjs).
  await checkLatest(T + 3_600_001 + 30 * 60_000, tags);
  assert.equal(asked.length, 1);
  await checkLatest(T + 3 * 3_600_000, tags);
  assert.equal(asked.length, 2);
  writeFileSync(join(state, "latest.json"), "null");
  assert.equal(latestAge(T), "never read");
});
