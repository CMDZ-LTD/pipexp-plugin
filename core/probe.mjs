// What a hook reads from the machine: git, Codex's thread names, the Nudj ship skill's claims. All fail soft.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
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
 * The ticket this session holds a Nudj ship claim on, while the ship skill still sends its own telemetry
 * (its claim-run.sh writes <git common dir>/ship/<ticket>/owner.lock/owner.json with the Codex task id).
 */
export function shipClaim(cwd, sessionId) {
  const g = git(cwd);
  if (!g?.common || !g.top) return null;
  if (!existsSync(join(g.top, ".claude", "skills", "ship", "scripts", "telemetry", "emit.mjs"))) return null;
  const root = join(g.common, "ship");
  let tickets = [];
  try {
    tickets = readdirSync(root);
  } catch {
    return null;
  }
  for (const ticket of tickets) {
    try {
      const owner = JSON.parse(readFileSync(join(root, ticket, "owner.lock", "owner.json"), "utf8"));
      if (owner.task === sessionId) return ticket;
    } catch {}
  }
  return null;
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
