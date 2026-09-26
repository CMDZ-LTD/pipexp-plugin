import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { freshHome } from "./helpers.mjs";

freshHome();
const { describe, repoSlug, routedRepo, stagesFor, validLanes } = await import("../core/stages.mjs");
// What the board's GET /plugin/config answers (agent-pipeline convex/http.ts, pluginLanes in lib/stages.ts).
const contract = JSON.parse(readFileSync(new URL("./fixtures/plugin-config.json", import.meta.url), "utf8"));

async function board(answer) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, key: req.headers["x-api-key"] });
    const [status, body] = answer(req.url);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: "http://127.0.0.1:" + server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}
function checkout(remote) {
  const dir = mkdtempSync(join(tmpdir(), "pipexp-repo-"));
  execFileSync("git", ["init", "-q", dir]);
  if (remote) execFileSync("git", ["-C", dir, "remote", "add", "origin", remote]);
  return dir;
}

test("reads GitHub repos from https and ssh remotes", () => {
  assert.equal(repoSlug("https://github.com/Acme-Co/app.git"), "Acme-Co/app");
  assert.equal(repoSlug("git@github.com:acme/web.site.git\n"), "acme/web.site");
  assert.equal(repoSlug("https://gitlab.com/acme/app"), null);
});

test("the board's config answer is the shape the plugin reads", () => {
  assert.ok(validLanes(contract));
  assert.equal(validLanes({ lanes: [{ skill: "qa", label: "QA", stages: [{ id: "ship:S1", label: "x" }] }] }), null);
  assert.match(describe(contract.lanes), /agent:S5 Waiting for you \[waits on a person\]/);
});

test("asks the board for this repo's stages, caches them, then names the repo on the session's events", async () => {
  const b = await board((url) => [200, url.includes("repo=acme%2Fapp") ? { lanes: [{ skill: "triage", label: "Triage", stages: [{ id: "triage:S1", label: "Read" }] }] } : contract]);
  process.env.PIPEXP_URL = b.url;
  process.env.PIPEXP_KEY = "k".repeat(30);
  const dir = checkout("git@github.com:acme/app.git");
  assert.equal(routedRepo(dir), null, "no repo on events before the board accepted it");
  const r = await stagesFor(dir);
  assert.equal(r.from, "board");
  assert.deepEqual(r.lanes.map((l) => l.skill), ["triage"]);
  assert.equal(b.seen[0].url, "/plugin/config?repo=acme%2Fapp");
  assert.equal(routedRepo(dir), "acme/app");
  // A report from this folder now names the repo, so the board files it in that repo's project.
  process.env.PIPEXP_NO_FLUSH = "1";
  const { report } = await import("../core/run.mjs");
  const { events } = report("s-repo", { type: "snag.reported", fields: { kind: "snag", theme: "t", what: "w", costMin: null } }, "codex", dir);
  const { flush } = await import("../core/queue.mjs");
  const sent = [];
  await flush(async (e) => (sent.push(e), "sent"));
  assert.ok(events.length > 0);
  assert.ok(sent.length > 0 && sent.every((e) => e.repo === "acme/app"));
  // Offline: the last answer.
  await b.close();
  assert.equal((await stagesFor(dir)).from, "cache");
  // No GitHub remote: the key's own project, no repo named.
  const b2 = await board(() => [200, contract]);
  process.env.PIPEXP_URL = b2.url;
  const plain = await stagesFor(checkout(null));
  assert.equal(plain.repo, null);
  assert.equal(b2.seen[0].url, "/plugin/config");
  await b2.close();
});

test("a repo the key cannot report to says so and names no repo", async () => {
  const b = await board(() => [403, { error: "No project for this repo that this key can report to" }]);
  process.env.PIPEXP_URL = b.url;
  const dir = checkout("https://github.com/other/private");
  const r = await stagesFor(dir);
  await b.close();
  assert.equal(r.lanes, null);
  assert.match(r.reason, /no PipeXP project/);
  assert.equal(routedRepo(dir), null);
});
