// Turns harness hooks into board events. Pure: onHook(state, input, ctx) returns the new state and the events.
// Everything it reads from the machine comes in through ctx.probe, so tests drive it with plain objects.
import { createHash, randomUUID } from "node:crypto";
import { VERSION } from "./config.mjs";

// The board's "agent" lane (GET /plugin/config). Explicit reports may name any lane's stage instead.
export const STAGES = { explore: "agent:S1", build: "agent:S2", test: "agent:S3", pr: "agent:S4", waiting: "agent:S5" };
const BEAT_MS = 30 * 60_000;
// A tool call may move the card at most once a minute, so a fix-test loop does not flood the board.
const DWELL_MS = 60_000;
const FAILS_FOR_SNAG = 3;

// Edit tools by agent: Codex apply_patch; Claude Code and Cursor Edit, Write, MultiEdit, StrReplace; Gemini CLI
// write_file, replace; OpenCode edit, write, patch.
const EDIT_TOOLS = /^(apply_patch|Edit|Write|MultiEdit|NotebookEdit|StrReplace|write_file|replace|edit|write|patch)$/;
const PR_CMD = /\bgh\s+pr\s+(create|ready)\b|\bgit\s+push\b/;
const TEST_CMD =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|typecheck|lint|build|check|e2e)\b|\b(npx\s+)?(vitest|jest|pytest|playwright|mocha|tsc|eslint|rspec|phpunit)\b|\bcargo\s+(test|check|clippy|build)\b|\bgo\s+(test|vet|build)\b|\b(gradle|mvn|dotnet)\s+test\b|\bnode\s+--test\b|\bmake\s+(test|check)\b/;
const NOT_TICKETS = new Set(["UTF", "SHA", "ISO", "MD", "PR", "ISSUE", "FEAT", "FIX", "CHORE", "RELEASE", "HOTFIX", "BUGFIX", "SPRINT", "WEEK", "DAY", "PHASE", "STEP", "PART"]);

/** Python's uuid5(NAMESPACE_URL, name), so ids match the Nudj ship scripts'. */
export function uuid5(name) {
  const ns = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const h = createHash("sha1").update(Buffer.concat([ns, Buffer.from(name, "utf8")])).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return x.slice(0, 8) + "-" + x.slice(8, 12) + "-" + x.slice(12, 16) + "-" + x.slice(16, 20) + "-" + x.slice(20);
}

/** A tracker id at the start of a branch segment: "codex/nj-3236-x" is NJ-3236; "utf-8-fix" is none. */
export function ticketOf(branch) {
  const m = typeof branch === "string" && branch.match(/(?:^|\/)([a-z][a-z0-9]{1,9})-(\d{1,6})(?=$|[-_/.])/i);
  if (!m || NOT_TICKETS.has(m[1].toUpperCase())) return null;
  return m[1].toUpperCase() + "-" + m[2];
}

export const commandOf = (input) =>
  typeof input?.command === "string" ? input.command : Array.isArray(input?.command) ? input.command.join(" ") : typeof input?.cmd === "string" ? input.cmd : "";

/** The stage a tool call shows the agent is in, or null when it says nothing (reads, searches). */
export function stageForTool(name, input) {
  if (EDIT_TOOLS.test(name ?? "")) return STAGES.build;
  const cmd = commandOf(input);
  if (PR_CMD.test(cmd)) return STAGES.pr;
  if (TEST_CMD.test(cmd)) return STAGES.test;
  return null;
}

const text = (v) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
const prFrom = (response) => Number(text(response).match(/github\.com\/[^/\s"]+\/[^/\s"]+\/pull\/(\d+)/)?.[1]) || null;
// Best effort: each agent reports exit codes its own way (Codex/Claude "exit_code", Cursor "exitCode", Gemini
// "Exit Code: N" text, OpenCode "exit"). Unknown counts as a pass.
const failed = (response) => {
  const t = text(response);
  const code = t.match(/"(?:exit_code|exitCode|exit)"\s*:\s*(-?\d+)|exit(?:ed with)? code:?\s*(-?\d+)/i);
  return code ? Number(code[1] ?? code[2]) !== 0 : false;
};

