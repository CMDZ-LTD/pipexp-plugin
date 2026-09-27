// CMD-370 soak, 27 Sep 11:30 UTC: an agent called pipexp_report_snag with kind "flaky" and "note" instead of "what". Codex
// does not hold agents to an MCP tool's enum or required fields, so the board got kind "flaky", refused the event (400,
// kind) and the snag was lost. A snag must reach the board whatever the agent passed: this is the MCP server and the CLI
// as agents and skills run them, then every queued snag against the board's contract fixture.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { freshHome } from "./helpers.mjs";

const home = freshHome();
const { snagFields, SNAG_KINDS } = await import("../core/session.mjs");
const contract = JSON.parse(readFileSync(new URL("./fixtures/board-contract.json", import.meta.url), "utf8"))["snag.reported"];
const env = { PATH: process.env.PATH, PIPEXP_HOME: home, PIPEXP_NO_FLUSH: "1", PIPEXP_TEST: "1", PIPEXP_RUNTIME: "codex" };

function mcp(args) {
  return new Promise((done) => {
    const server = spawn(process.execPath, [new URL("../mcp/server.mjs", import.meta.url).pathname], { env });
    let out = "";
    server.stdout.on("data", (d) => {
      out += d;
      const line = out.split("\n").find((l) => l.includes('"id":1'));
      if (line) {
        server.kill();
        done(JSON.parse(line).result);
      }
    });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pipexp_report_snag", arguments: args } }) + "\n");
  });
}
const snags = () => {
  try {
    return readdirSync(join(home, "state", "outbox")).filter((n) => n.endsWith(".json")).sort()
      .map((n) => JSON.parse(readFileSync(join(home, "state", "outbox", n), "utf8")).event).filter((e) => e.type === "snag.reported");
  } catch {
    return [];
  }
};
// The board's snag kinds, exactly: agent-pipeline lib/event-schema.ts SNAG_KINDS.
const BOARD_KINDS = ["snag", "wrong-doc", "missing-script", "gate", "evidence", "worked"];

test("an unknown kind goes to the board as snag, keeping the agent's word in theme; the snag is never refused", async () => {
  const note = "load.yml failed #459 by 8 ms on the first card at 1440; re-ran.";
  const reply = await mcp({ session_id: "snag-1", cwd: home, kind: "flaky", note });
  assert.match(reply.content[0].text, /Snag recorded as kind snag \("flaky" is not one of snag, wrong-doc/);
  const [sent] = snags();
  assert.equal(sent.kind, "snag");
  assert.equal(sent.theme, "flaky");
  assert.equal(sent.what, note, "note stands in for the missing what");
  assert.equal(sent.costMin, null);
  assert.ok(!("note" in sent), "a field the board does not know never goes");
  // Every field the board's strict schema takes, and nothing else (lib/plugin-contract.test.ts).
  for (const key of Object.keys(sent)) assert.ok(key in contract || ["ticket", "attemptId", "repo"].includes(key), "sends " + key);
  assert.deepEqual(SNAG_KINDS, BOARD_KINDS);
});

test("known kinds pass, in any case or with underscores; theme keeps the unknown word when both fit", () => {
  assert.equal(snagFields({ kind: "Wrong_Doc", theme: "t", what: "w" }).kind, "wrong-doc");
  assert.equal(snagFields({ kind: "gate", theme: "t", what: "w" }).kind, "gate");
  assert.deepEqual(snagFields({ kind: "flaky", theme: "e2e checkout", what: "w" }), { kind: "snag", theme: "flaky: e2e checkout", what: "w", costMin: null });
  assert.equal(snagFields({ kind: "flaky", theme: "a flaky e2e", what: "w" }).theme, "a flaky e2e", "already named");
  assert.equal(snagFields({ kind: "x".repeat(40), theme: "y".repeat(30), what: "w" }).theme, "y".repeat(30), "no room: the agent's theme wins");
  // Nothing at all still makes a snag the board takes: required text is never empty.
  assert.deepEqual(snagFields({}), { kind: "snag", theme: "snag", what: "A snag", costMin: null });
  assert.equal(snagFields({ kind: "snag", theme: "t", what: "w", costMin: -3 }).costMin, null);
});

test("the CLI and a skill's pipexp event snag.reported take the same path", () => {
  const cli = new URL("../bin/pipexp.mjs", import.meta.url).pathname;
  const r = spawnSync(process.execPath, [cli, "event", "snag.reported", "--session", "snag-2", "--json", JSON.stringify({ kind: "timeout", theme: "CI", what: "Runner timed out", costMin: 5, extra: "x" })], { env, cwd: home, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const sent = snags().at(-1);
  assert.deepEqual([sent.kind, sent.theme, sent.what, sent.costMin, "extra" in sent], ["snag", "timeout: CI", "Runner timed out", 5, false]);
  for (const e of snags()) assert.ok(BOARD_KINDS.includes(e.kind), e.kind);
});
