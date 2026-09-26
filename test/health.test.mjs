// The machine's own health: the one-line status, the daily audit the Machines tab reads, and the untrusted-hooks line.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const { audit, hooksTrusted, problem, queueAudit, tellOnce } = await import("../core/health.mjs");
const { hook } = await import("../core/run.mjs");
const { pending } = await import("../core/queue.mjs");
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
  assert.deepEqual(Object.keys(a.plugin).sort(), Object.keys(fixture.plugin).sort());
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
  assert.equal(queueAudit(true, T), true, "connect always sends one");
  assert.equal(queueAudit(false, T + 3_600_000), false, "not again the same day");
  await flushNow();
  await flushNow();
  await board.close();
  const audits = board.requests.filter((r) => r.body.type === "machine.audit");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].body.plugin.hooksTrusted, true);
  assert.ok(JSON.parse(readFileSync(join(home, "state", "flush.json"), "utf8")).sentAt, "the last event time is kept for the next audit");
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
  // No newer release known (never read, or this is the newest): no upgrade advice.
  assert.doesNotMatch(p.line, /marketplace upgrade/);
  assert.match(p.line, new RegExp("This plugin \\(" + VERSION.replace(/\./g, "\\.") + "\\) is the newest"));
  writeFileSync(join(state, "latest.json"), JSON.stringify({ at: T, version: VERSION }));
  assert.doesNotMatch(problem(T).line, /marketplace upgrade/);
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

