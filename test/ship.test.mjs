// Ship a ticket from the board: this machine opens a new Codex thread with the prompt in the composer, and never sends it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { freshHome } from "./helpers.mjs";

const home = freshHome();
const { allowShip, folderFor, plist, pollShips, shipAllowed, threadUrl } = await import("../core/ship.mjs");

/** A board whose GET /ship answers the given ships once, then none. */
async function board(ships) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, key: req.headers["x-api-key"] });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ships: seen.length === 1 ? ships : [] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { creds: { url: "http://127.0.0.1:" + server.address().port, key: "k".repeat(30) }, seen, close: () => new Promise((r) => server.close(r)) };
}
const checkout = mkdtempSync(join(tmpdir(), "pipexp-ship-"));
const session = (id, cwd, repo) => {
  mkdirSync(join(home, "state", "sessions"), { recursive: true });
  writeFileSync(join(home, "state", "sessions", id + ".json"), JSON.stringify({ sessionId: id, cwd, repo }));
};

test("off by default: nothing is asked or opened until the owner allows it", async () => {
  assert.equal(shipAllowed(), false);
  const b = await board([{ shipId: "a", ticket: "NJ-12", prompt: "$ship NJ-12", repo: "orbit/app" }]);
  const opened = [];
  assert.deepEqual(await pollShips(b.creds, (u) => opened.push(u)), []);
  assert.equal(b.seen.length, 0);
  await b.close();
  // Allowing needs the pipexp shim the first session writes.
  assert.match(allowShip(true).why, /Start one Codex or Claude Code session/);
  assert.equal(shipAllowed(), false);
});

test("allowed: opens a new Codex thread in the repo's checkout with the prompt, once, and never sends it", async () => {
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin", "pipexp"), "#!/bin/sh\n");
  assert.equal(allowShip(true).ok, true);
  assert.equal(shipAllowed(), true);
  session("s1", checkout, "orbit/app");
  const b = await board([{ shipId: "a", ticket: "NJ-12", prompt: "$ship NJ-12\n\nKeep it small", repo: "orbit/app" }]);
  const opened = [];
  const got = await pollShips(b.creds, (u) => opened.push(u));
  assert.deepEqual(got.map((g) => g.ticket), ["NJ-12"]);
  const url = new URL(opened[0]);
  assert.equal(url.protocol + "//" + url.host + url.pathname, "codex://threads/new");
  assert.equal(url.searchParams.get("prompt"), "$ship NJ-12\n\nKeep it small");
  assert.equal(url.searchParams.get("path"), checkout);
  // Handed out once by the board: the next poll opens nothing.
  assert.deepEqual(await pollShips(b.creds, (u) => opened.push(u)), []);
  assert.equal(opened.length, 1);
  assert.equal(b.seen[0].url, "/ship");
  // The log names the ticket, never the prompt.
  const log = readFileSync(join(home, "state", "ship.log"), "utf8");
  assert.match(log, /NJ-12\topened/);
  assert.doesNotMatch(log, /Keep it small/);
  await b.close();
});

test("refuses what is not a ship: a bad ticket, a huge prompt, a bad repo", async () => {
  const b = await board([
    { ticket: "NJ-1; rm -rf ~", prompt: "x", repo: "orbit/app" },
    { ticket: "NJ-2", prompt: "x".repeat(5000), repo: "orbit/app" },
    { ticket: "NJ-3", prompt: "x", repo: "../../etc" },
  ]);
  const opened = [];
  assert.deepEqual(await pollShips(b.creds, (u) => opened.push(u)), []);
  assert.equal(opened.length, 0);
  await b.close();
});

test("the folder: a worktree session opens in its main checkout; an unknown repo opens with no folder", () => {
  session("s2", checkout, "orbit/web");
  assert.equal(folderFor("orbit/web", () => "/nowhere/.git"), checkout, "a main checkout that is gone falls back to the session's folder");
  assert.equal(folderFor("Orbit/Web", () => join(checkout, ".git")), checkout);
  assert.equal(folderFor("orbit/unknown"), null);
  assert.equal(new URL(threadUrl("$ship NJ-1", null)).searchParams.has("path"), false);
});

test("the launchd job runs the shim with ship-poll on a timer, and deny turns Ship off", () => {
  const xml = plist("/Users/sam/.config/pipexp/bin/pipexp", "/tmp/err");
  assert.match(xml, /<string>\/Users\/sam\/.config\/pipexp\/bin\/pipexp<\/string><string>ship-poll<\/string>/);
  assert.match(xml, /<key>StartInterval<\/key><integer>20<\/integer>/);
  assert.equal(allowShip(false).ok, true);
  assert.equal(shipAllowed(), false);
});

