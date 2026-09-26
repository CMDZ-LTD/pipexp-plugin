// Connecting this machine to a PipeXP board. connect() is the only function that knows how: today the
// device flow (docs/plans/connect-machine-ux.md on the board repo). Change it here and nothing else moves.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { credentials, home, machine, osName, readJson, saveCredentials, stateDir, VERSION, writeJson } from "./config.mjs";
import { checkUrl } from "./send.mjs";

// The hosted board. PIPEXP_URL points a machine at another deployment (a dev board, a self-hosted one).
export const DEFAULT_URL = "https://exciting-ox-380.eu-west-1.convex.site";
export const DEFAULT_BOARD = "https://pipexp.dev";
const DAY = 86_400_000;
const CLI = fileURLToPath(new URL("../bin/pipexp.mjs", import.meta.url));

const baseUrl = () => (process.env.PIPEXP_URL || credentials()?.url || DEFAULT_URL).replace(/\/+$/, "");
const noteFile = () => join(stateDir(), "connect.json");
const note = () => readJson(noteFile()) ?? {};
const setNote = (patch) => {
  try {
    writeJson(noteFile(), { ...note(), ...patch });
  } catch {}
};

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export function openUrl(url) {
  if (process.env.SSH_CONNECTION || process.env.PIPEXP_NO_BROWSER) return false;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Connects this machine. say(line) reports progress. Resolves to { ok, reason?, machine? }.
 * The key is saved to ~/.config/pipexp/credentials.json (0600) and never printed.
 */
export async function connect({ runtime = "codex", say = () => {}, open = true } = {}) {
  const url = baseUrl();
  const bad = checkUrl(url);
  if (bad) return { ok: false, reason: bad };
  const me = machine();
  let start;
  try {
    start = await postJson(url + "/device/code", { machineId: me.id, name: me.name.slice(0, 80), os: osName().slice(0, 80), client: runtime, clientVersion: VERSION });
  } catch (e) {
    return { ok: false, reason: "board unreachable (" + (e.cause?.code ?? e.name) + ")" };
  }
  if (start.status === 404) return { ok: false, reason: "this board has no device sign-in; make a key on its /setup page and run: pipexp connect --key-stdin" };
  if (start.status !== 200 || !start.body?.deviceCode) return { ok: false, reason: "the board refused (HTTP " + start.status + ")" };
  const { deviceCode, userCode, verificationUriComplete, expiresIn = 600 } = start.body;
  let interval = Math.max(1, start.body.interval ?? 5);
  const opened = open && openUrl(verificationUriComplete);
  say((opened ? "Opened " : "Open ") + verificationUriComplete + " and check the code " + userCode + ", then click Connect.");
  const deadline = Date.now() + expiresIn * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    let got;
    try {
      got = await postJson(url + "/device/token", { deviceCode });
    } catch {
      continue;
    }
    if (got.status === 200 && got.body?.key) {
      const creds = { url: (got.body.ingestUrl || url).replace(/\/+$/, ""), key: got.body.key, boardUrl: got.body.boardUrl || DEFAULT_BOARD, machine: got.body.machine?.name ?? me.name, connectedAt: new Date().toISOString() };
      saveCredentials(creds);
      clearDisconnected();
      return { ok: true, machine: creds.machine, boardUrl: creds.boardUrl };
    }
    const error = got.body?.error;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval += 5;
      continue;
    }
    return { ok: false, reason: error === "access_denied" ? "denied on the board" : error === "expired_token" ? "the code expired; run connect again" : "the board refused (HTTP " + got.status + ")" };
  }
  return { ok: false, reason: "the code expired; run connect again" };
}

/** A key made on the board's /setup page, read from stdin. For boards without device sign-in, and for CI. */
export function saveKey(key, url = baseUrl()) {
  const clean = String(key).trim();
  if (!/^[\w-]{20,200}$/.test(clean)) return { ok: false, reason: "that does not look like a PipeXP key" };
  saveCredentials({ url, key: clean, boardUrl: DEFAULT_BOARD, machine: machine().name, connectedAt: new Date().toISOString() });
  clearDisconnected();
  return { ok: true, machine: machine().name };
}

export function disconnect() {
  try {
    unlinkSync(join(home(), "credentials.json"));
    return true;
  } catch {
    return false;
  }
}

export const disconnected = () => !!readJson(join(stateDir(), "disconnected.json"))?.at;
const clearDisconnected = () => {
  try {
    writeFileSync(join(stateDir(), "disconnected.json"), "null");
  } catch {}
};

/** A stable path skills can call (the Nudj ship skill does): ~/.config/pipexp/bin/pipexp. Rewritten when the plugin moves. */
export function installShim() {
  const dir = join(home(), "bin");
  const path = join(dir, "pipexp");
  const body = "#!/bin/sh\n# Written by the pipexp plugin. Points at the installed plugin version.\nexec \"" + process.execPath + "\" \"" + CLI + "\" \"$@\"\n";
  try {
    if (existsSync(path) && readFileSync(path, "utf8") === body) return path;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, body, { mode: 0o700 });
    chmodSync(path, 0o700);
  } catch {}
  return path;
}

/**
 * What SessionStart shows the person, if anything. First session with no key: starts connecting in the
 * background (opens the browser once). After that, at most one reminder a day. A refused key says so.
 */
export function notice(runtime) {
  installShim();
  if (process.env.PIPEXP_OFF) return "";
  const creds = credentials();
  const n = note();
  const now = Date.now();
  if (creds && !disconnected()) return "";
  if (now - (n.noticeAt ?? 0) < DAY) return "";
  setNote({ noticeAt: now });
  if (creds) return "PipeXP: this machine's key was refused by the board. Run $pipexp:connect to connect again.";
  if (!n.autoAt && !process.env.SSH_CONNECTION) {
    setNote({ autoAt: now });
    try {
      spawn(process.execPath, [CLI, "connect", "--background", "--runtime", runtime], { detached: true, stdio: "ignore" }).unref();
    } catch {}
    return "PipeXP: approve this machine in the browser tab that just opened, and this session shows on your board. Or run $pipexp:connect.";
  }
  return "PipeXP is not connected, so this session is not on your board. Run $pipexp:connect.";
}

export const gitUser = () => spawnSync("git", ["config", "user.name"], { encoding: "utf8" }).stdout?.trim() || null;
