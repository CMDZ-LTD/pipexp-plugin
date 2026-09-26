#!/usr/bin/env node
// PipeXP's MCP server (stdio, newline-delimited JSON-RPC, no dependencies). Thin: every tool calls the same
// core the hooks and the CLI use. The session is found from cwd (the agent's working folder) unless given.
import { createInterface } from "node:readline";
import { credentials, machine, VERSION } from "../core/config.mjs";
import { ask } from "../core/ask.mjs";
import { pending } from "../core/queue.mjs";
import { currentSession, loadSession, report } from "../core/run.mjs";
import { describe, stagesFor } from "../core/stages.mjs";

const STAGE = /^[a-z0-9-]{1,40}:S\d{1,2}$/;
const TICKET = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/;
// Codex gives an MCP call about a minute; a longer wait comes back as "waiting" and the agent calls again.
const ASK_WAIT_S = 45;

const where = {
  cwd: { type: "string", description: "Required: the absolute path of your working folder. It picks this session's card." },
  session_id: { type: "string", description: "The session id, when you know it (CODEX_THREAD_ID). Optional." },
};

const TOOLS = [
  {
    name: "pipexp_report_stage",
    description: "Move this session's card on the PipeXP board to a stage. Use when a skill defines stages (e.g. ship:S4) or to correct a guessed one (agent:S1 Explore, agent:S2 Build, agent:S3 Test, agent:S4 Pull request).",
    inputSchema: {
      type: "object",
      properties: {
        stage: { type: "string", description: "lane:S<n>, e.g. agent:S3 or ship:S5" },
        ticket: { type: "string", description: "The tracker id this work is for, e.g. ABC-123. Optional." },
        ...where,
      },
      required: ["stage"],
    },
  },
  {
    name: "pipexp_report_snag",
    description: "Record something that slowed this session down (a flaky test, a wrong doc, a missing tool), so the team can fix it.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["snag", "wrong-doc", "missing-script", "gate", "evidence", "worked"] },
        theme: { type: "string", description: "A few words, e.g. flaky e2e" },
        what: { type: "string", description: "One or two sentences. No secrets, no customer data." },
        cost_min: { type: "number", description: "Minutes it cost, if known" },
        ...where,
      },
      required: ["kind", "theme", "what"],
    },
  },
  {
    name: "pipexp_finish",
    description: "Mark this session's work finished on the board: ready (a PR is ready for review), merged, blocked (needs a person) or abandoned.",
    inputSchema: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: ["ready", "merged", "blocked", "abandoned"] },
        pr_number: { type: "number" },
        question: { type: "string", description: "For blocked: what a person must decide" },
        ...where,
      },
      required: ["outcome"],
    },
  },
  {
    name: "pipexp_ask_human",
    description: "Ask a person on the PipeXP board and wait for their answer. Use for a decision you cannot make yourself. If it returns status waiting, call again with the question_id to keep waiting. If it fails, ask in the chat instead.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        context: { type: "string", description: "What they need to know to answer" },
        options: { type: "array", items: { type: "string" }, description: "Up to 6 suggested answers" },
        timeout_min: { type: "number", description: "How long the question stays open (default 60)" },
        question_id: { type: "string", description: "To keep waiting on a question already asked" },
        ...where,
      },
    },
  },
  {
    name: "pipexp_stages",
    description: "This repo's lanes and stage ids on the PipeXP board. Call once at session start when you run a skill with stages, and report only stage ids it lists.",
    inputSchema: { type: "object", properties: { ...where } },
  },
  {
    name: "pipexp_status",
    description: "Whether this machine is connected to PipeXP, what is queued, and this session's run on the board.",
    inputSchema: { type: "object", properties: { ...where } },
  },
];

// Every tool only reports to this person's own PipeXP board or reads status: nothing is deleted, and the only
// system touched is that one board (a closed world). Honest annotations let Codex run them without a prompt.
const READS = ["pipexp_status", "pipexp_stages"];
for (const tool of TOOLS) tool.annotations = { readOnlyHint: READS.includes(tool.name), destructiveHint: false, openWorldHint: false, idempotentHint: READS.includes(tool.name) };

