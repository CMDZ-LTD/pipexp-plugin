// What a hook reads from the machine: git, Codex's thread names, a ship skill's claims. All fail soft.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, normalize } from "node:path";

export function git(cwd) {
  if (!cwd) return null;
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD", "--show-toplevel", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
    timeout: 2000,
  });
  if (r.status !== 0) return null;
  const [branch, top, common] = r.stdout.trim().split("\n");
  return { branch, repo: top ? basename(top) : null, top, common };
}

/** The last bytes of a file, cut to whole lines. */
export function tail(path, bytes) {
  try {
    const size = statSync(path).size;
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(Math.min(size, bytes));
    readSync(fd, buf, 0, buf.length, size - buf.length);
    closeSync(fd);
    const s = buf.toString("utf8");
    return size > bytes ? s.slice(s.indexOf("\n") + 1) : s;
  } catch {
    return "";
  }
}

/** The first lines of a file, reading at most max bytes (the last, possibly cut, line is dropped when the read stops early). */
export function headLines(path, max = 512 * 1024) {
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    closeSync(fd);
    const s = buf.subarray(0, n).toString("utf8");
    const lines = s.split("\n");
    if (n === max) lines.pop();
    return lines.filter(Boolean);
  } catch {
    return [];
  }
}

export const firstLine = (path, max) => headLines(path, max)[0] ?? "";

const rows = (path, max) =>
  headLines(path, max).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return {};
    }
  });

/**
 * The harness's own short name for a session: Codex keeps it in ~/.codex/session_index.jsonl, Claude Code writes
 * a custom-title (or ai-title) row into the transcript. Null when there is none yet.
 */
export function threadName(sessionId, transcriptPath) {
  if (transcriptPath && !transcriptPath.includes("/sessions/")) {
    const lines = tail(transcriptPath, 256 * 1024).split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!/"type":"(custom-title|ai-title|summary)"/.test(lines[i])) continue;
      try {
        const row = JSON.parse(lines[i]);
        const title = row.customTitle ?? row.aiTitle ?? row.title ?? row.summary;
        if (typeof title === "string" && title.trim()) return title.trim().slice(0, 200);
      } catch {}
    }
    return null;
  }
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const lines = tail(join(codexHome, "session_index.jsonl"), 256 * 1024).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(sessionId)) continue;
    try {
      const row = JSON.parse(lines[i]);
      if (row.id === sessionId && typeof row.thread_name === "string" && row.thread_name.trim()) return row.thread_name.trim();
    } catch {}
  }
  return null;
}

/** "codex 0.155.1" or "claude 2.1.270" from the transcript's first lines, or undefined. */
/** When the transcript began (ms), from its first line; undefined when unknown. */
export function sessionStart(transcriptPath) {
  if (!transcriptPath) return undefined;
  // Codex's first line carries the time; Claude Code's first rows (queue operations) do too.
  for (const row of rows(transcriptPath, 64 * 1024)) {
    const t = Date.parse(row.timestamp);
    if (!Number.isNaN(t)) return t;
  }
  return undefined;
}

export function runtimeVersion(runtime, transcriptPath) {
  if (!transcriptPath) return undefined;
  // Codex: session_meta.cli_version on line 1. Claude Code: "version" on its first user or attachment row.
  for (const row of rows(transcriptPath, runtime === "codex" ? 512 * 1024 : 64 * 1024)) {
    const v = runtime === "codex" ? row.payload?.cli_version : row.version;
    if (typeof v !== "string") continue;
    const out = runtime + " " + v;
    return /^(codex|claude) [0-9A-Za-z.+-]{1,40}$/.test(out) ? out : undefined;
  }
  return undefined;
}

/**
 * This machine's GitHub login, for "Created by" on its cards (CMD-370): gh's own config, else git config github.user.
 * Read from files only, never the network. Null when unknown.
 */
export function githubLogin() {
  const dir = process.env.GH_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "gh");
  let login = null;
  try {
    // The github.com block's own "user:" line; "users:" (one entry per account) and tokens are never read.
    login = readFileSync(join(dir, "hosts.yml"), "utf8").match(/^github\.com:[^\n]*\n(?:[ \t][^\n]*\n)*?[ \t]+user:[ \t]*["']?([A-Za-z0-9-]+)/m)?.[1] ?? null;
  } catch {}
  if (!login) login = spawnSync("git", ["config", "--get", "github.user"], { encoding: "utf8", timeout: 2000 }).stdout?.trim() || null;
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login ?? "") ? login : null;
}

/**
 * The ticket this session holds a ship claim on, while the ship skill still sends its own telemetry
 * (its claim-run.sh writes <git common dir>/ship/<ticket>/owner.lock/owner.json with the Codex task id).
 * A session can hold more than one (a ticket claimed, then left for another): the one whose state.json names this
 * worktree wins, then the one named in the branch, so the card follows the ticket being worked on (NJ-3331 joined a
 * stale NJ-3256 claim, CMD-535).
 */
