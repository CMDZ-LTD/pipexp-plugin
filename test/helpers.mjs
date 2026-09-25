// A private PIPEXP_HOME per test file, a fake board on localhost, and a fixed clock.
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), "pipexp-test-"));
  process.env.PIPEXP_HOME = dir;
  process.env.PIPEXP_NO_FLUSH = "1";
  delete process.env.PIPEXP_URL;
  delete process.env.PIPEXP_KEY;
  return dir;
}

/** A board that records requests. answers: statuses to return in order, then 201. */
export async function fakeBoard(answers = []) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, key: req.headers["x-api-key"], body: body ? JSON.parse(body) : null });
      const status = answers.length ? answers.shift() : 201;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status === 400 ? { error: "Invalid event", details: [{ path: ["what"], message: "bad secret-value-here" }] } : { ok: true }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + server.address().port;
  return { url, requests, close: () => new Promise((r) => server.close(r)) };
}

export const probe = (over = {}) => ({
  git: () => ({ branch: "codex/abc-12-fix-login", repo: "shop", top: "/repo", common: "/repo/.git" }),
  threadName: () => null,
  shipClaim: () => null,
  skillInfo: () => ({ skillVersion: "3.2.0", skillTree: "0123456789abcdef" }),
  ...over,
});

export const ctx = (now, over = {}) => ({ now, runtime: "codex", machineId: "9b2f6c1e-3d4a-4b5c-8d6e-7f8091a2b3c4", runtimeVersion: "codex 0.155.1", content: "standard", probe: probe(), ...over });
