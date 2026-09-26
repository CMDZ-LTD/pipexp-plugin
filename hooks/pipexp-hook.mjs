#!/usr/bin/env node
// The one command every hook runs. Reads the hook's JSON on stdin, queues events, starts a detached send,
// and exits in milliseconds. Never blocks the agent, never fails a hook: any error exits 0 silently.
// Keeping this command fixed means a plugin update does not ask the person to trust the hooks again.
import { adapt, noticeOutput } from "../core/adapt.mjs";
import { hook, runtimeOf } from "../core/run.mjs";
import { notice } from "../core/connect.mjs";

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
    }
  } catch {
    // Telemetry never gets in the agent's way.
  }
  // Stop expects JSON when anything is printed; only SessionStart ever prints, and only a short notice.
  if (out) process.stdout.write(out);
  process.exit(0);
});