export function newState(input, ctx) {
  const runId = uuid5("pipexp/session/" + input.session_id);
  return {
    sessionId: input.session_id,
    runId,
    // The run per lane. A guessed agent run moves into the first skill lane it reports; a second skill
    // lane (ship, then shepherd) is its own run, linked to the first by parentRunId.
    runs: { agent: runId },
    runtime: ctx.runtime,
    cwd: input.cwd ?? null,
    transcriptPath: input.transcript_path ?? null,
    skill: "agent",
    ticket: null,
    title: null,
    branch: null,
    stage: null,
    stageAt: 0,
    lastSentAt: 0,
    // Usage counts from here: the transcript's own start when known, so a card costs the whole session.
    startedAt: new Date(Math.min(ctx.now, ctx.probe.sessionStart?.(input.transcript_path) ?? ctx.now)).toISOString(),
    started: false,
    finished: false,
    explicit: false,
    shipOwned: false,
    prNumber: null,
    fields: {},
    fails: 0,
    lastSeenAt: ctx.now,
  };
}

/** A fresh id per event. The outbox keeps it, so every resend of a queued event carries the same id. */
function event(s, type, fields, at) {
  const out = { eventId: randomUUID(), runId: s.runId, occurredAt: new Date(at).toISOString(), skill: s.skill, runtime: s.runtime, type };
  if (s.ticket) out.ticket = s.ticket;
  if (s.attemptId) out.attemptId = s.attemptId;
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  return out;
}

/** A usage.reported the sender fills in from the transcript, so a hook never reads big files. */
const usageMarker = (s, stage, at) => ({
  ...event(s, "usage.reported", { stage: stage ?? undefined }, at),
  _usage: { runtime: s.runtime, session: s.sessionId, transcriptPath: s.transcriptPath, since: s.startedAt, ...(s.reported && { reported: s.reported }) },
});

function startFields(s, ctx, claim) {
  return {
    title: s.title,
    owner: null,
    profile: null,
    branch: s.branch,
    claim,
    machineId: ctx.machineId,
    pluginVersion: "pipexp " + VERSION,
    runtimeVersion: s.runtimeVersion,
    ...s.fields,
  };
}

/** Reads the branch, ticket and title again; true when the title or branch changed. */
function refresh(s, ctx) {
  const before = s.title + "|" + s.branch;
  const git = ctx.probe.git(s.cwd) ?? {};
  if (git.branch && git.branch !== "HEAD") s.branch = git.branch;
  s.ticket = s.ticket ?? ticketOf(s.branch);
  const repo = git.repo ?? (s.cwd ? s.cwd.split("/").filter(Boolean).pop() : null);
  const minimal = ctx.content === "minimal";
  const named = minimal ? null : ctx.probe.threadName(s.sessionId, s.transcriptPath);
  s.title = s.fields.title ?? (named || (minimal ? repo : [repo, s.branch].filter(Boolean).join(" · ")) || "Agent session");
  if (minimal) s.branch = null;
  return before !== s.title + "|" + s.branch;
}

function enter(s, stage, at, out, extra = {}, force = false) {
  if (!force && s.stage === stage && !Object.keys(extra).length) return;
  // Usage for the stage being left, so the board splits a run's tokens by stage (the sender reads the transcript).
  if (s.stage && s.stage !== stage && s.stage.startsWith(s.skill + ":")) out.push(usageMarker(s, s.stage, at));
  s.stage = stage;
  s.stageAt = at;
  s.lastSentAt = at;
  out.push(event(s, "step.entered", { stage, ...extra }, at));
}

function start(s, ctx, claim, out) {
  refresh(s, ctx);
  out.push(event(s, "run.started", startFields(s, ctx, claim), ctx.now));
  s.lastSentAt = ctx.now;
  // A resumed run was finished on the board: re-entering its stage makes it active again.
  if (s.finished && s.stage) enter(s, s.stage, ctx.now, out, {}, true);
  s.started = true;
  s.finished = false;
}

const revive = (s, ctx, out) => {
  if (!s.started) start(s, ctx, "new", out);
  else if (s.finished) start(s, ctx, "resume", out);
};

/**
 * One hook. ctx: { now, runtime, machineId, runtimeVersion?, content, probe: { git, threadName, shipClaim } }.
 * Returns { state, events }. Unknown hooks change nothing.
 */
