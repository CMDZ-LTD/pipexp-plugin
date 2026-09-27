// The PR a session's branch has (CMD-427), so its run links to the merge it produced. A hook never asks GitHub: it
// only reads the small answer file here. The detached flush asks gh (no shell, 8 s cap) when the branch is new to
// this session, just after a push, or every CHECK_MS while the branch has no PR yet. Fails soft: no gh, no PR.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readJson, stateDir, writeJson } from "./config.mjs";
import { repoOf } from "./stages.mjs";

export const CHECK_MS = 10 * 60_000;
// A default branch is never one piece of work, so its PR (if any) is not this session's.
const TRUNKS = new Set(["main", "master", "develop", "trunk", "HEAD"]);
const safe = (id) => String(id).replace(/[^\w.-]/g, "_").slice(0, 120);
const fileOf = (sessionId) => join(stateDir(), "prs", safe(sessionId) + ".json");

/** The PR number cached for this session's branch, or null. */
export function cachedPr(sessionId, branch) {
  const c = readJson(fileOf(sessionId));
  return c && branch && c.branch === branch && Number.isInteger(c.number) && c.number > 0 ? c.number : null;
}

/** Whether the flush should ask gh for this session's PR now. pushed: this hook was a push or gh pr create. */
export function prDue(sessionId, branch, pushed = false, now = Date.now()) {
  if (!branch || TRUNKS.has(branch)) return false;
  const c = readJson(fileOf(sessionId));
  if (!c || c.branch !== branch) return true;
  if (c.number) return false;
  return pushed || now - (c.checkedAt ?? 0) >= CHECK_MS;
}

/** Marks the check as started, so hooks until the flush answers do not start another. */
export function markPrChecked(sessionId, branch, now = Date.now()) {
  const c = readJson(fileOf(sessionId));
  try {
    writeJson(fileOf(sessionId), { branch, number: c?.branch === branch ? (c.number ?? null) : null, checkedAt: now });
  } catch {}
}

// gh never asks anything, never checks for its own update, and gets no input: with no gh, or gh signed out, the call
// fails at once and the session simply has no PR.
const GH_ENV = { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", NO_COLOR: "1" };

/**
 * Asks gh for the PR of the session's branch (open, merged or closed) and saves the answer. Returns the number or null.
 * Only for a folder whose origin is on github.com: gh is never run for any other remote, or none.
 */
export function lookUpPr(session, run = spawnSync, now = Date.now(), repo = repoOf) {
  const branch = session?.gitBranch;
  if (!session?.cwd || !branch || TRUNKS.has(branch)) return null;
  let number = null;
  const slug = repo(session.cwd);
  try {
    const r = slug && run("gh", ["pr", "view", branch, "--repo", slug, "--json", "number,headRefName"], {
      cwd: session.cwd, encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ...GH_ENV },
    });
    const pr = r?.status === 0 ? JSON.parse(r.stdout) : null;
    if (pr?.headRefName === branch && Number.isInteger(pr.number) && pr.number > 0) number = pr.number;
  } catch {}
  try {
    writeJson(fileOf(session.sessionId), { branch, number, checkedAt: now });
  } catch {}
  return number;
}
