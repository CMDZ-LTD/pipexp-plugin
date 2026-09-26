// CMD-343: the project's content level from /plugin/config, and pipexp preview. Minimal (on the board, or on this
// machine) stops titles, branches and the creator before anything is sent; a machine may go stricter, never looser.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { freshHome } from "./helpers.mjs";

const home = freshHome();
process.env.PIPEXP_RUNTIME = "codex";
const { stagesFor, validLanes } = await import("../core/stages.mjs");
const { contentFor, hook, report } = await import("../core/run.mjs");
const { queued } = await import("../core/queue.mjs");
const contract = JSON.parse(readFileSync(new URL("./fixtures/plugin-config.json", import.meta.url), "utf8"));

async function board(level) {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(level === undefined ? { lanes: contract.lanes } : { lanes: contract.lanes, contentLevel: level }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.PIPEXP_URL = "http://127.0.0.1:" + server.address().port;
  process.env.PIPEXP_KEY = "k".repeat(30);
  return () => new Promise((r) => server.close(r));
}
function checkout(remote) {
  const dir = mkdtempSync(join(tmpdir(), "pipexp-content-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  execFileSync("git", ["-C", dir, "checkout", "-q", "-b", "codex/abc-12-secret-plan"]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", remote]);
  return dir;
}

test("the board's answer shape still holds: lanes, and an optional content level", () => {
  assert.ok(validLanes(contract));
  assert.ok(["standard", "minimal"].includes(contract.contentLevel));
});

test("a project set to minimal on the board: this machine sends no title, branch or creator for it", async () => {
  const close = await board("minimal");
  const dir = checkout("https://github.com/acme/private.git");
  await stagesFor(dir);
  await close();
  assert.equal(contentFor(dir), "minimal");
  hook({ session_id: "m-1", cwd: dir, hook_event_name: "UserPromptSubmit" });
  const e = queued().find((x) => x.type === "run.started" && x.repo === "acme/private");
  assert.ok(e);
  assert.equal(e.branch, null);
  assert.equal(e.owner, null);
  assert.doesNotMatch(e.title, /secret-plan/);
  // A title a skill set explicitly is dropped too.
  const r = report("m-1", { type: "run.started", fields: { title: "Secret plan for acme" } }, "codex", dir);
  assert.doesNotMatch(r.events.find((x) => x.type === "run.started").title, /Secret plan/);
});

test("standard on the board, or no level in its answer (an older board), keeps the title and branch", async () => {
  for (const level of ["standard", undefined]) {
    const close = await board(level);
    const dir = checkout("https://github.com/acme/open-" + (level ?? "old") + ".git");
    await stagesFor(dir);
    await close();
    assert.equal(contentFor(dir), "standard");
    hook({ session_id: "s-" + (level ?? "old"), cwd: dir, hook_event_name: "UserPromptSubmit" });
    const e = queued().filter((x) => x.type === "run.started").at(-1);
    assert.equal(e.branch, "codex/abc-12-secret-plan");
  }
});

test("this machine's own minimal wins over a board set to standard: stricter, never looser", async () => {
  const close = await board("standard");
  const dir = checkout("https://github.com/acme/strict.git");
  await stagesFor(dir);
  await close();
  writeFileSync(join(home, "settings.json"), JSON.stringify({ content: "minimal" }));
  assert.equal(contentFor(dir), "minimal");
  writeFileSync(join(home, "settings.json"), JSON.stringify({ content: "standard" }));
});

test("pipexp preview prints this session's waiting events as they will be sent: scrubbed, at the content level", () => {
  const dir = checkout("https://github.com/acme/preview.git");
  hook({ session_id: "pv-1", cwd: dir, hook_event_name: "UserPromptSubmit" });
  report("pv-1", { type: "snag.reported", fields: { kind: "snag", theme: "t", what: "used ghp_abcdefghijklmnop from /Users/ana/x", costMin: null } }, "codex", dir);
  hook({ session_id: "pv-other", cwd: dir, hook_event_name: "UserPromptSubmit" });
  const cli = new URL("../bin/pipexp.mjs", import.meta.url).pathname;
  const env = { ...process.env, PIPEXP_HOME: home, PIPEXP_NO_FLUSH: "1" };
  delete env.PIPEXP_URL;
  delete env.PIPEXP_KEY;
  const text = execFileSync(process.execPath, [cli, "preview", "--session", "pv-1"], { encoding: "utf8", env });
  assert.match(text, /^Content level: standard/);
  assert.match(text, /3 events waiting for this session/);
  assert.match(text, /used \[REDACTED\] from ~\/x/);
  assert.doesNotMatch(text, /ghp_abcdefghijklmnop|\/Users\/ana/);
  const raw = JSON.parse(execFileSync(process.execPath, [cli, "preview", "--session", "pv-1", "--raw"], { encoding: "utf8", env }));
  assert.equal(new Set(raw.map((e) => e.runId)).size, 1, "only this session's run, not the other one");
  assert.equal(queued().length > raw.length, true, "nothing was sent or removed by preview");
});