export function shipClaim(cwd, sessionId, g = git(cwd)) {
  if (!g?.common || !g.top) return null;
  if (!existsSync(join(g.top, ".claude", "skills", "ship", "scripts", "telemetry", "emit.mjs"))) return null;
  const root = join(g.common, "ship");
  let tickets = [];
  try {
    tickets = readdirSync(root);
  } catch {
    return null;
  }
  const held = [];
  for (const ticket of tickets) {
    try {
      const owner = JSON.parse(readFileSync(join(root, ticket, "owner.lock", "owner.json"), "utf8"));
      if (owner.task === sessionId) held.push(ticket);
    } catch {}
  }
  if (held.length < 2) return held[0] ?? null;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  const top = real(g.top);
  // NJ-3331 in codex/nj-3331-x or nj3331-group-d, never inside nj-33310.
  const named = (ticket) => {
    const [key, n] = ticket.toLowerCase().split("-");
    return new RegExp("(^|[^a-z0-9])" + key + "[-_]?" + n + "(?![0-9])").test(String(g.branch ?? "").toLowerCase());
  };
  return (
    held.find((ticket) => { const w = readJson(join(root, ticket, "state.json"))?.worktree; return typeof w === "string" && real(w) === top; }) ??
    held.find(named) ??
    held[0]
  );
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TICKET = /^[A-Z][A-Z0-9]{0,9}-\d{1,6}$/;
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

/**
 * A ship ticket's state from <git common dir>/ship/<ticket>/: who holds its claim, its board run id (the scripts clear it
 * when they finish the run), status and PR (what the scripts' own finish reports), start fields and the step in progress.
 * Undefined when git can't be read (say nothing), null when the ticket has no state.
 */
export function shipState(cwd, ticket, g = git(cwd)) {
  if (!g?.common) return undefined;
  if (!TICKET.test(ticket ?? "")) return null;
  const dir = join(g.common, "ship", ticket);
  const state = readJson(join(dir, "state.json"));
  if (!state) return null;
  let fields = null;
  try {
    const f = typeof state.runFields === "string" ? JSON.parse(state.runFields) : state.runFields;
    if (f && typeof f === "object") fields = { title: f.title ?? null, owner: f.owner ?? null, profile: f.profile ?? null, branch: f.branch ?? null };
  } catch {}
  // Step 11 (log findings) runs alongside the others: the step in progress is the latest of 0 to 10.
  const steps = Array.isArray(state.steps) ? state.steps : [];
  const doing = steps.filter((s) => s?.status === "in_progress").map((s) => Number(s.step ?? s.id)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 10);
  return {
    ticket,
    // The lock folder itself: gone once the claim is released. Its owner.json is rewritten on every heartbeat (not
    // atomically), so an unreadable owner proves nothing.
    locked: existsSync(join(dir, "owner.lock")),
    owner: readJson(join(dir, "owner.lock", "owner.json"))?.task ?? null,
    runId: RUN_ID.test(state.runId ?? "") ? state.runId.toLowerCase() : null,
    status: typeof state.status === "string" ? state.status : null,
    pr: Number.isInteger(state.pr) && state.pr > 0 ? state.pr : null,
    fields,
    step: doing.length ? Math.max(...doing) : null,
  };
}

/**
 * The ship run this session's claim belongs to (shipState of the claimed ticket). Null when this session holds no claim,
 * undefined when git can't be read. One git call.
 */
export function shipRun(cwd, sessionId) {
  const g = git(cwd);
  if (!g?.common || !g.top) return undefined;
  const ticket = shipClaim(cwd, sessionId, g);
  return ticket ? shipState(cwd, ticket, g) ?? null : null;
}

/** The fingerprint the ship scripts send: a skill's version from SKILL.md and a hash of its files (same bytes as emit.mjs skillTree). */
export function skillInfo(cwd, skill) {
  const g = git(cwd);
  if (!g?.top) return undefined;
  for (const base of [".claude/skills", ".agents/skills", ".codex/skills"]) {
    const dir = join(g.top, base, skill);
    if (!existsSync(join(dir, "SKILL.md"))) continue;
    const out = {};
    const m = readFileSync(join(dir, "SKILL.md"), "utf8").match(/^---\n[\s\S]*?^ {2}version:\s*(\S+)[\s\S]*?^---$/m);
    if (m && /^v?\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]{1,20})?$/.test(m[1])) out.skillVersion = m[1];
    const listed = spawnSync("git", ["-C", dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], { encoding: "utf8", timeout: 3000 });
    if (listed.status === 0) {
      const hash = createHash("sha256");
      for (const file of listed.stdout.split("\0").filter(Boolean).sort()) {
        const path = join(dir, file);
        if (!existsSync(path)) continue;
        hash.update(normalize(file) + "\0");
        hash.update(readFileSync(path));
        hash.update("\0");
      }
      out.skillTree = hash.digest("hex").slice(0, 16);
    }
    return out;
  }
  return undefined;
}

/** The PR the flush found for this session's branch (core/pr.mjs), or null. A file read, never the network. */
export { cachedPr as pr } from "./pr.mjs";
