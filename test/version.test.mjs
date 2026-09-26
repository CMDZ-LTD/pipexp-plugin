import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { VERSION } from "../core/config.mjs";

const json = (path) => JSON.parse(readFileSync(new URL("../" + path, import.meta.url), "utf8"));

test("one version everywhere, with no dev cache-buster: installs from main update when it changes", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  for (const file of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json", "package.json", "gemini-extension.json"]) assert.equal(json(file).version, VERSION, file);
});
