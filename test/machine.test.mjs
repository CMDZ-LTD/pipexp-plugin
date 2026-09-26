// A machine's name and the pipexp shim (CMD-370): the name a person set is kept, and an upgrade never breaks the shim.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { freshHome } from "./helpers.mjs";

const home = freshHome();
const { defaultName, machine } = await import("../core/config.mjs");
const { shimBody } = await import("../core/connect.mjs");

test("a new machine is named after the Mac's Computer Name, with the hostname when they differ", () => {
  assert.equal(defaultName("Derek\u2019s MacBook Pro", "Dereks-MacBook-Pro"), "Derek's MacBook Pro");
  assert.equal(defaultName("Studio", "ci-runner-2"), "Studio (ci-runner-2)");
  assert.equal(defaultName(null, "omarchy"), "omarchy", "Linux: the hostname");
});

test("the name in machine.json is kept, and PIPEXP_MACHINE_NAME names it outright", () => {
  writeFileSync(join(home, "machine.json"), JSON.stringify({ id: "2abf2913-35e2-42f7-8086-e110f4e9e110", name: "M4 (CI)" }));
  assert.equal(machine().name, "M4 (CI)");
  process.env.PIPEXP_MACHINE_NAME = "Runner";
  assert.deepEqual(machine(), { id: "2abf2913-35e2-42f7-8086-e110f4e9e110", name: "Runner" });
  delete process.env.PIPEXP_MACHINE_NAME;
});

test("after an upgrade deletes the old version folder, the shim runs the new one", () => {
  const cache = mkdtempSync(join(tmpdir(), "pipexp-cache-"));
  const plugin = new URL("..", import.meta.url).pathname;
  const install = (v) => {
    mkdirSync(join(cache, v), { recursive: true });
    cpSync(join(plugin, "bin"), join(cache, v, "bin"), { recursive: true });
    cpSync(join(plugin, "core"), join(cache, v, "core"), { recursive: true });
    const cfg = join(cache, v, "core", "config.mjs");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/export const VERSION = "[^"]+";/, 'export const VERSION = "' + v + '";'));
  };
  install("0.1.9");
  const shim = join(home, "bin", "pipexp");
  mkdirSync(join(home, "bin"), { recursive: true });
  // Written by 0.1.9, as installShim does.
  writeFileSync(shim, shimBody(join(cache, "0.1.9", "bin", "pipexp.mjs"), process.execPath), { mode: 0o700 });
  const run = () => execFileSync(shim, ["status"], { encoding: "utf8", env: { ...process.env, PIPEXP_HOME: home } });
  assert.match(run(), /pipexp 0\.1\.9/);
  // The upgrade: 0.1.10 is installed and 0.1.9 goes (moved out, as the plugin cache does).
  install("0.1.10");
  renameSync(join(cache, "0.1.9"), join(tmpdir(), "pipexp-gone-" + process.pid));
  assert.match(run(), /pipexp 0\.1\.10/, "the newest version runs, sorted as versions (0.1.10 after 0.1.9)");
});
