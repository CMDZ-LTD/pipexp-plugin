#!/usr/bin/env node
// pipexp: connect this machine, check status, and report from skills and scripts.
//   pipexp connect [--key-stdin]        connect this machine (device sign-in; --key-stdin reads a /setup key)
//   pipexp status                        connection, queue and this session's run
//   pipexp stages [--raw]                this repo's lanes and stage ids on the board (--raw: JSON)
//   pipexp disconnect                    forget this machine's key
//   pipexp stage <lane:stage> [--ticket ABC-12] [--counters '{"reviewRound":2}'] [--replay]
//   pipexp activity <working|idle|waiting|blocked|paused> [--note "why"] [--ticket ABC-12]   this session's status
//   pipexp event <type> --json '{...}'   any board event type (snag.reported, run.finished, gate.checked, review.done, run.started)
//   pipexp ask "<question>" [--context ...] [--option A --option B] [--recipient <github login>] [--timeout-min 60]
//   pipexp content standard|minimal      how much the board sees (minimal: no titles or branches)
//   pipexp allow restart | deny restart  let the board restart this machine's runs on another model (off by default)
//   pipexp preview [--all] [--raw]       what this session sends next, after scrubbing and the content level (--all: every session)
//   pipexp flush                         send what is queued now
//   pipexp install cursor|opencode       add PipeXP to Cursor or OpenCode (Codex, Claude Code, Gemini CLI install the plugin)
//   pipexp uninstall cursor              take PipeXP out of Cursor's hooks
// Every report command takes --session <id> (default: this Codex or Claude session) and never fails a script:
// it exits 0 unless the arguments are wrong (2). ask exits 3 when it cannot get an answer.
import { parseArgs } from "node:util";
import { credentials, home, machine, readJson, VERSION, writeJson } from "../core/config.mjs";
import { connect, disconnect, saveKey } from "../core/connect.mjs";
import { FIX, hooksTrusted, latestAge, latestKnown, problem, queueAudit } from "../core/health.mjs";
import { installCursor, installOpencode, uninstallCursor } from "../core/install.mjs";
import { ask } from "../core/ask.mjs";
import { droppedCount, pending, queued, waiting } from "../core/queue.mjs";
import { restartAllowed, setRestart } from "../core/restart.mjs";
import { contentFor, currentSession, explicitReport, loadSession, report, runtimeOf } from "../core/run.mjs";
import { join } from "node:path";
import { run as flushNow } from "./flush.mjs";
import { describe, stagesFor } from "../core/stages.mjs";

const STAGE = /^[a-z0-9-]{1,40}:S\d{1,2}$/;
const TICKET = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/;
const EVENTS = ["run.started", "snag.reported", "usage.reported", "run.finished", "gate.checked", "review.done", "pr.status"];

const out = (line) => line && process.stdout.write(line + "\n");
/** "3 min", "5 h", "2 days". */
const age = (ms) => (ms < 3_600_000 ? Math.max(1, Math.round(ms / 60_000)) + " min" : ms < 172_800_000 ? Math.round(ms / 3_600_000) + " h" : Math.round(ms / 86_400_000) + " days");
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
    recipient: { type: "string" },
    "question-id": { type: "string" },
    "key-stdin": { type: "boolean" },
    raw: { type: "boolean" },
    verbose: { type: "boolean" },
    all: { type: "boolean" },
    background: { type: "boolean" },
    runtime: { type: "string" },
    claim: { type: "string" },
    lane: { type: "string" },
    note: { type: "string" },
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
const settingsContent = () => readJson(join(home(), "settings.json"))?.content;
const session = () => values.session ?? currentSession() ?? fail("no session found; pass --session <id>");

