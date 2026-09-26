// Installs PipeXP into agents that have no plugin folder of their own: Cursor (~/.cursor/hooks.json) and OpenCode
// (~/.config/opencode/plugins). Codex, Claude Code and Gemini CLI install the plugin themselves (README).
// Each install merges: other tools' hooks stay, and running it again changes nothing.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const LAUNCHER = join(ROOT, "hooks", "pipexp-hook.mjs");
const CURSOR_EVENTS = ["sessionStart", "beforeSubmitPrompt", "postToolUse", "postToolUseFailure", "stop", "sessionEnd"];
const MARK = "pipexp-hook.mjs";

const quote = (s) => (/^[\w./-]+$/.test(s) ? s : JSON.stringify(s));
export const cursorCommand = (launcher = LAUNCHER) => "node " + quote(launcher) + " --runtime cursor";

/** ~/.cursor/hooks.json with PipeXP on each event PipeXP reads, replacing only an older PipeXP entry. */
export function installCursor(home = homedir(), launcher = LAUNCHER) {
  const path = join(home, ".cursor", "hooks.json");
  let config = { version: 1, hooks: {} };
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return { ok: false, path, reason: "~/.cursor/hooks.json is not valid JSON; fix it first" };
    }
  }
  config.version ??= 1;
  config.hooks ??= {};
  for (const event of CURSOR_EVENTS) {
    const list = (config.hooks[event] ?? []).filter((h) => !String(h?.command ?? "").includes(MARK));
    list.push({ command: cursorCommand(launcher), timeout: event === "sessionEnd" ? 2 : 5 });
    config.hooks[event] = list;
  }
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, path + ".before-pipexp");
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  renameSync(tmp, path);
  return { ok: true, path };
}

/** Takes PipeXP's entries back out of ~/.cursor/hooks.json, leaving every other hook. */
export function uninstallCursor(home = homedir()) {
  const path = join(home, ".cursor", "hooks.json");
  if (!existsSync(path)) return { ok: true, path };
  const config = JSON.parse(readFileSync(path, "utf8"));
  for (const [event, list] of Object.entries(config.hooks ?? {})) {
    const kept = list.filter((h) => !String(h?.command ?? "").includes(MARK));
    if (kept.length) config.hooks[event] = kept;
    else delete config.hooks[event];
  }
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  return { ok: true, path };
}

/** A one-line OpenCode plugin in ~/.config/opencode/plugins that loads this checkout's opencode/pipexp.mjs. */
export function installOpencode(home = homedir(), xdg = process.env.XDG_CONFIG_HOME) {
  const dir = join(xdg || join(home, ".config"), "opencode", "plugins");
  const path = join(dir, "pipexp.js");
  mkdirSync(dir, { recursive: true });
  const target = join(ROOT, "opencode", "pipexp.mjs");
  writeFileSync(path, "// Written by pipexp install opencode.\nexport { PipeXP, PipeXP as default } from " + JSON.stringify(target) + ";\n");
  return { ok: true, path };
}
