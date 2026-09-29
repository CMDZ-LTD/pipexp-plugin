// Ship a ticket from the board (Health > Planning). The owner of this machine's key picks this machine and presses Ship;
// this machine collects the request (GET /ship) and opens a new Codex thread in the project's folder with the prompt in
// the composer (codex://threads/new). It never sends the prompt: a person at this machine presses Enter. Off until the
// owner runs pipexp allow ship, which also starts a small launchd job that asks the board every 20 seconds (macOS).
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { credentials, home, readJson, stateDir, underTest, writeJson } from "./config.mjs";
import { call } from "./send.mjs";

export const LABEL = "dev.pipexp.ship";
export const EVERY_S = 20;
const TICKET = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/;
const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const MAX_PROMPT = 2500;

const settingsFile = () => join(home(), "settings.json");
/** Whether this machine's owner allowed Ship from the board. Off unless they ran pipexp allow ship. */
export const shipAllowed = () => readJson(settingsFile())?.ship === true;
const setShip = (on) => writeJson(settingsFile(), { ...(readJson(settingsFile()) ?? {}), ship: !!on });

/** The folder a thread for this repo opens in: the main checkout of the newest session there whose folder still exists. */
export function folderFor(repo, git = gitCommonDir) {
  const dir = join(stateDir(), "sessions");
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.at - a.at).slice(0, 300);
  } catch {
    return null;
  }
  for (const { f } of files) {
    const s = readJson(join(dir, f));
    if (!s?.cwd || String(s.repo ?? "").toLowerCase() !== repo.toLowerCase() || !existsSync(s.cwd)) continue;
    // A worktree's session opens the thread in its main checkout, which outlives the worktree.
    const common = git(s.cwd);
    return common && common.endsWith("/.git") && existsSync(dirname(common)) ? dirname(common) : s.cwd;
  }
  return null;
}
function gitCommonDir(cwd) {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", timeout: 3000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The Codex app link for a new thread with this prompt in the composer, in this folder when known. */
export const threadUrl = (prompt, folder) => "codex://threads/new?" + new URLSearchParams({ prompt, ...(folder && { path: folder }) }).toString();

/** Opens a link with the system's opener: an args array, no shell. */
function openUrl(url, run = spawn) {
  const [file, args] = platform() === "darwin" ? ["/usr/bin/open", [url]] : platform() === "win32" ? ["explorer.exe", [url]] : ["xdg-open", [url]];
  const child = run(file, args, { detached: true, shell: false, stdio: "ignore" });
  child.on?.("error", () => {});
  child.unref?.();
}

const log = (line) => {
  try {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    appendFileSync(join(stateDir(), "ship.log"), new Date().toISOString() + "\t" + line + "\n", { mode: 0o600 });
  } catch {}
};

/**
 * Asks the board for this machine's waiting ships and opens a thread for each. Never throws. Returns what it opened
 * ([{ ticket, url }]) for tests. Does nothing unless Ship is allowed here. open: how a link is opened (tests pass a fake).
 */
export async function pollShips(creds = credentials(), open = openUrl) {
  if (!shipAllowed() || !creds) return [];
  let res;
  try {
    res = await call(creds, "/ship", { method: "GET" }, 8000);
  } catch {
    return [];
  }
  const ships = res.status === 200 && Array.isArray(res.body?.ships) ? res.body.ships : [];
  const opened = [];
  for (const s of ships) {
    if (!TICKET.test(s?.ticket ?? "") || typeof s.prompt !== "string" || s.prompt.length > MAX_PROMPT || !REPO.test(s.repo ?? "")) continue;
    const folder = folderFor(s.repo);
    const url = threadUrl(s.prompt, folder);
    try {
      open(url);
      opened.push({ ticket: s.ticket, url });
      // Never the prompt: the ticket, and whether a folder was found.
      log(s.ticket + "\topened" + (folder ? "" : "\tno folder for " + s.repo));
    } catch {
      log(s.ticket + "\tcould not open");
    }
  }
  return opened;
}

// --- The launchd job that polls (macOS). Other systems: run pipexp ship-poll from any scheduler.

const agentsDir = () => join(homedir(), "Library", "LaunchAgents");
export const plistPath = () => join(agentsDir(), LABEL + ".plist");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** The job: the pipexp shim (which runs the newest installed version) with ship-poll, every EVERY_S seconds. */
export const plist = (shim, logFile) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(shim)}</string><string>ship-poll</string></array>
  <key>StartInterval</key><integer>${EVERY_S}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>${esc(logFile)}</string>
</dict>
</plist>
`;

const launchctl = (...args) => spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout: 5000 });
const domain = () => "gui/" + process.getuid();

/** Turns Ship on or off here. On: needs the shim, writes and loads the job. Answers { ok, why? }. */
export function allowShip(on) {
  if (!on) {
    setShip(false);
    if (platform() === "darwin" && !underTest()) {
      launchctl("bootout", domain() + "/" + LABEL);
      try {
        unlinkSync(plistPath());
      } catch {}
    }
    return { ok: true };
  }
  const shim = join(home(), "bin", "pipexp");
  if (!existsSync(shim)) return { ok: false, why: "Start one Codex or Claude Code session with the PipeXP plugin first, so " + shim + " exists" };
  setShip(true);
  if (platform() !== "darwin") return { ok: true, why: "Run pipexp ship-poll every " + EVERY_S + " seconds from your scheduler (the automatic job is macOS only)" };
  if (underTest()) return { ok: true };
  mkdirSync(agentsDir(), { recursive: true });
  writeFileSync(plistPath(), plist(shim, join(stateDir(), "ship-poll.err")), { mode: 0o644 });
  launchctl("bootout", domain() + "/" + LABEL);
  const r = launchctl("bootstrap", domain(), plistPath());
  return r.status === 0 ? { ok: true } : { ok: false, why: "launchctl could not start the job: " + (r.stderr || "").trim().slice(0, 200) };
}