export function onHook(state, input, ctx) {
  const at = ctx.now;
  const name = input?.hook_event_name;
  if (!input?.session_id) return { state, events: [] };
  const s = state ? structuredClone(state) : newState(input, ctx);
  s.lastSeenAt = at;
  if (input.transcript_path) s.transcriptPath = input.transcript_path;
  if (input.cwd) s.cwd = input.cwd;
  // An agent with no transcript (OpenCode) sends its own running token total with its hooks.
  if (input.pipexp_usage && typeof input.pipexp_usage === "object") s.reported = { ...input.pipexp_usage, startedAt: s.startedAt };
  // Claude Code writes its version into the transcript after the first prompt, so SessionStart may not see it yet.
  // Once it appears, the run's start is sent again (same run, "resume") so the card shows it.
  const version = s.runtimeVersion ?? ctx.runtimeVersion ?? ctx.probe.runtimeVersion?.(s.runtime, s.transcriptPath);
  const learnedVersion = s.started && !s.runtimeVersion && version;
  s.runtimeVersion = version;
  const out = [];

  // Until the Nudj ship skill reports through the plugin, a session holding a ship claim is reported by ship itself.
  // Checked at turn edges and when a tool call runs ship's claim script, so other tool calls never pay for it.
  const edge = name === "SessionStart" || name === "UserPromptSubmit" || name === "Stop" || (name === "PostToolUse" && /claim-run\.sh/.test(commandOf(input.tool_input)));
  if (edge && !s.shipOwned && !s.explicit && ctx.probe.shipClaim(s.cwd, s.sessionId)) {
    s.shipOwned = true;
    if (s.started && !s.finished) out.push(event(s, "run.finished", { outcome: "abandoned", prNumber: null }, at));
    s.finished = true;
    return { state: s, events: out };
  }
  if (s.shipOwned) return { state: s, events: [] };

  if (name === "SessionStart") {
    if (input.source === "compact" && s.started && !s.finished) return { state: s, events: [] };
    start(s, ctx, s.started ? "resume" : "new", out);
    if (!s.stage) enter(s, STAGES.explore, at, out);
  } else if (name === "UserPromptSubmit") {
    revive(s, ctx, out);
    if (!s.explicit) enter(s, STAGES.explore, at, out);
  } else if (name === "PostToolUse" || name === "PostToolUseFailure") {
    revive(s, ctx, out);
    const cmd = commandOf(input.tool_input);
    // Claude Code sends a failed tool call as its own event (PostToolUseFailure, with "error"), Codex inside the response.
    const didFail = name === "PostToolUseFailure" || failed(input.tool_response);
    const pushed = PR_CMD.test(cmd) && !didFail;
    const pr = pushed ? prFrom(input.tool_response) : null;
    if (pr) s.prNumber = pr;
    // A push or PR that failed (no remote, no auth) leaves the card where it was.
    const guess = s.explicit ? null : stageForTool(input.tool_name, input.tool_input);
    const stage = guess === STAGES.pr && !pushed ? null : guess;
    if (stage && stage !== s.stage && (stage === STAGES.pr || at - s.stageAt >= DWELL_MS || s.stage === STAGES.explore)) enter(s, stage, at, out);
    else if (s.stage && at - s.lastSentAt >= BEAT_MS) {
      // A heartbeat, so a long test run or CI wait never shows Stalled.
      s.lastSentAt = at;
      out.push(event(s, "step.entered", { stage: s.stage }, at));
    }
    if (TEST_CMD.test(cmd)) {
      s.fails = didFail ? s.fails + 1 : 0;
      if (s.fails === FAILS_FOR_SNAG)
        out.push(event(s, "snag.reported", { stage: s.stage ?? undefined, kind: "snag", theme: "checks failing", what: "The same checks failed " + FAILS_FOR_SNAG + " times in a row: " + cmd.slice(0, 200), costMin: null }, at));
    }
  } else if (name === "Stop") {
    revive(s, ctx, out);
    if (refresh(s, ctx) || learnedVersion) out.push(event(s, "run.started", startFields(s, ctx, "resume"), at));
    if (!s.explicit) enter(s, STAGES.waiting, at, out);
    else out.push(usageMarker(s, s.stage, at));
  } else if (name === "SessionEnd") {
    if (!s.started || s.finished) return { state: s, events: [] };
    // Waiting spends no tokens: Stop already reported the turn's usage.
    if (s.stage !== STAGES.waiting) out.push(usageMarker(s, s.stage, at));
    // A session that ends after its turn finished was handed back to its person: ready. One cut off mid-turn
    // (closed, killed) is abandoned. A skill run that never reported its own finish did not complete.
    const handedBack = s.prNumber || (!s.explicit && s.stage === STAGES.waiting);
    out.push(event(s, "run.finished", { outcome: handedBack ? "ready" : "abandoned", prNumber: s.prNumber }, at));
    s.finished = true;
  } else {
    return { state: s, events: [] };
  }
  return { state: s, events: out };
}

