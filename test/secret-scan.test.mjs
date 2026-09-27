// CMD-471: the board's secret scan (CMD-469), in the plugin repo. One fake of each key shape, built at run time so this
// file never holds one. A failure names the case by number and rule, never the fake.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { allowList, entropy, findSecrets, RULES } from "../scripts/secret-scan.mjs";

// A fixed random-looking value: 33 bytes as base64, digits and letters, about 5 bits a character.
const random = Buffer.from(Array.from({ length: 33 }, (_, i) => (i * 97 + 13) % 256)).toString("base64");
const FAKES = [
  ["private key", "-----BEGIN " + "RSA PRIVATE KEY-----"],
  ["private key", "-----BEGIN " + "OPENSSH PRIVATE KEY-----"],
  ["GitHub token", "gh" + "p_" + "aB3d".repeat(9)],
  ["GitHub token", "gh" + "s_" + "Zy9x".repeat(9)],
  ["GitHub token", "github" + "_pat_" + "11AAQ0XYZ0" + "_" + "k7Tf".repeat(15)],
  ["PipeXP reporting key", "pipexp" + "_rk_" + "Hq7-Lm2_".repeat(6)],
  ["PipeXP reporting key", "nudj" + "_rk_" + "Hq7-Lm2_".repeat(6)],
  ["Stripe live key", "sk" + "_live_" + "51Hx" + "Ab9c".repeat(6)],
  ["Resend key", "re" + "_Ab3dEf9h_" + "Kd8s".repeat(6)],
  ["high-entropy secret", "WEBHOOK_SECRET=" + random],
  ["high-entropy secret", '{ "clientSecret": "' + random + '" }'],
];
const TOKEN = FAKES[2][1];
const script = path.resolve("scripts/secret-scan.mjs");

test("finds one fake of each shape, and names the rule and line, never the value", () => {
  FAKES.forEach(([rule, fake], i) => assert.deepEqual(findSecrets("first line\n" + fake), [{ rule, line: 2 }], "fake " + i + " (" + rule + ")"));
  assert.deepEqual(new Set(FAKES.map(([rule]) => rule)), new Set([...RULES.map((r) => r.name), "high-entropy secret"]));
});

test("leaves alone the plugin's own key patterns, test keys, hashes and short values", () => {
  const fine = [
    // core/scrub.mjs's own pattern.
    "/\\b(?:sk|pk|rk)_(?:live|test)_\\w+|\\bgh[pousr]_\\w+|\\bgithub_pat_\\w+|\\bpipexp_rk_[\\w-]+/g",
    "STRIPE_SECRET_KEY=sk_test_" + "Ab9c".repeat(8),
    "cacheKey: " + "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "pipexp" + "_rk_" + "short",
  ];
  fine.forEach((line, i) => assert.deepEqual(findSecrets(line), [], "near miss " + i));
  assert.equal(entropy("ab".repeat(30)), 1);
  assert.ok(entropy(random) > 4.5);
});

test("finishes a 2 MB line fast", () => {
  const start = performance.now();
  assert.deepEqual(findSecrets("a".repeat(2_000_000)), []);
  assert.ok(performance.now() - start < 5_000, "long line time");
});

test("reads the allow-list: one exact path a line, comments and blanks skipped", () => {
  assert.deepEqual(allowList("# why\nlib/a.json\n\n  test/b.test.mjs  # fake\n"), new Set(["lib/a.json", "test/b.test.mjs"]));
});

/** A throwaway repo, and the CLI run in it as CI and the hook run it. */
function repo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-scan-"));
  const git = (...args) => execFileSync("git", ["-c", "user.email=ci@example.com", "-c", "user.name=CI", ...args], { cwd: dir, encoding: "utf8" });
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const run = (...args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8", stdio: "pipe" }) };
    } catch (e) {
      return { code: e.status, out: e.stderr };
    }
  };
  try {
    git("init", "-q");
    fn({ git, write, run });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("the hook refuses a staged fake without printing it; only the staged exact path allows it", () => repo(({ git, write, run }) => {
  write("docs/notes.md", "safe\nuse " + TOKEN + "\n");
  git("add", "docs/notes.md");
  const refused = run("--staged");
  assert.equal(refused.code, 1);
  assert.equal(refused.out.split("\n")[0], "docs/notes.md:2: looks like a GitHub token");
  assert.equal(refused.out.includes(TOKEN), false);
  write("scripts/secret-scan-allow.txt", "docs\ndocs/\n");
  git("add", "scripts/secret-scan-allow.txt");
  assert.equal(run("--staged").code, 1, "a folder covers nothing");
  write("scripts/secret-scan-allow.txt", "docs/notes.md\n");
  assert.equal(run("--staged").code, 1, "an unstaged allow-list edit does not count");
  git("add", "scripts/secret-scan-allow.txt");
  assert.equal(run("--staged").code, 0);
}));

test("with --commits, finds a key a branch added and then deleted, and refuses a missing range", () => repo(({ git, write, run }) => {
  write("README.md", "hello\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD").trim();
  write("config.env", "one\n" + "API_" + "KEY=" + random + "\n");
  git("add", ".");
  git("commit", "-q", "-m", "add");
  const added = git("rev-parse", "--short=8", "HEAD").trim();
  git("rm", "-q", "config.env");
  git("commit", "-q", "-m", "remove");
  assert.equal(run().code, 0);
  const history = run("--commits", base + "..HEAD");
  assert.equal(history.code, 1);
  assert.equal(history.out.split("\n")[0], "config.env:2: looks like a high-entropy secret in commit " + added);
  assert.equal(history.out.includes(random), false);
  assert.equal(run("--commits").code, 2);
}));

test("the repo itself is clean", () => {
  assert.match(execFileSync(process.execPath, [script], { encoding: "utf8" }), /No key-shaped strings\./);
});
