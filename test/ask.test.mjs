// Asking a person: the link to the question, and the answer read on the next long-poll.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ask, questionLink } from "../core/ask.mjs";

test("the question link opens it on its own on the machine's board", () => {
  assert.equal(questionLink("https://board.example/", "q-1"), "https://board.example/?question=q-1");
  assert.equal(questionLink(undefined, "a b"), "https://pipexp.dev/?question=a%20b");
});

test("ask shares the link as soon as the board has the question, then returns the answer from the long-poll", async () => {
  let asked = null;
  let polls = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/questions") {
        asked = JSON.parse(body);
        res.statusCode = 201;
        return res.end(JSON.stringify({ ok: true }));
      }
      if (req.method === "GET" && req.url.startsWith("/questions/")) {
        polls++;
        return res.end(JSON.stringify(polls < 2 ? { status: "waiting" } : { status: "answered", answer: "Keep it", answeredBy: "derek@cmdz.ltd" }));
      }
      res.statusCode = 202;
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, r));
  const url = "http://127.0.0.1:" + server.address().port;
  const home = mkdtempSync(join(tmpdir(), "pipexp-ask-"));
  writeFileSync(join(home, "credentials.json"), JSON.stringify({ url, key: "nudj_rk_" + "a".repeat(43), boardUrl: "https://board.example" }));
  const before = process.env.PIPEXP_HOME;
  process.env.PIPEXP_HOME = home;
  try {
    let shared = null;
    const r = await ask({ sessionId: "s-1", question: "Keep the export button?", options: ["Keep it", "Remove it"], wait: 30, onAsked: (link) => (shared = link) });
    assert.equal(asked.question, "Keep the export button?");
    assert.equal(shared, "https://board.example/?question=" + asked.questionId);
    assert.deepEqual(r, { status: "answered", questionId: asked.questionId, answer: "Keep it", answeredBy: "derek@cmdz.ltd", link: shared });
  } finally {
    process.env.PIPEXP_HOME = before;
    server.close();
  }
});
