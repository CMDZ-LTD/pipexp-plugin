// This repo's lanes and stages, from the board (GET /plugin/config?repo=owner/name). Cached per repo, so an agent
// offline still sees the last list. Only the MCP tool and the CLI call it; hooks never wait on the network.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { credentials, readJson, stateDir, writeJson } from "./config.mjs";
import { call } from "./send.mjs";

/** "owner/name" from a GitHub remote URL (https or ssh), or null. */
export function repoSlug(url) {
  const m = /github\.com[:/]([A-Za-z0-9-]{1,39})\/([\w.-]{1,100}?)(?:\.git)?\/?$/.exec(String(url ?? "").trim());
  return m ? m[1] + "/" + m[2] : null;
}

/** The repo this folder's origin points at, or null. */
export function repoOf(cwd) {
  if (!cwd) return null;
  const r = spawnSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 2000 });
  return r.status === 0 ? repoSlug(r.stdout) : null;
}

const cacheFile = (repo) => join(stateDir(), "stages", (repo ?? "_default").replace(/[^\w.-]/g, "_") + ".json");

/** A board answer we can use: { lanes: [{ skill, label, stages: [{ id, label, human? }] }] }. */
export function validLanes(body) {
  if (!Array.isArray(body?.lanes)) return null;
  const ok = body.lanes.every((l) => typeof l?.skill === "string" && typeof l?.label === "string" && Array.isArray(l?.stages)
    && l.stages.every((s) => typeof s?.id === "string" && s.id.startsWith(l.skill + ":") && typeof s?.label === "string"));
  return ok ? body.lanes : null;
}

/**
 * { repo, lanes, from: "board" | "cache" } or { repo, lanes: null, reason }. repo is null outside a GitHub checkout:
 * then the board answers with the key's own project.
 */
export async function stagesFor(cwd) {
  const repo = repoOf(cwd);
  const creds = credentials();
  const cached = readJson(cacheFile(repo));
  if (!creds) return cached ? { repo, lanes: cached.lanes, from: "cache" } : { repo, lanes: null, reason: "not connected; run pipexp connect" };
  try {
    const res = await call(creds, "/plugin/config" + (repo ? "?repo=" + encodeURIComponent(repo) : ""), { method: "GET" });
    const lanes = res.status === 200 ? validLanes(res.body) : null;
    if (lanes) {
      writeJson(cacheFile(repo), { lanes, at: new Date().toISOString() });
      return { repo, lanes, from: "board" };
    }
    if (res.status === 403) return { repo, lanes: null, reason: "this repo has no PipeXP project you can report to" };
  } catch {
    // Offline or slow: the last list, if any.
  }
  return cached ? { repo, lanes: cached.lanes, from: "cache" } : { repo, lanes: null, reason: "the board did not answer" };
}

/**
 * The repo to name on this folder's events: only one the board already accepted for this key (its lanes are cached).
 * Otherwise null and events go to the key's own project, as before, so a repo with no project never loses a report.
 */
export function routedRepo(cwd) {
  const repo = repoOf(cwd);
  return repo && readJson(cacheFile(repo))?.lanes ? repo : null;
}

/** One line per lane, for a person or an agent: "ship (Ship): ship:S0 Check the tools, ship:S8 Review [waits on a person]". */
export const describe = (lanes) =>
  lanes.map((l) => l.skill + " (" + l.label + "): " + (l.stages.length ? l.stages.map((s) => s.id + " " + s.label + (s.human ? " [waits on a person]" : "")).join(", ") : "no stages yet")).join("\n");