// Codex starts this server in the plugin's folder with a bare environment (no thread id, no PWD), so there the
// agent's cwd finds its session. Claude Code gives the server CLAUDE_CODE_SESSION_ID, which wins when no cwd is
// passed (it can be stale after --continue, so a given cwd still decides).
const sessionOf = (args) =>
  args.session_id || (args.cwd ? currentSession(args.cwd, {}) : process.env.CLAUDE_CODE_SESSION_ID || null);
const ok = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
const err = (message) => ({ content: [{ type: "text", text: message }], isError: true });

async function callTool(name, args = {}) {
  if (name === "pipexp_stages") {
    const r = await stagesFor(args.cwd);
    if (!r.lanes) return err("No stages: " + r.reason + ". Report agent:S1 to agent:S4 as usual.");
    return ok({ repo: r.repo, from: r.from, lanes: r.lanes, summary: describe(r.lanes) });
  }
  if (name === "pipexp_status") {
    const c = credentials();
    const id = sessionOf(args);
    const s = id ? loadSession(id) : null;
    return ok({
      connected: !!c,
      machine: machine().name,
      board: c?.boardUrl ?? "https://pipexp.dev",
      queued: pending(),
      plugin: "pipexp " + VERSION,
      session: s ? { lane: s.skill, stage: s.stage, ticket: s.ticket, runId: s.runId, reportedBy: s.shipOwned ? "ship skill" : "pipexp" } : null,
    });
  }
  const id = sessionOf(args);
  if (!id) return err("No PipeXP session found for this folder. Pass cwd (your working folder) or session_id.");
  // A session no hook has seen yet is named after its folder, so it needs the agent's cwd, never this server's.
  if (!loadSession(id) && !args.cwd) return err("Pass cwd (your working folder) so PipeXP can name this session's card.");
  if (args.ticket && !TICKET.test(args.ticket)) return err("ticket looks like ABC-123");
  if (name === "pipexp_report_stage") {
    if (!STAGE.test(args.stage ?? "")) return err("stage looks like agent:S2 or ship:S4");
    const { state, events } = report(id, { type: "stage", stage: args.stage, ticket: args.ticket }, undefined, args.cwd);
    if (!events.length && state.shipOwned) return ok("This session is already reported by the repo's ship scripts; nothing to add.");
    return ok("On the board: " + state.stage + (state.ticket ? " for " + state.ticket : ""));
  }
  if (name === "pipexp_report_snag") {
    report(id, { type: "snag.reported", fields: { kind: args.kind, theme: args.theme, what: args.what, costMin: typeof args.cost_min === "number" ? args.cost_min : null } }, undefined, args.cwd);
    return ok("Snag recorded.");
  }
  if (name === "pipexp_finish") {
    const fields = { outcome: args.outcome };
    if (typeof args.pr_number === "number") fields.prNumber = args.pr_number;
    if (args.question) fields.question = args.question;
    report(id, { type: "run.finished", fields }, undefined, args.cwd);
    return ok("Marked " + args.outcome + ".");
  }
  if (name === "pipexp_ask_human") {
    const r = await ask({ sessionId: id, question: args.question, context: args.context, options: args.options, timeoutMin: args.timeout_min ?? 60, questionId: args.question_id, wait: ASK_WAIT_S });
    if (r.status === "answered") return ok({ status: "answered", answer: r.answer, answered_by: r.answeredBy });
    if (r.status === "waiting") return ok({ status: "waiting", question_id: r.questionId, next: "No answer yet. Call pipexp_ask_human again with this question_id to keep waiting." });
    return err((r.reason ?? "No answer") + ". Ask in the chat instead.");
  }
  return err("Unknown tool " + name);
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // A notification.
  if (method === "initialize")
    return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pipexp", version: VERSION } } });
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    let result;
    try {
      result = await callTool(params?.name, params?.arguments ?? {});
    } catch {
      result = err("PipeXP could not do that just now. Carry on; it never blocks your work.");
    }
    return send({ jsonrpc: "2.0", id, result });
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  handle(msg);
});
