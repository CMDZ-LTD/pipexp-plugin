#!/usr/bin/env node
// The one command every hook runs. Reads the hook's JSON on stdin, queues events, starts a detached send,
// and exits in milliseconds. Never blocks the agent, never fails a hook: any error exits 0 silently.
// Keeping this command fixed means a plugin update does not ask the person to trust the hooks again.
import { adapt, noticeOutput } from "../core/adapt.mjs";
import { hook, loadSession, report, runtimeOf } from "../core/run.mjs";
import { notice } from "../core/connect.mjs";
import { hasStop, steerOutput, takeSteers } from "../core/steer.mjs";

let raw = "";
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
      if (input.hook_event_name === "SessionStart") out = noticeOutput(runtime, notice(runtime));
      // A note or stop someone sent from the board (CMD-80), fetched earlier by the flush: shown once, here.
      else if (["UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "Stop"].includes(input.hook_event_name)) {
        const steers = takeSteers(input.session_id);
        out = steerOutput(runtime, input.hook_event_name, steers);
        // Stopped: the card leaves its working stage for Waiting for you; who stopped it and why is on its timeline.
        // Only an agent-lane card: a skill run (ship and the rest) keeps its lane and stage; its timeline has the stop.
        if (out && hasStop(steers) && loadSession(input.session_id)?.skill === "agent") report(input.session_id, { type: "stage", stage: "agent:S5" }, runtime, input.cwd);
      }
    }
  } catch {
    // Telemetry never gets in the agent's way.
  }
  // Stop expects JSON when anything is printed; only SessionStart (a short notice) and steered events print.
  if (out) process.stdout.write(out);
  process.exit(0);
});
