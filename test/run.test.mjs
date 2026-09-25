import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { freshHome } from "./helpers.mjs";

freshHome();
process.env.PIPEXP_RUNTIME = "codex";
const { currentSession, hook, loadSession, report } = await import("../core/run.mjs");

test("an MCP report finds the session by folder, through a symlinked path, and after the turn ended", () => {
  const real = mkdtempSync(join(tmpdir(), "pipexp-cwd-"));
  mkdirSync(join(real, "src"));
  const link = real + "-link";
  symlinkSync(real, link);
  hook({ session_id: "s-old", cwd: real, hook_event_name: "UserPromptSubmit" });
  hook({ session_id: "s-new", cwd: real, hook_event_name: "UserPromptSubmit" });
  hook({ session_id: "s-new", cwd: real, hook_event_name: "SessionEnd", reason: "other" });
  hook({ session_id: "s-elsewhere", cwd: tmpdir(), hook_event_name: "UserPromptSubmit" });
  assert.equal(currentSession(join(link, "src"), {}), "s-new");
  assert.equal(currentSession(real, { CODEX_THREAD_ID: "given" }), "given");
  const { events } = report("s-new", { type: "snag.reported", fields: { kind: "snag", theme: "t", what: "w", costMin: null } });
  assert.deepEqual(events.map((e) => e.type), ["run.started", "step.entered", "snag.reported"], "a finished card comes back before the snag lands");
  assert.equal(loadSession("s-new").finished, false);
});

test("a hook with no session id does nothing", () => {
  assert.deepEqual(hook({ hook_event_name: "Stop" }), []);
});
