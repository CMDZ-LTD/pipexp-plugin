#!/usr/bin/env node
// pipexp: connect this machine, check status, and report from skills and scripts.
//   pipexp connect [--key-stdin]        connect this machine (device sign-in; --key-stdin reads a /setup key)
//   pipexp status                        connection, queue and this session's run
//   pipexp stages [--raw]                this repo's lanes and stage ids on the board (--raw: JSON)
//   pipexp disconnect                    forget this machine's key
//   pipexp stage <lane:stage> [--ticket ABC-12] [--counters '{"reviewRound":2}'] [--replay]
//   pipexp event <type> --json '{...}'   any board event type (snag.reported, run.finished, gate.checked, review.done, run.started)
//   pipexp ask "<question>" [--context ...] [--option A --option B] [--timeout-min 60]
//   pipexp content standard|minimal      how much the board sees (minimal: no titles or branches)
//   pipexp flush                         send what is queued now
//   pipexp install cursor|opencode       add PipeXP to Cursor or OpenCode (Codex, Claude Code, Gemini CLI install the plugin)
//   pipexp uninstall cursor              take PipeXP out of Cursor's hooks
// Every report command takes --session <id> (default: this Codex or Claude session) and never fails a script:
// it exits 0 unless the arguments are wrong (2). ask exits 3 when it cannot get an answer.
import { parseArgs } from "node:util";
import { credentials, home, machine, readJson, writeJson } from "../core/config.mjs";
import { connect, disconnect, saveKey } from "../core/connect.mjs";
import { installCursor, installOpencode, uninstallCursor } from "../core/install.mjs";
import { ask } from "../core/ask.mjs";
import { pending } from "../core/queue.mjs";
import { currentSession, loadSession, report, runtimeOf } from "../core/run.mjs";
import { join } from "node:path";
import { run as flushNow } from "./flush.mjs";
import { describe, stagesFor } from "../core/stages.mjs";

const STAGE = /^[a-z0-9-]{1,40}:S\d{1,2}$/;
const TICKET = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/;
const EVENTS = ["run.started", "snag.reported", "usage.reported", "run.finished", "gate.checked", "review.done", "pr.status"];

const out = (line) => process.stdout.write(line + "\n");
// A reader that stops early (pipexp status | head -1) closes the pipe; that is not an error for a script.
process.stdout.on("error", () => process.exit(0));
const fail = (why, code = 2) => {
  process.stderr.write("pipexp: " + why + "\n");
  process.exit(code);
};

const { positionals, values } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    session: { type: "string" },
    ticket: { type: "string" },
    counters: { type: "string" },
    replay: { type: "boolean" },
    json: { type: "string" },
    context: { type: "string" },
    option: { type: "string", multiple: true },
    "timeout-min": { type: "string" },
    "question-id": { type: "string" },
    "key-stdin": { type: "boolean" },
    raw: { type: "boolean" },
    background: { type: "boolean" },
    runtime: { type: "string" },
    claim: { type: "string" },
    lane: { type: "string" },
  },
});
const [cmd, arg] = positionals;
const runtime = values.runtime ?? runtimeOf();
const parse = (s, what) => {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {}
  // JSON.parse quotes what it rejects, which may hold a secret: never echo it.
  return fail(what + " is not a JSON object");
};
const session = () => values.session ?? currentSession() ?? fail("no session found; pass --session <id>");

