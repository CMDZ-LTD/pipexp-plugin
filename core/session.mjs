// Turns harness hooks into board events. Pure: onHook(state, input, ctx) returns the new state and the events.
// Everything it reads from the machine comes in through ctx.probe, so tests drive it with plain objects.
import { createHash, randomUUID } from "node:crypto";
import { VERSION } from "./config.mjs";

// The board's "agent" lane (GET /plugin/config). Explicit reports may name any lane's stage instead.
export const STAGES = { explore: "agent:S1", build: "agent:S2", test: "agent:S3", pr: "agent:S4", waiting: "agent:S5" };
// The board's snag kinds (agent-pipeline lib/event-schema.ts SNAG_KINDS). The board refuses any other kind.
export const SNAG_KINDS = ["snag", "wrong-doc", "missing-script", "gate", "evidence", "worked"];
const words = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * A snag the board always takes, whatever an agent passed (CMD-370: kind "flaky" and a "note" instead of theme and what
 * got a 400, and the snag was lost). A known kind passes; any other goes as "snag", its word kept in theme when theme has
 * room. what falls back to note or description, then theme. Only the board's own fields go on.
 */
export function snagFields(f = {}) {
  const raw = words(f.kind);
  const wanted = raw?.toLowerCase().replace(/[_\s]+/g, "-");
  const kind = SNAG_KINDS.includes(wanted) ? wanted : "snag";
  const given = words(f.theme);
  const unknown = raw && kind === "snag" && wanted !== "snag" ? raw : null;
  let theme = given ?? unknown ?? "snag";
  if (unknown && given && !given.toLowerCase().includes(unknown.toLowerCase()) && (unknown + ": " + given).length <= 60) theme = unknown + ": " + given;
  const what = words(f.what) ?? words(f.note) ?? words(f.description) ?? words(f.message) ?? given ?? unknown ?? "A snag";
  const cost = typeof f.costMin === "number" && Number.isFinite(f.costMin) && f.costMin >= 0 ? Math.min(f.costMin, 10_000) : null;
  return { ...(Number.isInteger(f.step) && { step: f.step }), ...(words(f.stage) && { stage: f.stage }), kind, theme, what, costMin: cost };
}
// A manager's own lane (CMD-374): a session that reports manager:Sx waits there, never in a builder's stage.
export const MANAGER_WAITING = "manager:S4";
// Each lane with a stage that waits on its person, and the stage it goes back to when none was remembered (CMD-518).
// Other lanes (ship and custom workflows) keep their stage at a turn's end: only their activity goes idle.
const WAITING = { agent: STAGES.waiting, manager: MANAGER_WAITING };
const RESUME = { agent: STAGES.explore, manager: "manager:S1" };
// A stage heartbeat, so a long test run or CI wait never shows Stalled on a board without activity.
const BEAT_MS = 30 * 60_000;
// Activity heartbeats (CMD-518): the board reads "working" as fresh for 5 minutes, so a busy turn sends one at most
// every 4, only from a real hook. Every event counts toward the board's 2,000 per run, and after a 429 only run.finished
// goes, so a run sends at most ACTIVITY_BEATS of them; past that, activity goes only when it changes.
const ACTIVITY_BEAT_MS = 4 * 60_000;
export const ACTIVITY_BEATS = 300;
export const ACTIVITY_STATES = ["working", "idle", "waiting", "blocked", "paused"];
/** Why an explicit report cannot go, before anything is changed or sent; null when it can. */
export function reportProblem(report) {
  if (report?.type !== "activity") return null;
  if (!ACTIVITY_STATES.includes(report.state)) return "Unknown activity state";
  if (["waiting", "blocked", "paused"].includes(report.state) && !(typeof report.note === "string" && report.note.trim())) return "This status needs a reason";
  return null;
}
// What the board takes as a sessionId (PipeXP #520 lib/event-schema.ts); any other id is left off, never the event.
const SESSION_ID = /^[a-zA-Z0-9._-]{1,100}$/;
const held = (s) => ["waiting", "blocked", "paused"].includes(s.activity?.state) || (s.activity?.source === "agent" && s.activity.state === "idle");
const activity = (s, state, at, source = "hook", note) => {
  s.activity = { state, observedAt: new Date(at).toISOString(), source, ...(note && { note }) };
};
// A tool call may move the card at most once a minute, so a fix-test loop does not flood the board.
const DWELL_MS = 60_000;
const FAILS_FOR_SNAG = 3;
// The board caps human-turn counts here (lib/event-schema.ts counters).
const MAX_TURNS = 10_000;