async function main() {
  if (cmd === "connect") {
    if (values["key-stdin"]) {
      let key = "";
      for await (const chunk of process.stdin) key += chunk;
      const r = saveKey(key);
      if (!r.ok) return fail(r.reason, 1);
      queueAudit(true);
      return out("Connected " + r.machine + ".");
    }
    const r = await connect({ runtime, say: values.background ? () => {} : out, open: true });
    if (r.ok) {
      queueAudit(true);
      await flushNow().catch(() => {});
      if (values.background) return;
      out("Connected " + r.machine + ". Runs now show on " + r.boardUrl);
      if (hooksTrusted() === false) out("One more step: " + FIX.hooks_untrusted);
      return;
    }
    return values.background ? undefined : fail(r.reason, 1);
  }
  if (cmd === "status") {
    const c = credentials();
    const id = values.session ?? currentSession();
    const s = id ? loadSession(id) : null;
    const board = c?.boardUrl ?? "https://pipexp.dev";
    // Line one is the whole answer: what is wrong and the fix, or that all is well.
    const p = problem();
    out(p ? p.line : "Working: " + machine().name + " reports to " + new URL(c.url).host + " (" + c.source + ")");
    const w = waiting();
    out("Queued events: " + w.total + (w.total ? " (oldest " + age(w.oldestMs) + "; pipexp flush --verbose says why)" : "") + " · pipexp " + VERSION + " · newest release " + (latestKnown() ?? "unknown") + " (" + latestAge() + ")");
    out("Restart from the board: " + (restartAllowed() ? "on (pipexp deny restart turns it off)" : "off (pipexp allow restart turns it on)"));
    if (s) out("This session: " + (s.shipOwned ? "reported by the ship skill" : (s.skill + " lane, stage " + (s.stage ?? "none") + (s.ticket ? ", " + s.ticket : "") + ", " + board + "/?run=" + s.runId)));
    return;
  }
  if (cmd === "stages") {
    const r = await stagesFor(process.cwd());
    if (!r.lanes) return fail("no stages: " + r.reason, 1);
    return out(values.raw ? JSON.stringify({ repo: r.repo, lanes: r.lanes }) : describe(r.lanes) + (r.from === "cache" ? "\n(from the last time the board answered)" : ""));
  }
  if (cmd === "allow" || cmd === "deny") {
    if (arg !== "restart") fail(cmd + " takes restart");
    setRestart(cmd === "allow");
    // The board greys Restart out until the machine's audit says it is on, so it goes now.
    queueAudit(true);
    await flushNow().catch(() => {});
    return out(cmd === "allow"
      ? "Restart is on: the owner of this machine's key can restart its runs on another model from the board, in the same folder and mode."
      : "Restart is off on this machine.");
  }
  if (cmd === "preview") {
    // Nothing is sent here: the outbox already holds each event as it will go, scrubbed and cut to the content level.
    const id = values.all ? null : (values.session ?? currentSession());
    const runs = id ? new Set(Object.values(loadSession(id)?.runs ?? {}).concat(loadSession(id)?.runId ?? [])) : null;
    const events = queued().filter((e) => !runs || runs.has(e.runId)).map(({ _usage, _beat, ...e }) => (_usage ? { ...e, agents: "(token counts read from the transcript when sent)" } : e));
    if (values.raw) return out(JSON.stringify(events, null, 2));
    const s = id ? loadSession(id) : null;
    out("Content level: " + contentFor(s?.cwd ?? process.cwd()) + (settingsContent() === "minimal" ? " (this machine)" : ""));
    if (!events.length) return out(id ? "Nothing waiting for this session: everything so far has been sent." : "Nothing waiting to be sent.");
    out(events.length + " event" + (events.length > 1 ? "s" : "") + " waiting" + (id ? " for this session" : "") + ", as they will be sent:");
    for (const e of events) out(JSON.stringify(e));
    return;
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
    out("Sent " + r.sent + ", left " + r.left);
    if (!values.verbose) return;
    // What still waits, by type and age, and why: types, counts and ages only, never an event's values (CMD-95).
    const w = waiting();
    if (w.total) {
      out(r.stopped === "error" ? "Stopped: the board answered with an error. Tried again at most once an hour, for a day." : r.stopped === "retry" ? "Stopped: the board could not be reached, or refused this machine's key. Nothing is lost: events wait up to 7 days." : r.busy ? "Another flush is sending right now." : "");
      for (const t of w.byType) out("  " + t.type + ": " + t.count + ", oldest " + age(t.oldestMs));
    }
    if (droppedCount()) out(droppedCount() + " dropped before the board took them (over 7 days old, or refused again and again); the next machine audit reports it.");
    return;
  }
  if (cmd === "stage") {
    if (!STAGE.test(arg ?? "")) fail("stage looks like ship:S4 or agent:S2");
    if (values.ticket && !TICKET.test(values.ticket)) fail("ticket looks like ABC-123");
    const fields = {};
    if (values.counters) fields.counters = parse(values.counters, "--counters");
    if (values.replay) fields.replay = true;
    if (values.claim && !["new", "resume", "takeover"].includes(values.claim)) fail("claim is new, resume or takeover");
    // The same path as the MCP tool (core/run.mjs explicitReport), from this folder: work in another project's repo
    // moves the session only once the board confirmed it. A refusal is said on stderr; a script still exits 0.
    const r = await explicitReport(session(), { type: "stage", stage: arg, ticket: values.ticket, claim: values.claim, fields }, process.cwd(), runtime);
    if (r.error) process.stderr.write("pipexp: " + r.error + "\n");
    return;
  }
  if (cmd === "activity") {
    if (values.ticket && !TICKET.test(values.ticket)) fail("ticket looks like ABC-123");
    if (values.note !== undefined && values.note.length > 300) fail("note is at most 300 characters");
    const r = await explicitReport(session(), { type: "activity", state: arg, note: values.note, ticket: values.ticket }, process.cwd(), runtime);
    if (r.error) process.stderr.write("pipexp: " + r.error + "\n");
    return;
  }
  if (cmd === "event") {
    if (!EVENTS.includes(arg)) fail("event type is one of " + EVENTS.join(", "));
    if (values.ticket && !TICKET.test(values.ticket)) fail("ticket looks like ABC-123");
    if (values.lane && !/^[a-z0-9-]{1,40}$/.test(values.lane)) fail("lane looks like ship");
    // From this folder, like stage and activity: another project's repo refuses it (it never moves the session).
    const r = await explicitReport(session(), { type: arg, ticket: values.ticket, lane: values.lane, fields: parse(values.json, "--json") }, process.cwd(), runtime);
    if (r.error) process.stderr.write("pipexp: " + r.error + "\n");
    return;
  }
  if (cmd === "ask") {
    // The link goes to stderr at once, so a person nearby can answer before the wait ends; stdout stays the answer.
    const r = await ask({ sessionId: session(), question: arg ?? "", context: values.context, options: values.option, timeoutMin: Number(values["timeout-min"]) || undefined, recipient: values.recipient, questionId: values["question-id"], wait: "all", onAsked: (link) => process.stderr.write("Answer it here: " + link + "\n") });
    if (r.status === "answered") return out(r.answer);
    return fail(r.reason ?? "no answer; ask in the chat instead", 3);
  }
  fail("commands: connect, status, stages, preview, allow restart, deny restart, disconnect, stage, activity, event, ask, content, flush, install, uninstall");
}

main().catch(() => process.exit(0));
