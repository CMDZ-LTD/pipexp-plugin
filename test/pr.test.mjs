// CMD-427: a session learns its PR through the flush, never in a hook, and its run's events carry it to the board.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  git("remote", "add", "origin", "https://github.com/acme/shop.git");
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

// CMD-427 review: gh is optional and never interactive, and only ever runs for a GitHub repo.
function repoWith(remote) {
  const repo = mkdtempSync(join(tmpdir(), "pipexp-pr-remote-"));
  const git = (...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "codex/abc-12-fix-login");
  if (remote) git("remote", "add", "origin", remote);
  return repo;
}
function ghThat(script) {
  const bin = mkdtempSync(join(tmpdir(), "pipexp-gh-"));
  const log = join(bin, "calls.log");
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho \"$@\" >> " + log + "\n" + script + "\n");
  chmodSync(join(bin, "gh"), 0o755);
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}
const onPath = async (bin, fn) => {
  const path = process.env.PATH;
  process.env.PATH = bin + ":" + path;
  try {
    return await fn();
  } finally {
    process.env.PATH = path;
  }
};

test("with no gh installed, or gh signed out, the lookup quietly finds no PR, fast, and never waits for input", async () => {
  const { lookUpPr } = await import("../core/pr.mjs");
  const repo = repoWith("https://github.com/acme/shop.git");
  const s = { sessionId: "no-gh", cwd: repo, gitBranch: "codex/abc-12-fix-login" };
  // No gh at all: a PATH with only git on it.
  const gitDir = spawnSync("sh", ["-c", "dirname \"$(command -v git)\""], { encoding: "utf8" }).stdout.trim();
  const path = process.env.PATH;
  process.env.PATH = gitDir;
  let t0 = Date.now();
  try {
    assert.equal(lookUpPr(s), null);
  } finally {
    process.env.PATH = path;
  }
  assert.ok(Date.now() - t0 < 3000, "no gh: at once");
  // Signed out: gh says so on stderr and exits 4.
  const out = ghThat("echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4");
  assert.equal(await onPath(out.bin, () => lookUpPr(s)), null);
  assert.equal(out.calls().length, 1);
  // A gh that would sit waiting for an answer: it gets no input (stdin closed) and no prompts, so it cannot hang the flush.
  const asks = ghThat("if [ \"$GH_PROMPT_DISABLED\" != 1 ]; then sleep 30; fi; read answer; echo '{\"number\":5,\"headRefName\":\"codex/abc-12-fix-login\"}'");
  t0 = Date.now();
  assert.equal(await onPath(asks.bin, () => lookUpPr(s)), 5);
  assert.ok(Date.now() - t0 < 3000, "never waits on a prompt or on stdin");
});

test("a repo whose origin is not on GitHub (or has none) never runs gh; a GitHub one names its repo", async () => {
  const { lookUpPr } = await import("../core/pr.mjs");
  const gh = ghThat("echo '{\"number\":7,\"headRefName\":\"codex/abc-12-fix-login\"}'");
  for (const remote of ["https://gitlab.com/acme/shop.git", "git@bitbucket.org:acme/shop.git", "https://git.acme.test/shop.git", null]) {
    const s = { sessionId: "not-gh", cwd: repoWith(remote), gitBranch: "codex/abc-12-fix-login" };
    assert.equal(await onPath(gh.bin, () => lookUpPr(s)), null, String(remote));
  }
  assert.deepEqual(gh.calls(), [], "gh never ran");
  const s = { sessionId: "is-gh", cwd: repoWith("git@github.com:acme/shop.git"), gitBranch: "codex/abc-12-fix-login" };
  assert.equal(await onPath(gh.bin, () => lookUpPr(s)), 7);
  assert.deepEqual(gh.calls(), ["pr view codex/abc-12-fix-login --repo acme/shop --json number,headRefName"]);
});