// Edit tools by agent: Codex apply_patch; Claude Code and Cursor Edit, Write, MultiEdit, StrReplace; Gemini CLI
// write_file, replace; OpenCode edit, write, patch.
const EDIT_TOOLS = /^(apply_patch|Edit|Write|MultiEdit|NotebookEdit|StrReplace|write_file|replace|edit|write|patch)$/;
const SWITCH_CMD = /\bgit\s+(checkout|switch)\b|\bgh\s+pr\s+checkout\b/;
export const PR_CMD = /\bgh\s+pr\s+(create|ready)\b|\bgit\s+push\b/;
const TEST_CMD =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|typecheck|lint|build|check|e2e)\b|\b(npx\s+)?(vitest|jest|pytest|playwright|mocha|tsc|eslint|rspec|phpunit)\b|\bcargo\s+(test|check|clippy|build)\b|\bgo\s+(test|vet|build)\b|\b(gradle|mvn|dotnet)\s+test\b|\bnode\s+--test\b|\bmake\s+(test|check)\b/;
const NOT_TICKETS = new Set(["UTF", "SHA", "ISO", "MD", "PR", "ISSUE", "FEAT", "FIX", "CHORE", "RELEASE", "HOTFIX", "BUGFIX", "SPRINT", "WEEK", "DAY", "PHASE", "STEP", "PART"]);

/** Python's uuid5(NAMESPACE_URL, name), so ids match the ship scripts'. */
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
    ticket: /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/.test(ctx.ticket ?? "") ? ctx.ticket : null,
    ticketReported: /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/.test(ctx.ticket ?? ""),
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
    // Human turns (CMD-428): counts only. A prompt's text is never read, kept or sent.
    turns: 0,
    interrupts: 0,
    inTurn: false,
    // Started by a restart from the board (CMD-80): linked to the run it replaced, on the same ticket.
    fields: /^[0-9a-f-]{36}$/i.test(ctx.parentRunId ?? "") ? { parentRunId: ctx.parentRunId } : {},
    fails: 0,
    lastSeenAt: ctx.now,
  };
}

