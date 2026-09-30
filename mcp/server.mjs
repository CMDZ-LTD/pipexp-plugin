#!/usr/bin/env node
// PipeXP's MCP server (stdio, newline-delimited JSON-RPC, no dependencies). Only the protocol lives here, so the agent
// never has to restart it for an update: every call runs mcp/tools.mjs from the newest release on this machine
// (core/live.mjs), and a switch to a newer release tells the agent the tool list changed.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { VERSION } from "../core/config.mjs";
import { liveRoot } from "../core/live.mjs";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

let loaded = null;
/** The tools module to use now: the newest release's, or this copy's when there is none or it does not load. */
async function tools() {
  let root = null;
  let mod = null;
  try {
    root = liveRoot();
    if (root && loaded?.root === root) return loaded.mod;
    if (root) mod = await import(pathToFileURL(join(root, "mcp", "tools.mjs")).href);
  } catch {}
  if (!mod) {
    root = null;
    mod = await import("./tools.mjs");
  }
  if (loaded && loaded.root !== root) send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  loaded = { root, mod };
  return mod;
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // A notification.
  if (method === "initialize")
    return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "pipexp", version: VERSION } } });
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: (await tools()).TOOLS } });
  if (method === "tools/call") return send({ jsonrpc: "2.0", id, result: await (await tools()).reply(params?.name, params?.arguments ?? {}) });
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href) createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  handle(msg);
});