async function main() {
  if (cmd === "connect") {
    if (values["key-stdin"]) {
      let key = "";
      for await (const chunk of process.stdin) key += chunk;
      const r = saveKey(key);
      return r.ok ? out("Connected " + r.machine + ".") : fail(r.reason, 1);
    }
    const r = await connect({ runtime, say: values.background ? () => {} : out, open: true });
    if (r.ok) {
      await flushNow().catch(() => {});
      return values.background ? undefined : out("Connected " + r.machine + ". Runs now show on " + r.boardUrl);
    }
    return values.background ? undefined : fail(r.reason, 1);
  }
  if (cmd === "status") {
    const c = credentials();
    const id = values.session ?? currentSession();
    const s = id ? loadSession(id) : null;
    const board = c?.boardUrl ?? "https://pipexp.dev";
    out(c ? "Connected: " + machine().name + " to " + new URL(c.url).host + " (" + c.source + ")" : "Not connected. Run: pipexp connect");
    const disc = readJson(join(home(), "state", "disconnected.json"));
    if (disc?.at) out("The board refused this machine's key at " + disc.at + ". Run: pipexp connect");
    out("Queued events: " + pending());
    if (s) out("This session: " + (s.shipOwned ? "reported by the ship skill" : (s.skill + " lane, stage " + (s.stage ?? "none") + (s.ticket ? ", " + s.ticket : "") + ", " + board + "/?run=" + s.runId)));
    return;
  }
  if (cmd === "stages") {
    const r = await stagesFor(process.cwd());
    if (!r.lanes) return fail("no stages: " + r.reason, 1);
    return out(values.raw ? JSON.stringify({ repo: r.repo, lanes: r.lanes }) : describe(r.lanes) + (r.from === "cache" ? "\n(from the last time the board answered)" : ""));
  }
  if (cmd === "disconnect") return out(disconnect() ? "Disconnected. The key is deleted from this machine; revoke it at https://pipexp.dev/setup." : "Not connected.");
  if (cmd === "content") {
    if (!["standard", "minimal"].includes(arg)) fail("content is standard or minimal");
    writeJson(join(home(), "settings.json"), { ...(readJson(join(home(), "settings.json")) ?? {}), content: arg });
    return out("Content level: " + arg);
  }
  if (cmd === "install" || cmd === "uninstall") {
    const r = cmd === "uninstall" ? (arg === "cursor" ? uninstallCursor() : fail("uninstall takes cursor")) : arg === "cursor" ? installCursor() : arg === "opencode" ? installOpencode() : fail("install takes cursor or opencode");
    return r.ok ? out((cmd === "install" ? "Added PipeXP to " : "Removed PipeXP from ") + r.path) : fail(r.reason, 1);
  }
  if (cmd === "flush") {
    const r = await flushNow();
    return out("Sent " + r.sent + ", left " + r.left);
  }
  if (cmd === "stage") {
    if (!STAGE.test(arg ?? "")) fail("stage looks like ship:S4 or agent:S2");
    if (values.ticket && !TICKET.test(values.ticket)) fail("ticket looks like ABC-123");
    const fields = {};
    if (values.counters) fields.counters = parse(values.counters, "--counters");
    if (values.replay) fields.replay = true;
    if (values.claim && !["new", "resume", "takeover"].includes(values.claim)) fail("claim is new, resume or takeover");
    report(session(), { type: "stage", stage: arg, ticket: values.ticket, claim: values.claim, fields }, runtime);
    return;
  }
  if (cmd === "event") {
    if (!EVENTS.includes(arg)) fail("event type is one of " + EVENTS.join(", "));
    if (values.ticket && !TICKET.test(values.ticket)) fail("ticket looks like ABC-123");
    if (values.lane && !/^[a-z0-9-]{1,40}$/.test(values.lane)) fail("lane looks like ship");
    report(session(), { type: arg, ticket: values.ticket, lane: values.lane, fields: parse(values.json, "--json") }, runtime);
    return;
  }
  if (cmd === "ask") {
    const r = await ask({ sessionId: session(), question: arg ?? "", context: values.context, options: values.option, timeoutMin: Number(values["timeout-min"]) || 60, questionId: values["question-id"], wait: "all" });
    if (r.status === "answered") return out(r.answer);
    return fail(r.reason ?? "no answer; ask in the chat instead", 3);
  }
  fail("commands: connect, status, stages, disconnect, stage, event, ask, content, flush, install, uninstall");
}

main().catch(() => process.exit(0));
