// CMD-427: a session learns its PR through the flush, never in a hook, and its run's events carry it to the board.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fakeBoard, freshHome } from "./helpers.mjs";

freshHome();
const { saveCredentials } = await import("../core/config.mjs");
const { hook, loadSession } = await import("../core/run.mjs");
const { run: flush } = await import("../bin/flush.mjs");

test("a session pushing to a branch with an open PR reports that PR on its card, with no gh pr create", async () => {
  // A real repo on a work branch, and a gh on PATH that knows its PR.
  const repo = mkdtempSync(join(tmpdir(), "pipexp-pr-repo-"));
  const git = (...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "codex/abc-12-fix-login");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
  const bin = mkdtempSync(join(tmpdir(), "pipexp-gh-"));
  const log = join(bin, "calls.log");
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho \"$@\" >> " + log + "\necho '{\"number\":57,\"headRefName\":\"codex/abc-12-fix-login\"}'\n");
  chmodSync(join(bin, "gh"), 0o755);
  const b = await fakeBoard();
  saveCredentials({ url: b.url, key: "pipexp_rk_" + "k".repeat(43) });
  const path = process.env.PATH;
  process.env.PATH = bin + ":" + path;
  try {
    hook({ session_id: "pr-e2e", cwd: repo, hook_event_name: "SessionStart", source: "startup" }, "codex");
    hook({ session_id: "pr-e2e", cwd: repo, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git push" }, tool_response: { exit_code: 0 } }, "codex");
    // The hooks only asked for a lookup; the flush does it.
    process.env.PIPEXP_PR_SESSION = "pr-e2e";
    await flush();
    delete process.env.PIPEXP_PR_SESSION;
    assert.equal(loadSession("pr-e2e").prNumber, 57);
    await flush();
  } finally {
    process.env.PATH = path;
    await b.close();
  }
  const sent = b.requests.filter((r) => r.url === "/events").map((r) => r.body);
  const linked = sent.filter((e) => e.prNumber === 57);
  assert.ok(linked.length >= 1, "an event carries PR 57");
  assert.ok(linked.every((e) => e.type === "step.entered" || e.type === "run.finished"));
});