/**
 * An explicit report from the agent (MCP tool or CLI). type is an event type, or "stage".
 * A stage in another lane (ship:S4) moves the run to that lane; from then on tool calls no longer guess stages.
 * fields: that event type's own fields (the board's schema); run.started fields are kept and resent on changes.
 */
export function onReport(state, report, ctx) {
  const s = structuredClone(state);
  const out = [];
  const at = ctx.now;
  s.lastSeenAt = at;
  // While a repo's own ship scripts still send telemetry, a session they claimed is theirs: reporting it here
  // too would put a second card on the board. The guard turns itself off once those scripts are gone.
  if (ctx.probe.shipClaim(s.cwd, s.sessionId)) {
    s.shipOwned = true;
    return { state: s, events: [] };
  }
  const fields = { ...(report.fields ?? {}) };
  if (report.ticket) s.ticket = report.ticket;
  if (report.type === "stage") {
    const skill = report.stage.split(":")[0];
    const moved = skill !== s.skill;
    // A claim (new, resume or takeover) is a new attempt: only the latest attempt moves the card on the board.
    if (report.claim) s.attemptId = randomUUID();
    if (moved) {
      // Tokens spent so far belong to the stage being left, on the run being left.
      if (s.started && !s.finished && s.stage) out.push(usageMarker(s, s.stage, at));
      s.runs ??= { [s.skill]: s.runId };
      const fromSkillLane = s.skill !== "agent";
      if (fromSkillLane || s.runs[skill]) {
        // Another skill lane: its own run, started now, and a child of the lane it came from.
        const parent = s.runs.ship ?? s.runId;
        s.runId = s.runs[skill] ?? uuid5("pipexp/session/" + s.sessionId + "/" + skill);
        if (!s.runs[skill]) {
          s.started = false;
          s.startedAt = new Date(at).toISOString();
          s.stage = null;
          s.fields = parent !== s.runId ? { parentRunId: parent } : {};
        }
      }
      s.runs[skill] = s.runId;
      s.skill = skill;
      if (skill !== "agent") s.fields = { ...(ctx.probe.skillInfo?.(s.cwd, skill) ?? {}), ...s.fields };
    }
    s.explicit = true;
    if (moved || report.claim || !s.started || s.finished) start(s, ctx, report.claim ?? (moved || !s.started ? "new" : "resume"), out);
    enter(s, report.stage, at, out, fields);
  } else if (report.type === "run.started") {
    Object.assign(s.fields, fields);
    start(s, ctx, fields.claim ?? (s.started ? "resume" : "new"), out);
  } else {
    // Finishing a run this machine never started (a takeover from another task or machine): its run id comes from
    // its session id, so just close it; resending its start would overwrite the card with this session's details.
    if (report.type === "run.finished" && !s.started) {
      if (report.lane) s.skill = report.lane;
      out.push(event(s, "run.finished", { prNumber: null, ...fields }, at));
      s.started = true;
      s.finished = true;
      return { state: s, events: out };
    }
    revive(s, ctx, out);
    if (report.type === "usage.reported") out.push(usageMarker(s, fields.stage ?? s.stage, at));
    else {
      if (report.type === "run.finished") {
        if (fields.prNumber === undefined) fields.prNumber = s.prNumber;
        out.push(usageMarker(s, s.stage, at));
        s.finished = true;
      }
      out.push(event(s, report.type, { ...(report.type === "snag.reported" && { stage: s.stage ?? undefined }), ...fields }, at));
    }
  }
  return { state: s, events: out };
}