/** A fresh id per event. The outbox keeps it, so every resend of a queued event carries the same id. */
function event(s, type, fields, at) {
  // The board refuses an observation later than its event: an activity from after this moment is left off.
  const act = s.activity && Date.parse(s.activity.observedAt) <= at ? s.activity : null;
  const out = { eventId: randomUUID(), runId: s.runId, occurredAt: new Date(at).toISOString(), skill: s.skill, runtime: s.runtime, type,
    ...(SESSION_ID.test(s.sessionId ?? "") && { sessionId: s.sessionId }), ...(act && { activity: act }) };
  // What the board last heard of this session's activity, and when.
  if (act) {
    s.activitySent = act.state;
    s.activitySentAt = at;
  }
  if (s.ticket) out.ticket = s.ticket;
  if (s.attemptId) out.attemptId = s.attemptId;
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * Activity the board has not heard yet (CMD-518): a change at once, else, while working, a heartbeat at most every
 * ACTIVITY_BEAT_MS and ACTIVITY_BEATS per run, so the run stays under the board's event cap; a beat carries only an observation
 * this hook just made. Nothing when the board cannot
 * take activity, or when an event in out already carries it.
 */
function sendActivity(s, ctx, out, at, beat = true) {
  if (!s.activity || ctx.activity === false || out.some((e) => e.activity)) return;
  const beats = s.beats?.[s.runId] ?? 0;
  if (s.activity.state !== s.activitySent) out.push(event(s, "activity.reported", {}, at));
  else if (beat && s.activity.state === "working" && Date.parse(s.activity.observedAt) === at && at - (s.activitySentAt ?? 0) >= ACTIVITY_BEAT_MS && beats < ACTIVITY_BEATS) {
    s.beats = { ...s.beats, [s.runId]: beats + 1 };
    // _beat: while the board is out of reach, the outbox keeps only the newest (core/queue.mjs).
    out.push({ ...event(s, "activity.reported", {}, at), _beat: true });
  }
}

/** A usage.reported the sender fills in from the transcript, so a hook never reads big files. */
const usageMarker = (s, stage, at) => ({
  ...event(s, "usage.reported", { stage: stage ?? undefined }, at),
  // until: the snapshot is as of now, however late the flush reads the transcript (CMD-518: after a move, the old run's
  // last usage must not take in the new project's work).
  _usage: { runtime: s.runtime, session: s.sessionId, transcriptPath: s.transcriptPath, since: s.startedAt, until: new Date(at).toISOString(), ...(s.reported && { reported: s.reported }) },
});

function startFields(s, ctx, claim) {
  // On the ship scripts' own run: their title, profile and branch stay (a start overwrites all four), with who is on it.
  if (s.joined && s.runId === s.joined) {
    const f = s.shipFields ?? {};
    const minimal = ctx.content === "minimal";
    return {
      title: (!minimal && f.title) || s.ticket || "Ship run",
      owner: minimal ? null : (f.owner ?? s.owner ?? null),
      profile: f.profile ?? null,
      branch: minimal ? null : (f.branch ?? null),
      claim,
      machineId: ctx.machineId,
      pluginVersion: "pipexp " + VERSION,
      runtimeVersion: s.runtimeVersion,
      ...(s.prNumber && { prNumber: s.prNumber }),
    };
  }
  const { title: _title, ...fields } = ctx.content === "minimal" ? s.fields : {};
  // The old checkout's PR is unlinked once, with the first start after the change (R5 on #520). A later start on the same
  // branch leaves prNumber out, so a PR the board linked by itself stays linked even when this machine's lookup finds none.
  const dropPr = s.prDropped;
  s.prDropped = false;
  return {
    title: s.title,
    owner: s.owner ?? null,
    profile: null,
    branch: s.branch,
    claim,
    machineId: ctx.machineId,
    pluginVersion: "pipexp " + VERSION,
    runtimeVersion: s.runtimeVersion,
    // Cursor keeps no token counts on the machine: the board says "Tokens not reported", never 0.
    ...(s.runtime === "cursor" && { tokensReported: false }),
    ...(ctx.content === "minimal" ? fields : s.fields),
    // The card had a ticket and this branch has none: null drops it on the board (CMD-452, board #344). Left out, the
    // board would keep the old one; a session that never had a ticket sends none, so an older board is never refused.
    ...(!s.ticket && s.ticketDropped && { ticket: null }),
    ...(dropPr && { prNumber: null }),
  };
}

/**
 * Reads the branch, ticket and title again; true when the title, branch or ticket changed. A new branch is new work
 * (CMD-370): the card takes its ticket, or keeps one the agent reported, and drops the old branch's PR.
 */
function refresh(s, ctx) {
  const before = s.title + "|" + s.branch + "|" + s.ticket;
  const git = ctx.probe.git(s.cwd) ?? {};
  if (git.branch && git.branch !== "HEAD" && git.branch !== s.gitBranch) {
    if (s.gitBranch) {
      const had = s.ticket;
      s.ticket = ticketOf(git.branch) ?? (s.ticketReported ? s.ticket : null);
      if (had && !s.ticket) s.ticketDropped = true;
      s.ticketReported = s.ticketReported && !ticketOf(git.branch);
      s.prNumber = null;
      s.prDropped = true;
      s.ignorePrBranch = null;
    }
    s.gitBranch = git.branch;
  }
  if (s.gitBranch) s.branch = s.gitBranch;
  s.ticket = s.ticket ?? ticketOf(s.branch);
  // Who started it, once per session. Minimal content names nobody.
  if (ctx.content === "minimal") s.owner = null;
  else if (s.owner === undefined || s.owner === null) s.owner = ctx.probe.githubLogin?.() ?? null;
  const repo = git.repo ?? (s.cwd ? s.cwd.split("/").filter(Boolean).pop() : null);
  const minimal = ctx.content === "minimal";
  const named = minimal ? null : ctx.probe.threadName(s.sessionId, s.transcriptPath);
  s.title = (minimal ? null : s.fields.title) ?? (named || (minimal ? repo : [repo, s.branch].filter(Boolean).join(" · ")) || "Agent session");
  if (minimal) s.branch = null;
  return before !== s.title + "|" + s.branch + "|" + s.ticket;
}

/** What rides on every step.entered: the session's PR and its human-turn counts, when known (CMD-427, CMD-428). */
function extras(s, extra) {
  const turns = s.turns ? { humanTurns: Math.min(s.turns, MAX_TURNS), interrupts: Math.min(s.interrupts ?? 0, MAX_TURNS) } : null;
  const counters = turns || extra.counters ? { ...turns, ...extra.counters } : undefined;
  return { ...(s.prNumber && { prNumber: s.prNumber }), ...extra, ...(counters && { counters }) };
}

function enter(s, stage, at, out, extra = {}, force = false) {
  if (!force && s.stage === stage && !Object.keys(extra).length) return;
  extra = extras(s, extra);
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
  // A resumed run was finished on the board: re-entering its stage makes it active again. Only a stage of this lane:
  // the board refuses any other (CMD-370, 27 Sep 20:45:41 UTC: ship:S5 re-entered on the manager lane).
  if (s.finished && s.stage?.startsWith(s.skill + ":")) enter(s, s.stage, ctx.now, out, {}, true);
  s.started = true;
  s.finished = false;
}

const revive = (s, ctx, out) => {
  if (!s.started) start(s, ctx, "new", out);
  else if (s.finished) start(s, ctx, "resume", out);
};

const SHIP_CHECK_MS = 60_000;
const shipStep = (stage) => (/^ship:S\d+$/.test(stage ?? "") ? Number(stage.slice(6)) : -1);
/** Whether the card in use is the ship scripts' run (a shepherd or agent lane the session moved to is the plugin's own). */
const onShip = (s) => !!s.joined && s.runId === s.joined;
/** The outcome ship's own finish reports for a status (claim-run.sh run_state "finish"). */
const shipOutcome = (status) => {
  const st = String(status ?? "").toLowerCase();
  return st.includes("blocked") ? "blocked" : st === "ready" || st === "technically_green" || st.includes("human") ? "ready" : st === "merged" ? "merged" : "abandoned";
};

/** A ship claim's owner is this session, or, for the one ticket it adopted, the task it acts for (shipTask). */
const ours = (s, owner, ticket) => !!owner && (owner === s.sessionId || (!!s.shipTask && owner === s.shipTask && ticket === s.shipTaskTicket));
// claim-run.sh <ticket> <task-id> [...]: the ship scripts' claim, heartbeat or release for that task.
const CLAIM_ARGS = /claim-run\.sh["']?\s+([A-Za-z][A-Za-z0-9]{1,9}-\d{1,6})\s+["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * The ship run is no longer this session's: the scripts finished it (runId cleared), released the claim, or another task
 * took it over. Finished or released, it is finished again with the outcome ship's own finish reports, so a run the
 * plugin kept alive while the scripts' telemetry was off is never left open (same outcome, so no harm when the scripts
 * sent theirs); a takeover is the new owner's. The session goes back to its own, finished, run.
 */
function leaveShip(s, ctx, at, out) {
  const st = ctx.probe.shipState?.(s.cwd, s.joinedTicket ?? s.ticket);
  if (st === undefined) return false;
  const takenOver = !!st?.owner && !ours(s, st.owner, st.ticket);
  // Leave only on proof: the scripts cleared or replaced the run, released the claim, or another task holds it. A read
  // caught mid-heartbeat (an empty owner.json, a state.json being written) keeps the session on the run.
  if (!st || !(takenOver || !st.locked || st.runId !== s.joined)) return false;
  if (!takenOver) {
    const ship = { ...s, runId: s.joined, skill: "ship", ticket: s.joinedTicket ?? s.ticket, activity: undefined, attemptId: undefined };
    out.push(event(ship, "run.finished", { outcome: shipOutcome(st?.status), prNumber: st?.pr ?? null }, at));
  }
  const back = s.runs?.agent && s.runs.agent !== s.joined ? s.runs.agent : uuid5("pipexp/session/" + s.sessionId);
  if (s.runs?.ship === s.joined) delete s.runs.ship;
  if (s.runId === s.joined) {
    s.runId = back;
    s.skill = "agent";
    s.stage = null;
    s.started = true;
    s.finished = true;
    s.explicit = false;
  }
  s.joined = null;
  s.joinedTicket = null;
  s.shipFields = null;
  // An adopted claim ends with it: a later claim of the same manager is another worker's.
  s.shipTask = s.shipTaskTicket = null;
  return true;
}

/**
 * The agent names a ticket other than the ship claim it reports onto (CMD-535, 4 Oct: NJ-3323's chat looked into
 * NJ-3449 and reported it onto NJ-3323's ship run, relabelling that card). That is other work: the session goes back to
 * its own run for it, the claim's run stays the scripts', and it is not joined again until the agent names that ticket
 * or runs ship's claim script again.
 */
function leaveForTicket(s) {
  s.notShip = s.joined;
  s.notShipTicket = s.joinedTicket ?? s.ticket;
  const back = s.runs?.agent && s.runs.agent !== s.joined ? s.runs.agent : uuid5("pipexp/session/" + s.sessionId);
  if (s.runs?.ship === s.joined) delete s.runs.ship;
  s.runId = back;
  s.skill = "agent";
  s.stage = null;
  s.started = true;
  s.finished = true;
  s.explicit = false;
  s.joined = null;
  s.joinedTicket = null;
  s.shipFields = null;
}

/**
 * A session the repo's ship scripts have claimed reports onto their run, so its ticket has one card that keeps moving
 * (Derek, 29 Sep: cards sat at Take the ticket for hours). Before, the plugin went quiet under a claim, but the scripts
 * report a step only when the agent remembers --step, and never live activity: the card froze, and the plugin's own
 * run was left behind as a second, stuck card. Now the plugin closes its own run once, then sends activity, the PR, the
 * agent's stage reports and the step ship's state.json has in progress to the ship run, and lets go when the scripts
 * finish, release or hand it over. A claim with no run leaves the session to the plugin. Checked at turn edges, on ship's
 * claim script, and at most once a minute otherwise.
 * ponytail: the card can briefly step back if the scripts' --step heartbeat ran ahead of state.json; record the step in
 * state.json (claim-run) if that shows up.
 */
function followShip(s, ctx, at, out, force = false) {
  if (!force && at - (s.shipCheckedAt ?? 0) < SHIP_CHECK_MS) return;
  s.shipCheckedAt = at;
  s.shipOwned = false; // older plugins went quiet under a claim; nothing does now
  // The one claim this session adopted through claim-run.sh (a manager's ticket it builds), else its own. The adoption
  // ends on proof the claim is over: released, held by another task, or no run.
  let ship;
  if (s.shipTask) {
    const st = ctx.probe.shipState?.(s.cwd, s.shipTaskTicket);
    if (st === undefined) return;
    if (st && (!st.locked || (st.owner && st.owner !== s.shipTask) || !st.runId)) s.shipTask = s.shipTaskTicket = null;
    else if (st) ship = st;
  }
  if (ship === undefined) ship = ctx.probe.shipRun?.(s.cwd, s.sessionId);
  if (ship === undefined) return;
  // The run of a claim the agent left for another ticket (leaveForTicket) is not joined again; a new claim's run is.
  if (s.notShip && ship?.runId === s.notShip) return;
  s.notShip = null;
  s.notShipTicket = null;
  // A session an older plugin left on the ship run under another ticket (onReport before leaveForTicket) moves off.
  if (onShip(s) && s.ticket && s.joinedTicket && s.ticket !== s.joinedTicket) {
    leaveForTicket(s);
    revive(s, ctx, out);
    return;
  }
  if (s.joined && (ship?.runId !== s.joined) && !leaveShip(s, ctx, at, out)) {
    // Still this session's, but it now works another ticket it also claimed (CMD-535: NJ-3331's chat stayed on its
    // stale NJ-3256 claim): it moves across, and the old run stays the scripts' to finish. Otherwise it stays put.
    // Only on a clean read that the old claim is still ours: an owner.json caught mid-rewrite proves nothing.
    if (!ship?.runId || ship.ticket === s.joinedTicket || !ours(s, ctx.probe.shipState?.(s.cwd, s.joinedTicket)?.owner, s.joinedTicket)) return;
    if (s.runId === s.joined) s.finished = true;
    if (s.runs?.ship === s.joined) delete s.runs.ship;
    s.joined = null;
    s.joinedTicket = null;
    s.shipFields = null;
  }
  if (!ship?.runId) return;
  if (s.joined !== ship.runId) {
    // Only the plugin's own run is closed; a ship run is the scripts' to finish.
    if (s.started && !s.finished) out.push(event(s, "run.finished", { outcome: "abandoned", prNumber: null }, at));
    refresh(s, ctx);
    s.runs = { ...(s.runs ?? {}), ship: ship.runId };
    s.runId = ship.runId;
    s.skill = "ship";
    s.ticket = ship.ticket;
    s.ticketReported = true;
    // Stages come from the agent and from ship's state from here on, never guessed from tool calls.
    s.explicit = true;
    s.started = true;
    s.finished = false;
    // The scripts' own claim decides which attempt the board follows: this plugin never starts one on their run.
    delete s.attemptId;
    s.stage = null;
    s.joined = ship.runId;
    s.joinedTicket = ship.ticket;
    s.shipFields = ship.fields;
    out.push(event(s, "run.started", startFields(s, ctx, "resume"), at));
    s.lastSentAt = at;
  }
  if (ship.fields) s.shipFields = ship.fields;
  // ship's state.json says which step is in progress; only a later one moves the card, and only the ship run's own.
  if (onShip(s) && ship.step !== null && ship.step > shipStep(s.stage)) enter(s, "ship:S" + ship.step, at, out);
}

// A Codex transcript is rollout-<time>-<thread id>.jsonl. A subagent is its own thread that sends hooks under its parent's
// session_id, so a transcript naming another thread is a subagent's (CMD-535: NJ-3454's subagents took over its turn).
const THREAD_ID = /(?:^|\/)rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
export const subagentPath = (path, sessionId) => {
  const id = typeof path === "string" ? path.match(THREAD_ID)?.[1] : null;
  return !!id && id.toLowerCase() !== String(sessionId).toLowerCase();
};

/**
 * One hook. ctx: { now, runtime, machineId, runtimeVersion?, content, probe: { git, threadName, shipClaim } }.
 * Returns { state, events }. Unknown hooks change nothing.
 */
export function onHook(state, input, ctx) {
  const at = ctx.now;
  const name = input?.hook_event_name;
  if (!input?.session_id) return { state, events: [] };
  if (name === "PrFound" && !state) return { state, events: [] };
  // A subagent's hooks belong to its parent's turn: its own turn, transcript, prompt and Stop are not the session's. Its
  // tool calls show the session working, but only while its own turn does: a subagent still going after the chat's Stop
  // must not reopen it (its own Stop is ignored too). Its other hooks change nothing.
  if (subagentPath(input.transcript_path, input.session_id)) {
    if (!state || state.activity?.state !== "working" || (name !== "PostToolUse" && name !== "PostToolUseFailure")) return { state, events: [] };
    const { transcript_path, turn_id, ...rest } = input;
    input = { ...rest, ...(state.turnId && { turn_id: state.turnId }) };
  }
  const s = state ? structuredClone(state) : newState(input, ctx);
  // A session a subagent took over before this check (0.1.22) had the parent's own turn filed as past: start clean.
  if (subagentPath(s.transcriptPath, s.sessionId) && input.transcript_path) s.pastTurns = [];
  // Codex names each turn: turn_id is on UserPromptSubmit, PostToolUse and Stop (its hook input schemas require it). A
  // hook in a turn other than the last one seen starts a new turn even with no prompt: a delegated turn (a message from
  // another thread) fires no UserPromptSubmit. Runtimes that name no turn wait for a prompt, as before (CMD-518).
  // A hook from a turn that already gave way to a later one arrived late (hooks are separate processes): it says nothing
  // about the current turn, and after a move it must not touch the new project's run (CMD-518).
  if (typeof input.turn_id === "string" && s.pastTurns?.includes(input.turn_id)) return { state: s, events: [] };
  const newTurn = typeof input.turn_id === "string" && !!s.turnId && input.turn_id !== s.turnId;
  if (newTurn) s.pastTurns = [...(s.pastTurns ?? []), s.turnId].slice(-8);
  if (typeof input.turn_id === "string" && input.turn_id) s.turnId = input.turn_id;
  // PrFound comes from the flush, not the agent: it says nothing about whether the session is still going.
  if (name !== "PrFound") s.lastSeenAt = at;
  if (input.transcript_path) s.transcriptPath = input.transcript_path;
  if (input.cwd) s.cwd = s.reportingCwd ?? input.cwd;
  // An agent with no transcript (OpenCode) sends its own running token total with its hooks.
  if (input.pipexp_usage && typeof input.pipexp_usage === "object") s.reported = { ...input.pipexp_usage, startedAt: s.startedAt };
  // Claude Code writes its version into the transcript after the first prompt, so SessionStart may not see it yet.
  // Once it appears, the run's start is sent again (same run, "resume") so the card shows it.
  const version = s.runtimeVersion ?? ctx.runtimeVersion ?? ctx.probe.runtimeVersion?.(s.runtime, s.transcriptPath);
  const learnedVersion = s.started && !s.runtimeVersion && version;
  s.runtimeVersion = version;
  const out = [];
  // The PR the flush found for this branch (core/pr.mjs): the card links to it from its next step.
  const known = s.gitBranch && s.ignorePrBranch !== s.gitBranch ? ctx.probe.pr?.(s.sessionId, s.gitBranch) : null;
  const learnedPr = !!known && known !== s.prNumber;
  if (learnedPr) { s.prNumber = known; s.prDropped = false; }

  const claimScript = name === "PostToolUse" && /claim-run\.sh/.test(commandOf(input.tool_input));
  // Ship's claim script run again: the claim left for another ticket is this session's work again.
  if (claimScript) s.notShip = s.notShipTicket = null;
  // Run for another task's claim (CMD-535, NJ-3501: a manager claimed the ticket, then handed the build to this thread,
  // which heartbeats with the manager's task id): this session acts for that claim and joins its run.
  const args = claimScript ? commandOf(input.tool_input).match(CLAIM_ARGS) : null;
  const task = args?.[2]?.toLowerCase();
  if (task && task !== String(s.sessionId).toLowerCase()) {
    const ticket = args[1].toUpperCase();
    if (!/--release/.test(commandOf(input.tool_input))) {
      s.shipTask = task;
      s.shipTaskTicket = ticket;
    } else if (s.shipTask === task && s.shipTaskTicket === ticket) s.shipTask = s.shipTaskTicket = null;
  }
  const edge = name === "SessionStart" || name === "UserPromptSubmit" || name === "Stop" || claimScript;
  if (name !== "PrFound") followShip(s, ctx, at, out, edge);

  if (name === "SessionStart") {
    if (input.source === "compact" && s.started && !s.finished) return { state: s, events: [] };
    if (!s.activity) activity(s, "idle", at);
    if (!out.some((e) => e.type === "run.started")) start(s, ctx, s.started ? "resume" : "new", out);
    if (!s.stage && !onShip(s)) enter(s, STAGES.explore, at, out);
  } else if (name === "UserPromptSubmit") {
    const was = s.started && !s.finished;
    // A person wrote to the agent. One sent while a turn was still running (no Stop since the last) interrupted it.
    s.turns = (s.turns ?? 0) + 1;
    if (s.inTurn) s.interrupts = (s.interrupts ?? 0) + 1;
    s.inTurn = true;
    activity(s, "working", at);
    revive(s, ctx, out);
    if (was && refresh(s, ctx)) out.push(event(s, "run.started", startFields(s, ctx, "resume"), at));
    // The counts go with the next step.entered: this turn's end (Waiting for you) or a skill's next stage.
    if (!s.explicit) enter(s, STAGES.explore, at, out);
    // Back from waiting, a session that reports its own stages picks up the one it was in (CMD-374, CMD-518).
    // managerStage is shared by the agent and manager lanes: only a stage of this lane is picked up.
    else if (WAITING[s.skill] && s.stage === WAITING[s.skill]) enter(s, s.managerStage?.startsWith(s.skill + ":") ? s.managerStage : RESUME[s.skill], at, out);
    if (!out.length) out.push(event(s, "activity.reported", {}, at));
  } else if (name === "PostToolUse" || name === "PostToolUseFailure") {
    // A new turn is working, whatever was held (a board stop, or a status the agent reported); in the same turn a hold
    // stays. After a finish, only a turn that started since then is new work.
    const since = !s.finished || (!!s.finishedTurn && s.turnId !== s.finishedTurn);
    // The same work keeps its one-line description (an explicit note); a new turn starts without one (CMD-518).
    if (newTurn || (since && !held(s))) activity(s, "working", at, "hook", !newTurn && s.activity?.state === "working" ? s.activity.note : undefined);
    // Finished (pipexp_finish, or the session handed back): the rest of this turn's tool calls leave the card at
    // Done (CMD-370: a finish was undone 144 ms later), and a later turn's never reopen it; only its activity goes.
    if (s.finished) {
      sendActivity(s, ctx, out, at);
      return { state: s, events: out };
    }
    revive(s, ctx, out);
    const cmd = commandOf(input.tool_input);
    // Claude Code sends a failed tool call as its own event (PostToolUseFailure, with "error"), Codex inside the response.
    const didFail = name === "PostToolUseFailure" || failed(input.tool_response);
    const pushed = PR_CMD.test(cmd) && !didFail;
    const pr = pushed ? prFrom(input.tool_response) : null;
    if (pr) { s.prNumber = pr; s.prDropped = false; s.ignorePrBranch = null; }
    if (SWITCH_CMD.test(cmd) && !didFail && refresh(s, ctx)) {
      // Another branch is other work: the note described the old one.
      if (s.activity?.note) activity(s, s.activity.state, at, s.activity.source);
      out.push(event(s, "run.started", startFields(s, ctx, "resume"), at));
    }
    // A push or PR that failed (no remote, no auth) leaves the card where it was.
    const guess = s.explicit ? null : stageForTool(input.tool_name, input.tool_input);
    const stage = guess === STAGES.pr && !pushed ? null : guess;
    if (stage && stage !== s.stage && (stage === STAGES.pr || at - s.stageAt >= DWELL_MS || s.stage === STAGES.explore)) enter(s, stage, at, out);
    // No stage beat on the scripts' run: their own --step may be ahead of the stage this plugin last sent.
    else if (s.stage && !onShip(s) && at - s.lastSentAt >= BEAT_MS) {
      // A heartbeat, so a long test run or CI wait never shows Stalled.
      s.lastSentAt = at;
      // _beat: the outbox keeps only the newest heartbeat per stage while the board is out of reach (CMD-95).
      out.push({ ...event(s, "step.entered", extras(s, { stage: s.stage }), at), _beat: true });
    }
    if (TEST_CMD.test(cmd)) {
      s.fails = didFail ? s.fails + 1 : 0;
      if (s.fails === FAILS_FOR_SNAG)
        out.push(event(s, "snag.reported", { stage: s.stage ?? undefined, kind: "snag", theme: "checks failing", what: "The same checks failed " + FAILS_FOR_SNAG + " times in a row: " + cmd.slice(0, 200), costMin: null }, at));
    }
    sendActivity(s, ctx, out, at);
  } else if (name === "Stop") {
    s.inTurn = false;
    // The turn ends idle, unless a hold was set in this very turn (a board stop, blocked, paused, waiting).
    if (newTurn || !held(s)) activity(s, "idle", at);
    // A finished workflow stays finished with its outcome: only the session's activity goes (CMD-518).
    if (s.finished) {
      sendActivity(s, ctx, out, at, false);
      return { state: s, events: out };
    }
    revive(s, ctx, out);
    if (refresh(s, ctx) || learnedVersion) out.push(event(s, "run.started", startFields(s, ctx, "resume"), at));
    if (!s.explicit) enter(s, STAGES.waiting, at, out);
    // The agent and manager lanes have their own Waiting for you (CMD-374, CMD-518). managerStage: the stage to pick up
    // at the next prompt, for either lane (the name predates the agent lane).
    else if (WAITING[s.skill]) {
      if (s.stage !== WAITING[s.skill]) s.managerStage = s.stage;
      enter(s, WAITING[s.skill], at, out);
    }
    else out.push(usageMarker(s, s.stage, at));
    if (!out.some((e) => e.type !== "usage.reported")) out.push(event(s, "activity.reported", {}, at));
  } else if (name === "SessionEnd") {
    if (!s.started || s.finished) return { state: s, events: [] };
    if (!held(s)) activity(s, "idle", at);
    // The ship scripts finish their own run; a session ending says only that nobody is working on it now.
    if (onShip(s)) {
      out.push(usageMarker(s, s.stage, at), event(s, "activity.reported", {}, at));
      return { state: s, events: out };
    }
    // Waiting spends no tokens: Stop already reported the turn's usage.
    if (s.stage !== STAGES.waiting) out.push(usageMarker(s, s.stage, at));
    // A session that ends after its turn finished was handed back to its person: ready. One cut off mid-turn
    // (closed, killed) is abandoned. A skill run that never reported its own finish did not complete.
    const handedBack = s.prNumber || s.stage === STAGES.waiting || s.stage === MANAGER_WAITING;
    s.outcome = handedBack ? "ready" : "abandoned";
    out.push(event(s, "run.finished", { outcome: s.outcome, prNumber: s.prNumber }, at));
    s.finished = true;
    s.finishedTurn = s.turnId ?? null;
  } else if (name !== "PrFound") {
    return { state: s, events: [] };
  }
  // A PR learned with nothing else to send: one step.entered for the stage the card is in carries it.
  if (learnedPr && onShip(s)) out.push(event(s, "run.started", startFields(s, ctx, "resume"), at));
  else if (learnedPr && s.started && !out.some((e) => e.type === "step.entered" || e.type === "run.finished")) {
    // A finished run is not reopened: its finish is sent again with the PR (the push landed after the session ended).
    if (s.finished) s.outcome && out.push(event(s, "run.finished", { outcome: s.outcome, prNumber: s.prNumber }, at));
    else if (s.stage) enter(s, s.stage, at, out, {}, true);
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
  // Naming the ticket of the claim it left: back on that claim's run.
  if (s.notShip && report.ticket && report.ticket === s.notShipTicket) s.notShip = s.notShipTicket = null;
  followShip(s, ctx, at, out, true);
  const leftShip = onShip(s) && !!report.ticket && report.ticket !== (s.joinedTicket ?? s.ticket);
  if (leftShip) leaveForTicket(s);
  const fields = report.type === "snag.reported" ? snagFields(report.fields) : { ...(report.fields ?? {}) };
  const metadataChanged = s.started && (report.type === "stage" || report.type === "activity") && refresh(s, ctx);
  const changedTicket = !!report.ticket && (report.ticket !== s.ticket || leftShip);
  if (report.ticket) {
    if (changedTicket) {
      s.prNumber = null;
      s.prDropped = true;
      s.ignorePrBranch = s.gitBranch;
    }
    s.ticket = report.ticket;
    s.ticketReported = true;
  }
  if (report.type === "activity") {
    const problem = reportProblem(report);
    if (problem) throw new Error(problem);
    activity(s, report.state, at, report.source === "hook" ? "hook" : "agent", ctx.content === "minimal" ? undefined : words(report.note));
    // Status changes do not reopen a finished workflow or claim its ticket is complete.
    if (!s.started || changedTicket) start(s, ctx, s.started ? "resume" : "new", out);
    else if (metadataChanged) out.push(event(s, "run.started", startFields(s, ctx, "resume"), at));
    out.push(event(s, "activity.reported", {}, at));
    return { state: s, events: out };
  }
  if (report.type === "run.started") activity(s, "working", at, "agent");
  // A finished workflow says nothing about whether the session is still working: only a blocked finish is a status.
  if (report.type === "run.finished" && fields.outcome === "blocked") activity(s, "blocked", at, "agent", ctx.content === "minimal" ? undefined : fields.question);
  if (report.type === "stage") {
    const skill = report.stage.split(":")[0];
    // On the ship run, the plugin's own lane is not other work: an agent stage (Explore, Build) is the session working,
    // never a second card beside the ship one.
    if (onShip(s) && skill === "agent") {
      activity(s, "working", at, "agent", ctx.content === "minimal" ? undefined : words(report.note));
      out.push(event(s, "activity.reported", {}, at));
      return { state: s, events: out };
    }
    const moved = skill !== s.skill;
    // A claim (new, resume or takeover) is a new attempt: only the latest attempt moves the card on the board.
    if (report.claim && !onShip(s)) s.attemptId = randomUUID();
    if (moved) {
      // Tokens spent so far belong to the stage being left, on the run being left.
      if (s.started && !s.finished && s.stage) out.push(usageMarker(s, s.stage, at));
      s.runs ??= { [s.skill]: s.runId };
      const fromSkillLane = s.skill !== "agent";
      if (fromSkillLane || s.runs[skill]) {
        // Another skill lane: its own run, started now, and a child of the lane it came from.
        const parent = s.runs.ship ?? s.runId;
        // A session that moved repo (s.scope) names its lane runs after that repo too, so no run id is in two projects.
        s.runId = s.runs[skill] ?? uuid5("pipexp/session/" + s.sessionId + (s.scope ? "/repo/" + s.scope : "") + "/" + skill);
        if (!s.runs[skill]) {
          s.started = false;
          s.startedAt = new Date(at).toISOString();
          s.stage = null;
          s.fields = parent !== s.runId ? { parentRunId: parent } : {};
        } else if (!s.stage?.startsWith(skill + ":")) s.stage = null; // the lane left's stage is not this run's
      }
      s.runs[skill] = s.runId;
      s.skill = skill;
      if (skill !== "agent") s.fields = { ...(ctx.probe.skillInfo?.(s.cwd, skill) ?? {}), ...s.fields };
    }
    // Working is observed on the lane now in use only: the lane left above got its usage with the observation it had,
    // so after ship, shepherd, ship the board's row is ship, never a tie with the lane just left (CMD-518).
    // The agent's own one-line summary of the work may come with the stage (CMD-518); none under minimal content.
    activity(s, "working", at, "agent", ctx.content === "minimal" ? undefined : words(report.note));
    s.explicit = true;
    if (moved || metadataChanged || changedTicket || report.claim || !s.started || s.finished) start(s, ctx, report.claim ?? (moved || !s.started ? "new" : "resume"), out);
    enter(s, report.stage, at, out, fields, true);
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
        s.finishedTurn = s.turnId ?? null;
      }
      out.push(event(s, report.type, { ...(report.type === "snag.reported" && { stage: s.stage ?? undefined }), ...fields }, at));
    }
  }
  return { state: s, events: out };
}

/** How long an agent- or manager-lane card may sit with no hook before it shows Waiting for you (CMD-370, CMD-374). */
export const IDLE_MS = 2 * 3_600_000;

/**
 * A session no hook has heard from for IDLE_MS: Codex sends nothing when a thread is closed or a turn is interrupted,
 * so its card would sit in Build or Test and show Stalled. It moves to Waiting for you, which never stalls; the next
 * prompt moves it on. Skill lanes (ship and the rest) keep their stage: a stalled skill step means something.
 */
export function onIdle(state, now) {
  const waiting = state?.skill === "manager" ? MANAGER_WAITING : STAGES.waiting;
  if (!state?.started || state.finished || state.shipOwned || (state.skill !== "agent" && state.skill !== "manager") || state.stage === waiting || now - state.lastSeenAt < IDLE_MS) {
    return { state, events: [] };
  }
  const s = structuredClone(state);
  const out = [];
  enter(s, waiting, now, out);
  return { state: s, events: out };
}
