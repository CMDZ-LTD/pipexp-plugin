// Live updates: a new release reaches sessions that are already running, with no restart of Codex or Claude Code.
// The flush downloads each new release tag into ~/.config/pipexp/code/<version> (update). The hook, the MCP server and
// the CLI shim are thin launchers that run the newest of that and the copy the agent installed (liveRoot).
// pipexp auto-update off turns it off and deletes the downloads.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codeDir, home, readJson, underTest, VERSION, writeJson } from "./config.mjs";
import { latestKnown, newer } from "./health.mjs";

const REPO = "https://codeload.github.com/CMDZ-LTD/pipexp-plugin/tar.gz/refs/tags/v";
const SEMVER = /^\d+\.\d+\.\d+$/;
const settingsFile = () => join(home(), "settings.json");
const current = () => readJson(join(codeDir(), "current.json"))?.version ?? null;

/** On unless this machine's owner ran pipexp auto-update off. */
export const autoUpdate = () => readJson(settingsFile())?.autoUpdate !== false;
export function setAutoUpdate(on) {
  writeJson(settingsFile(), { ...(readJson(settingsFile()) ?? {}), autoUpdate: !!on });
  if (!on) rmSync(codeDir(), { recursive: true, force: true });
}

/** The folder of the newest downloaded release when it is ahead of the copy running (version), else null. */
export function liveRoot(version = VERSION) {
  if (!autoUpdate()) return null;
  const v = current();
  if (!v || !SEMVER.test(v) || !newer(v, version)) return null;
  const root = join(codeDir(), v);
  return existsSync(join(root, "core", "config.mjs")) ? root : null;
}

/**
 * Downloads the newest release (checkLatest's answer) when it is ahead of both the copy running and the last download.
 * Only a whole release of that very version is kept; the one before stays, as a running server may still be on it.
 * Never throws. Tests pass their own fetch.
 */
export async function update(get = fetch, latest = latestKnown()) {
  if (!autoUpdate() || !latest || !SEMVER.test(latest) || !newer(latest, VERSION)) return null;
  const have = current();
  if (have && !newer(latest, have)) return null;
  if (underTest() && get === fetch) return null;
  const tmp = join(codeDir(), ".tmp-" + process.pid);
  try {
    const res = await get(REPO + latest, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    writeFileSync(tmp + ".tgz", Buffer.from(await res.arrayBuffer()));
    const x = spawnSync("tar", ["-xzf", tmp + ".tgz", "-C", tmp, "--strip-components=1"], { timeout: 30_000 });
    const whole = x.status === 0 && readJson(join(tmp, "package.json"))?.version === latest && existsSync(join(tmp, "hooks", "hook.mjs")) && existsSync(join(tmp, "mcp", "tools.mjs"));
    if (!whole) return null;
    const dest = join(codeDir(), latest);
    rmSync(dest, { recursive: true, force: true });
    renameSync(tmp, dest);
    writeJson(join(codeDir(), "current.json"), { version: latest, at: Date.now() });
    const kept = readdirSync(codeDir()).filter((d) => SEMVER.test(d)).sort((a, b) => (newer(a, b) ? -1 : 1)).slice(2);
    for (const old of kept) rmSync(join(codeDir(), old), { recursive: true, force: true });
    return latest;
  } catch {
    return null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(tmp + ".tgz", { force: true });
  }
}
