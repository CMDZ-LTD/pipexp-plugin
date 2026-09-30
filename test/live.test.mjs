// Live updates (core/live.mjs): a new release reaches sessions already running, with no restart of the agent.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { freshHome } from "./helpers.mjs";

const home = freshHome();
const plugin = new URL("..", import.meta.url).pathname;
const { VERSION, codeDir } = await import("../core/config.mjs");
const { liveRoot, setAutoUpdate, update } = await import("../core/live.mjs");
const { queued } = await import("../core/queue.mjs");
const { loadSession } = await import("../core/run.mjs");
const NEXT = "9.9.9";

/** A copy of this plugin as release v<version>, laid out like GitHub's tag tarball (one top folder). */
function release(version, edit = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "pipexp-release-"));
  const top = join(dir, "pipexp-plugin-" + version);
  for (const part of ["bin", "core", "hooks", "mcp", "package.json"]) cpSync(join(plugin, part), join(top, part), { recursive: true });
  const cfg = join(top, "core", "config.mjs");
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/export const VERSION = "[^"]+";/, 'export const VERSION = "' + version + '";'));
  const pkg = JSON.parse(readFileSync(join(top, "package.json"), "utf8"));
  writeFileSync(join(top, "package.json"), JSON.stringify({ ...pkg, version }));
  edit(top);
  execFileSync("tar", ["-czf", join(dir, "r.tgz"), "-C", dir, "pipexp-plugin-" + version]);
  const body = readFileSync(join(dir, "r.tgz"));
  const asked = [];
  const get = async (url) => (asked.push(url), { ok: true, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) });
  return { get, asked };
}

/** The MCP server as Codex runs it; call(id, name) answers with the tool result, notes holds notifications seen. */
function server() {
  const child = spawn(process.execPath, [join(plugin, "mcp", "server.mjs")], { env: { PATH: process.env.PATH, PIPEXP_HOME: home, PIPEXP_NO_FLUSH: "1", PIPEXP_TEST: "1" } });
  let buf = "";
  const waiting = new Map();
  const notes = [];
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id === undefined) notes.push(msg.method);
      else waiting.get(msg.id)?.(msg.result);
    }
  });
  const call = (id, name, args = {}) =>
    new Promise((done) => {
      waiting.set(id, done);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    });
  return { call, notes, stop: () => child.kill() };
}
const pluginOf = (result) => JSON.parse(result.content[0].text).plugin;

test("a release is downloaded once, only whole and of the very version asked for", async () => {
  const T = Date.now();
  const wrong = release(NEXT, (top) => writeFileSync(join(top, "package.json"), JSON.stringify({ version: "9.9.8" })));
  assert.equal(await update(wrong.get, NEXT, T), null, "a tarball of another version is refused");
  assert.equal(liveRoot(), null);
  assert.equal(await update(release(VERSION).get, VERSION), null, "never the version already running");
  const r = release(NEXT);
  assert.equal(await update(r.get, NEXT, T + 30 * 60_000), null, "a failed download waits an hour, never retried at every flush");
  assert.equal(r.asked.length, 0);
  assert.equal(await update(r.get, NEXT, T + 3_600_001), NEXT);
  assert.deepEqual(r.asked, ["https://codeload.github.com/CMDZ-LTD/pipexp-plugin/tar.gz/refs/tags/v" + NEXT]);
  assert.equal(liveRoot(), join(codeDir(), NEXT));
  assert.equal(await update(r.get, NEXT), null);
  assert.equal(r.asked.length, 1, "not downloaded twice");
});

test("an MCP server already running switches to the new release at its next call, and says the tool list changed", async () => {
  setAutoUpdate(false);
  const s = server();
  try {
    assert.equal(pluginOf(await s.call(1, "pipexp_status")), "pipexp " + VERSION);
    setAutoUpdate(true);
    await update(release(NEXT).get, NEXT);
    assert.equal(pluginOf(await s.call(2, "pipexp_status")), "pipexp " + NEXT);
    assert.deepEqual(s.notes, ["notifications/tools/list_changed"]);
  } finally {
    s.stop();
  }
});

test("a hook runs the new release, and a release that does not load falls back to the installed copy", () => {
  const hook = (id) =>
    spawnSync(process.execPath, [join(plugin, "hooks", "pipexp-hook.mjs"), "--runtime", "codex"], {
      input: JSON.stringify({ session_id: id, cwd: "/repo", hook_event_name: "UserPromptSubmit", prompt: "hi" }),
      env: { ...process.env, PIPEXP_HOME: home, PIPEXP_NO_FLUSH: "1" },
      timeout: 5000,
    });
  hook("live-1");
  const version = (id) => queued().find((e) => e.type === "run.started" && e.runId === loadSession(id)?.runId)?.pluginVersion;
  assert.equal(version("live-1"), "pipexp " + NEXT);
  // A broken download (a syntax error in its hook) never stops the hooks.
  writeFileSync(join(codeDir(), NEXT, "hooks", "hook.mjs"), "this is not javascript(");
  hook("live-2");
  assert.equal(version("live-2"), "pipexp " + VERSION);
});

test("the CLI shim runs the newest of the installed and the downloaded copies", async () => {
  const { shimBody } = await import("../core/connect.mjs");
  await update(release("9.9.10").get, "9.9.10");
  const cache = mkdtempSync(join(tmpdir(), "pipexp-cache-"));
  for (const part of ["bin", "core"]) cpSync(join(plugin, part), join(cache, VERSION, part), { recursive: true });
  const shim = join(home, "shim");
  writeFileSync(shim, shimBody(join(cache, VERSION, "bin", "pipexp.mjs"), process.execPath), { mode: 0o700 });
  const run = () => execFileSync(shim, ["status"], { encoding: "utf8", env: { ...process.env, PIPEXP_HOME: home } });
  assert.match(run(), /pipexp 9\.9\.10/, "9.9.10 sorts after 9.9.9 and the installed copy");
  // install writes a path into Cursor's hooks: the installed copy's, never a download that gets deleted.
  const user = mkdtempSync(join(tmpdir(), "pipexp-user-"));
  execFileSync(shim, ["install", "cursor"], { env: { ...process.env, PIPEXP_HOME: home, HOME: user } });
  assert.match(readFileSync(join(user, ".cursor", "hooks.json"), "utf8"), new RegExp(join(cache, VERSION, "hooks", "pipexp-hook.mjs").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const direct = spawnSync(process.execPath, [join(codeDir(), "9.9.10", "bin", "pipexp.mjs"), "install", "cursor"], { encoding: "utf8", env: { ...process.env, PIPEXP_HOME: home, HOME: user } });
  assert.match(direct.stderr, /not from a live download/);
  execFileSync(shim, ["auto-update", "off"], { env: { ...process.env, PIPEXP_HOME: home } });
  assert.equal(existsSync(codeDir()), false, "off deletes the downloads");
  assert.equal(liveRoot(), null);
  assert.match(run(), new RegExp("pipexp " + VERSION.replace(/\./g, "\\.")));
  assert.equal(await update(release(NEXT).get, NEXT), null, "off: nothing is downloaded");
  mkdirSync(codeDir(), { recursive: true });
});
