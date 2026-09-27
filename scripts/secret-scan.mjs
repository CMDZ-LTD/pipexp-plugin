// CMD-469: refuses key-shaped strings before they reach the repo. CI runs it on every tracked file, and on a PR also on
// every file each of its commits adds or changes, so a key added and deleted again inside the PR still fails. The
// optional pre-commit hook (scripts/hooks/pre-commit) runs it on what is staged. It names the rule and the line, never
// the value, so a hit never lands in a CI log. Fakes for the redaction tests are listed in scripts/secret-scan-allow.txt.
//
//   node scripts/secret-scan.mjs                        every tracked file
//   node scripts/secret-scan.mjs --commits BASE..HEAD   and every file each commit in the range adds or changes
//   node scripts/secret-scan.mjs --staged               the staged version of each staged file, with the staged allow-list
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const RULES = [
  { name: "private key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: "GitHub token", re: /\b(?:gh[opsur]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,})/ },
  // KEY_PREFIX or LEGACY_KEY_PREFIX (convex/reportingKeys.ts), then 43 base64url characters.
  { name: "PipeXP reporting key", re: /\b[a-z]{4,6}_rk_[A-Za-z0-9_-]{40,}/ },
  { name: "Stripe live key", re: /\b[sr]k_live_[A-Za-z0-9]{20,}/ },
  { name: "Resend key", re: /\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{20,}/ },
];
// A long random-looking value given to something named like a key, secret, token or password. \s spans line breaks,
// so a value on the line after its name counts too. Every part before the value is bounded and the name must start a
// word, so a megabyte of minified text or base64 costs one pass, not a pass per character.
const NAMED = /(?<![\w.-])[\w.-]{0,60}?(?:key|secret|token|password)[\w.-]{0,60}["']?\s{0,20}[:=]\s{0,20}["'\x60]?([A-Za-z0-9+/_=-]{41,})/gi;
const MIN_ENTROPY = 4.5;

/** Bits per character. Hex tops out at 4, so hashes and commit ids never pass MIN_ENTROPY; random base64 is about 5. */
export function entropy(text) {
  const counts = new Map();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length);
  return bits;
}

/** Each key-shaped string in one file's text: its rule and line. Never the value. */
export function findSecrets(text) {
  const found = [];
  text.split("\n").forEach((line, i) => {
    for (const rule of RULES) if (rule.re.test(line)) found.push({ rule: rule.name, line: i + 1 });
  });
  for (const m of text.matchAll(NAMED)) {
    const value = m[1];
    // Real secrets mix digits and letters; a long identifier or word does not.
    if (!/\d/.test(value) || !/[A-Za-z]/.test(value) || entropy(value) < MIN_ENTROPY) continue;
    const at = m.index + m[0].length - value.length;
    found.push({ rule: "high-entropy secret", line: text.slice(0, at).split("\n").length });
  }
  return found.sort((a, b) => a.line - b.line);
}

/** Paths in the allow-list: one exact file path per line, # starts a comment. A folder covers nothing. */
export const allowList = (text) => new Set(text.split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean));

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
const ALLOW = "scripts/secret-scan-allow.txt";
const list = (out) => out.split("\0").filter(Boolean);
// Images, fonts and zips. Text is scanned whatever its size.
const binary = (text) => text.slice(0, 8000).includes("\0");

/** Every hit: in the tracked files, or only the staged ones, plus each commit of a range. Allow-listed paths left out. */
export function scan({ staged = false, commits = null } = {}) {
  // The hook judges one snapshot: the staged allow-list, not an unstaged edit to it.
  const allowText = staged ? (list(git("ls-files", "-z", "--", ALLOW)).length ? git("show", ":" + ALLOW) : "") : fs.existsSync(ALLOW) ? fs.readFileSync(ALLOW, "utf8") : "";
  const allowed = allowList(allowText);
  const hits = [];
  const check = (path, text, where = "") => {
    if (allowed.has(path) || binary(text)) return;
    for (const hit of findSecrets(text)) hits.push({ path, where, ...hit });
  };
  if (staged) {
    for (const path of list(git("diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"))) check(path, git("show", ":" + path));
  } else {
    // A tracked file deleted in the working tree has nothing on disk to read.
    for (const path of list(git("ls-files", "-z"))) if (fs.existsSync(path) && fs.statSync(path).isFile()) check(path, fs.readFileSync(path, "utf8"));
  }
  if (commits) {
    for (const sha of git("rev-list", commits).split("\n").filter(Boolean)) {
      // -c: a merge lists only files that differ from every parent, which is what its conflict resolution wrote. Files it
      // took whole from main are main's, which main's own run covers. A plain commit lists what it added or changed.
      for (const path of list(git("diff-tree", "-r", "-c", "--root", "--no-commit-id", "--name-only", "-z", "--diff-filter=ACMR", sha))) {
        check(path, git("show", sha + ":" + path), " in commit " + sha.slice(0, 8));
      }
    }
  }
  // A key kept over several commits is one hit per place.
  const seen = new Set();
  return hits.filter((h) => !seen.has(h.path + h.line + h.rule) && seen.add(h.path + h.line + h.rule));
}

// Real paths on both sides: through a symlinked folder (macOS /tmp) a plain compare never matches, and the check would
// pass by doing nothing.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const at = process.argv.indexOf("--commits");
  const range = at === -1 ? null : process.argv[at + 1];
  // A missing or odd range would scan no history and still pass: refuse it instead.
  // Two refs joined by "..", neither starting with "-", so nothing reaches git as an option.
  if (at !== -1 && !/^[\w./][\w./-]*\.\.[\w./][\w./-]*$/.test(range ?? "")) {
    console.error("--commits needs a range, BASE..HEAD");
    process.exit(2);
  }
  const hits = scan({ staged: process.argv.includes("--staged"), commits: range });
  for (const h of hits) console.error(h.path + ":" + h.line + ": looks like a " + h.rule + h.where);
  if (hits.length) {
    console.error("\n" + hits.length + " key-shaped string" + (hits.length > 1 ? "s" : "") + ". Take it out and rotate the key if it was real. A fake in a test? Build it at run time, or list the file in scripts/secret-scan-allow.txt.");
    console.error("One only in an earlier commit is still in the history: rewrite the branch without it, or start a new one.");
    process.exitCode = 1;
  } else console.log("No key-shaped strings.");
}

