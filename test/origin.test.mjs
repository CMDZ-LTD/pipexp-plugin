// CMD-374: every event says where its session runs (origin), so the board never files a session outside a project's
// repo on this key's own project; a refused repo is not sent again without it; managers wait in their own lane.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ctx, freshHome } from "./helpers.mjs";

freshHome();
process.env.PIPEXP_RUNTIME = "codex";
const { hook } = await import("../core/run.mjs");
const { post } = await import("../core/send.mjs");
const { onHook, onIdle, onReport, IDLE_MS } = await import("../core/session.mjs");

const outbox = () => {
  const dir = join(process.env.PIPEXP_HOME, "state", "outbox");
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")).event) : [];
};
function folder(remote) {
  const dir = mkdtempSync(join(tmpdir(), "pipexp-origin-"));
  if (remote !== undefined) {
    execFileSync("git", ["init", "-q", dir]);
    if (remote) execFileSync("git", ["-C", dir, "remote", "add", "origin", remote]);
  }
  return dir;
}

test("events from a GitHub checkout say origin repo; from a folder with no GitHub remote, origin none", () => {
  for (const [sid, cwd, origin] of [["s-repo", folder("https://github.com/acme/app.git"), "repo"], ["s-plain", folder(), "none"], ["s-local", folder(""), "none"]]) {
    rmSync(join(process.env.PIPEXP_HOME, "state", "outbox"), { recursive: true, force: true });
    hook({ session_id: sid, cwd, hook_event_name: "UserPromptSubmit" });
    const events = outbox();
    assert.ok(events.length, sid + " sends events");
    assert.deepEqual([...new Set(events.map((e) => e.origin))], [origin], sid);
  }
});

async function board(answer) {
  const bodies = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const e = JSON.parse(body);
      bodies.push(e);
      const [status, reply] = answer(e);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { creds: { url: "http://127.0.0.1:" + server.address().port, key: "k".repeat(30) }, bodies, close: () => new Promise((r) => server.close(r)) };
}
const NO_PROJECT = { error: "No project for this repo that this key can report to" };
const step = (more) => ({ type: "step.entered", eventId: "e-" + Math.random(), runId: "r1", occurredAt: "2026-09-27T10:00:00Z", skill: "agent", runtime: "codex", stage: "agent:S2", ...more });

test("a refused repo is not sent again without it when the event says its origin, and nothing is logged as a fault", async () => {
  const b = await board(() => [403, NO_PROJECT]);
  try {
    assert.equal(await post(b.creds, step({ repo: "derek/stairs", origin: "repo" })), "refused");
    assert.equal(await post(b.creds, step({ origin: "none" })), "refused");
    assert.deepEqual(b.bodies.map((e) => e.repo ?? null), ["derek/stairs", null], "one POST each: no resend without repo");
    const log = join(process.env.PIPEXP_HOME, "state", "errors.log");
    assert.ok(!existsSync(log) || !readFileSync(log, "utf8").includes("step.entered\t403"), "a repo with no project is not a fault");
  } finally {
    await b.close();
  }
});

test("an older event with no origin keeps today's behaviour: a refused repo is sent once more without it", async () => {
  const b = await board((e) => (e.repo ? [403, NO_PROJECT] : [201, { ok: true }]));
  try {
    assert.equal(await post(b.creds, step({ repo: "acme/secret" })), "sent");
    assert.deepEqual(b.bodies.map((e) => e.repo ?? null), ["acme/secret", null]);
  } finally {
    await b.close();
  }
});

test("a manager reports its own lane, waits in manager:S4 at each turn's end, picks up its stage at the next prompt, and never lands in a builder stage", () => {
  const T0 = Date.parse("2026-09-27T10:00:00Z");
  const MIN = 60_000;
  const base = { session_id: "s-mgr", cwd: "/repo", transcript_path: "/t.jsonl" };
  let s = onHook(null, { ...base, hook_event_name: "UserPromptSubmit" }, ctx(T0)).state;
  let r = onReport(s, { type: "stage", stage: "manager:S2" }, ctx(T0 + MIN));
  s = r.state;
  const stages = [...r.events];
  for (const [min, name, extra] of [[2, "PostToolUse", { tool_name: "Bash", tool_input: { command: "npm test" } }], [3, "Stop"], [9, "UserPromptSubmit"], [10, "Stop"]]) {
    r = onHook(s, { ...base, hook_event_name: name, ...extra }, ctx(T0 + min * MIN));
    s = r.state;
    stages.push(...r.events);
  }
  const entered = stages.filter((e) => e.type === "step.entered").map((e) => e.stage);
  assert.ok(entered.every((x) => x.startsWith("manager:")), "never a builder stage: " + entered.join(", "));
  assert.deepEqual([...new Set(entered)], ["manager:S2", "manager:S4"]);
  assert.equal(entered.at(-1), "manager:S4");
  // A quiet manager goes to its own Waiting for you, not agent:S5.
  const busy = onReport(s, { type: "stage", stage: "manager:S3" }, ctx(T0 + 11 * MIN)).state;
  assert.deepEqual(onIdle(busy, T0 + 11 * MIN + IDLE_MS).events.filter((e) => e.type === "step.entered").map((e) => e.stage), ["manager:S4"]);
  // Ended while waiting: handed back, ready.
  const end = onHook(s, { ...base, hook_event_name: "SessionEnd", reason: "other" }, ctx(T0 + 20 * MIN)).events.find((e) => e.type === "run.finished");
  assert.equal(end.outcome, "ready");
});
