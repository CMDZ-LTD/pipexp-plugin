#!/usr/bin/env node
// The one command every hook runs (hooks/hooks.json). Keeping this command fixed means a plugin update does not ask the
// person to trust the hooks again. It runs hooks/hook.mjs from the newest release on this machine (core/live.mjs), so a
// release reaches sessions already running; its own copy when there is none, or the newer one does not load.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { liveRoot } from "../core/live.mjs";

let ran = false;
try {
  const root = liveRoot();
  if (root) {
    await import(pathToFileURL(join(root, "hooks", "hook.mjs")).href);
    ran = true;
  }
} catch {}
if (!ran) await import("./hook.mjs");
