#!/usr/bin/env node
// The one command every hook runs. Reads the hook's JSON on stdin, queues events, starts a detached send,
// and exits in milliseconds. Never blocks the agent, never fails a hook: any error exits 0 silently.
// Keeping this command fixed means a plugin update does not ask the person to trust the hooks again.
import { adapt, noticeOutput } from "../core/adapt.mjs";
import { existsSync, writeFileSync } from "node:fs";
import { hook, loadSession, report, runtimeOf, sessionFile } from "../core/run.mjs";
import { startContext } from "../core/stages.mjs";
import { notice } from "../core/connect.mjs";
import { startNotice } from "../core/health.mjs";
import { hasStop, steerOutput, takeSteers } from "../core/steer.mjs";

let raw = "";
// This repo's own stages for the agent (CMD-421), from the cached board answer. Told at every SessionStart (a compacted
// or resumed session has lost it); a session that started before the cache was filled is told at its first prompt.
function stagesText(input, atStart) {
  if (process.env.PIPEXP_OFF || !input.cwd || loadSession(input.session_id)?.shipOwned) return "";
  const told = sessionFile(input.session_id) + ".told";
  if (!atStart && existsSync(told)) return "";
  const { text } = startContext(input.cwd);
  if (text) writeFileSync(told, "", { mode: 0o600 });
  return text;
}

process.stdout.on("error", () => process.exit(0));
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let out = "";
  try {
    const runtime = runtimeOf();
    const input = adapt(runtime, JSON.parse(raw));
    if (input) {
      hook(input, runtime);
      // Connecting first; else a board that is down or refusing events, once a day each (CMD-88). The stages go as context.
      if (input.hook_event_name === "SessionStart") out = noticeOutput(runtime, notice(runtime) || startNotice(), stagesText(input, true));
      // A note or stop someone sent from the board (CMD-80), fetched earlier by the flush: shown once, here.
      else if (["UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "Stop"].includes(input.hook_event_name)) {
        const steers = takeSteers(input.session_id);
        const stages = input.hook_event_name === "UserPromptSubmit" ? stagesText(input, false) : "";
        out = steerOutput(runtime, input.hook_event_name, stages ? [{ kind: "note", message: stages }, ...steers] : steers);
        // Stopped: the card leaves its working stage for Waiting for you; who stopped it and why is on its timeline.
        // Only an agent-lane card: a skill run (ship and the rest) keeps its lane and stage; its timeline has the stop.
        if (hasStop(steers)) {
          if (loadSession(input.session_id)?.skill === "agent") report(input.session_id, { type: "stage", stage: "agent:S5" }, runtime);
          report(input.session_id, { type: "activity", state: "paused", source: "hook", note: steers.find((s) => s.kind === "stop" || s.kind === "restart")?.message ?? "Stopped from the board" }, runtime);
        }
      }
    }
  } catch {
    // Telemetry never gets in the agent's way.
  }
  // Stop expects JSON when anything is printed; only SessionStart (a short notice) and steered events print.
  if (out) process.stdout.write(out);
  process.exit(0);
});
