// CMD-230: a question can name who it waits on (a GitHub login); the board shows its asker Blocked after 4 working
// hours unanswered. Through the MCP server and the CLI as processes, as agents and skills run them.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ask } from "../core/ask.mjs";

// The board's POST /questions fixture (agent-pipeline lib/plugin-contract.test.ts).
const contract = JSON.parse(readFileSync(new URL("./fixtures/board-contract.json", import.meta.url), "utf8"))["POST /questions"];

async function board() {
  const asked = [];
  const polled = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/questions") {
        asked.push(JSON.parse(body));
        res.statusCode = 201;
        return res.end("{}");
      }
      if (req.method === "GET" && req.url.startsWith("/questions/")) polled.push(req.url);
      if (req.method === "GET" && req.url.startsWith("/questions/")) return res.end(JSON.stringify({ status: "answered", answer: "Keep it", answeredBy: "ben@acme.test" }));
      res.statusCode = 202;
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const home = mkdtempSync(join(tmpdir(), "pipexp-ask-"));
  writeFileSync(join(home, "credentials.json"), JSON.stringify({ url: "http://127.0.0.1:" + server.address().port, key: "pipexp_rk_" + "a".repeat(43) }));
  return { home, asked, polled, close: () => new Promise((r) => server.close(r)) };
}

function run(file, args, home, stdin = "") {
  return new Promise((done) => {
    const p = spawn(process.execPath, [new URL(file, import.meta.url).pathname, ...args], { env: { PATH: process.env.PATH, PIPEXP_HOME: home, PIPEXP_NO_FLUSH: "1", PIPEXP_TEST: "1" } });
    let out = "";
    p.stdout.on("data", (d) => {
      out += d;
      if (stdin && out.includes('"id":1')) p.kill();
    });
    p.on("close", () => done(out));
    if (stdin) p.stdin.write(stdin);
    else p.stdin.end();
  });
}

test("pipexp_ask_human and pipexp ask name who the question waits on, and leave how long it stays open to the board", async () => {
  const b = await board();
  try {
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pipexp_ask_human", arguments: { session_id: "s-mcp", cwd: b.home, question: "Keep the export?", recipient: "@ben-orbit" } } };
    const reply = JSON.parse((await run("../mcp/server.mjs", [], b.home, JSON.stringify(call) + "\n")).split("\n").find((l) => l.includes('"id":1'))).result;
    assert.equal(JSON.parse(reply.content[0].text).answer, "Keep it");
    assert.equal(await run("../bin/pipexp.mjs", ["ask", "Ship on Friday?", "--recipient", "ben-orbit", "--session", "s-cli"], b.home), "Keep it\n");
    assert.equal(await run("../bin/pipexp.mjs", ["ask", "Rename it?", "--timeout-min", "30", "--session", "s-cli"], b.home), "Keep it\n");
    const [mcp, cli, plain] = b.asked;
    assert.equal(mcp.recipient, "ben-orbit", "a leading @ is dropped");
    assert.equal(cli.recipient, "ben-orbit");
    // Without a timeout the board keeps a question naming someone else open a day (an hour without one): none is sent.
    assert.equal("timeoutMin" in mcp || "timeoutMin" in cli, false);
    assert.equal(plain.timeoutMin, 30);
    // CMD-374: each question says where it was asked, so the board never files an off-repo one on this key's own
    // project; the poll finds it the same way, by origin and run.
    for (const q of b.asked) assert.ok(["repo", "none"].includes(q.origin), "every question says its origin");
    assert.ok(b.polled.length && b.polled.every((u) => /[?&]origin=(repo|none)&run=[0-9a-f-]{36}/.test(u)), b.polled.join(" "));
    assert.equal("recipient" in plain, false);
    // Only fields the board's strict schema takes.
    for (const q of b.asked) for (const key of Object.keys(q)) assert.ok(key in contract || ["repo", "ticket", "context", "timeoutMin", "origin"].includes(key), "sends " + key);
  } finally {
    await b.close();
  }
});

test("a recipient that is not a GitHub login is refused before anything is asked; minimal content names nobody", async () => {
  const b = await board();
  const before = process.env.PIPEXP_HOME;
  process.env.PIPEXP_HOME = b.home;
  try {
    // The board refuses these too (lib/plugin-contract.test.ts); an empty one is simply no recipient.
    for (const bad of ["ben orbit", "-ben", "ben@acme.test"]) {
      const r = await ask({ sessionId: "s-bad", question: "Keep it?", recipient: bad, wait: 5 });
      assert.equal(r.status, "failed", bad);
      assert.match(r.reason, /GitHub login/);
    }
    assert.equal(b.asked.length, 0);
    assert.equal((await ask({ sessionId: "s-none", question: "Keep it?", recipient: "", wait: 5 })).status, "answered");
    assert.equal("recipient" in b.asked[0], false);
    writeFileSync(join(b.home, "settings.json"), JSON.stringify({ content: "minimal" }));
    assert.equal((await ask({ sessionId: "s-min", question: "Keep it?", recipient: contract.recipient, wait: 5 })).status, "answered");
    assert.equal("recipient" in b.asked[1], false);
  } finally {
    process.env.PIPEXP_HOME = before;
    await b.close();
  }
});
