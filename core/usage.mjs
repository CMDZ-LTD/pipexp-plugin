/**
 * Usage for one agent run, read from the runtime's own logs, shaped as the board's
 * usage.reported agents array. Ported from Nudj ship's telemetry/usage.mjs (PR #4823).
 *
 * Codex: the thread's rollout plus every descendant thread. Claude: the session transcript plus
 * its sub-agents; a logged effort wins, else configuredEffort(role) ("configured").
 * Each agent also gets its working time, its time inside tool calls over a minute, its context
 * resets and the runtime's version, all from the same timestamped log lines.
 *
 * Never throws: unreadable or malformed files are skipped, and nothing found gives [].
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const MAX_AGENTS = 50;
const HEAD_BYTES = 512 * 1024;
const VERSION = /^[a-z][a-z0-9-]{1,19} (?=[0-9A-Za-z.+-]*\d)[0-9A-Za-z.+-]{1,40}$/;

const effortOf = (e) => (EFFORTS.includes(e) ? e : "unknown");
const iso = (ms) => new Date(ms).toISOString();
const versionOf = (runtime, v) =>
  typeof v === "string" && VERSION.test(runtime + " " + v) ? { runtimeVersion: runtime + " " + v } : {};
const timeOf = (r) => Date.parse(r?.timestamp);

/** Every JSON line of a file; a malformed line becomes {}, an unreadable file []. */
function lines(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      rows.push(row && typeof row === "object" ? row : {});
    } catch {
      rows.push({});
    }
  }
  return rows;
}

/** The first line of a file, parsed, reading at most 512 KB; null when unreadable or malformed. */
function firstLine(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    const end = buf.subarray(0, n).indexOf(10);
    const row = JSON.parse(buf.toString("utf8", 0, end < 0 ? n : end));
    return row && typeof row === "object" ? row : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

/** Files under dir (any depth, in name order) that match and were modified at or after since. */
function recentFiles(dir, match, since) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (match(f)) {
        try {
          if (statSync(f).mtimeMs >= since) out.push(f);
        } catch {}
      }
    }
  };
  walk(dir);
  return out;
}

/** Wall clock and start of the lines at or after since; null when none. */
function window(rows, since) {
  let start = Infinity;
  let end = -Infinity;
  for (const r of rows) {
    const t = timeOf(r);
    if (!(t >= since)) continue;
    if (t < start) start = t;
    if (t > end) end = t;
  }
  if (start === Infinity) return null;
  return { startedAt: iso(start), wallSeconds: Math.round((end - start) / 1000) };
}

/**
 * steps: [{at, kind: "model" | "person" | "call" | "output", id}] from the whole log. A tool call over a
 * minute (tests, CI polls, sleeps, helper waits) is waiting; a gap that ends in a person's message is idle;
 * the rest is working. Parallel calls are merged, so no second is counted twice. Only time at or after
 * since counts: a call that started earlier counts from since.
 */
function timing(steps, compactions, since) {
  const resets = { compactions: Math.min(1000, compactions) };
  steps.sort((a, b) => a.at - b.at);
  const started = new Map();
  const waits = [];
  for (const s of steps) {
    if (s.kind === "call" && !started.has(s.id)) started.set(s.id, s.at);
    if (s.kind === "output" && started.has(s.id) && s.at - started.get(s.id) > 60_000 && s.at > since)
      waits.push([Math.max(since, started.get(s.id)), s.at]);
  }
  const inWindow = steps.filter((s) => s.at >= since);
  // Under two lines there is no interval to judge: no times rather than "worked 0m"; resets still count.
  if (inWindow.length < 2 && !waits.length) return compactions ? resets : {};
  const merged = [];
  for (const [a, b] of waits.sort((x, y) => x[0] - y[0])) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  let active = 0;
  for (let i = 1; i < inWindow.length; i++) {
    const [a, b] = [inWindow[i - 1].at, inWindow[i].at];
    if (inWindow[i].kind !== "person" && !merged.some(([s, e]) => s <= a && b <= e)) active += b - a;
  }
  const secs = (ms) => Math.min(1e7, Math.round(ms / 1000));
  return {
    activeSeconds: secs(active),
    toolWaitSeconds: secs(merged.reduce((sum, [a, b]) => sum + b - a, 0)),
    compactions: Math.min(1000, compactions),
  };
}

function codexTiming(rows, since) {
  const steps = rows
    .filter((r) => r.type === "response_item" && r.timestamp)
    .map((r) => {
      const { type = "", role, call_id: id } = r.payload ?? {};
      const kind =
        id && type.endsWith("_call_output") ? "output"
        : id && type.endsWith("_call") ? "call"
        : type === "message" && role !== "assistant" ? "person"
        : "model";
      return { at: timeOf(r), kind, id };
    });
  const compactions = rows.filter((r) => r.type === "compacted" && timeOf(r) >= since).length;
  return timing(steps, compactions, since);
}

// Claude logs a tool result as a user line; only a user line without one is a person.
function claudeTiming(rows, since) {
  const steps = [];
  for (const r of rows) {
    if ((r.type !== "user" && r.type !== "assistant") || !r.timestamp) continue;
    const at = timeOf(r);
    const parts = Array.isArray(r.message?.content) ? r.message.content : [];
    const results = parts.filter((c) => c?.type === "tool_result");
    const uses = parts.filter((c) => c?.type === "tool_use");
    if (results.length) for (const c of results) steps.push({ at, kind: "output", id: c.tool_use_id });
    else if (r.type === "user") steps.push({ at, kind: "person" });
    else if (uses.length) for (const c of uses) steps.push({ at, kind: "call", id: c.id });
    else steps.push({ at, kind: "model" });
  }
  const compactions = rows.filter(
    (r) => r.type === "system" && r.subtype === "compact_boundary" && timeOf(r) >= since
  ).length;
  return timing(steps, compactions, since);
}

/** A Codex thread's parent: top-level parent_thread_id, or the one nested under source.subagent. */
const parentOf = (meta) =>
  meta?.parent_thread_id ?? meta?.source?.subagent?.thread_spawn?.parent_thread_id ?? null;

function codexRole(meta) {
  const role = meta.agent_role ?? meta.source?.subagent?.thread_spawn?.agent_role;
  return typeof role === "string" && role ? role.slice(0, 40) : "subagent";
}

function codexAgent(file, parent, since) {
  const rows = lines(file);
  const meta = rows.find((r) => r.type === "session_meta")?.payload ?? {};
  const span = window(rows, since);
  if (!span || typeof meta.id !== "string") return null;
  const totals = rows.filter((r) => r.payload?.type === "token_count" && r.payload.info);
  const total = (rs) => rs[rs.length - 1]?.payload.info.total_token_usage ?? {};
  const [before, now] = [total(totals.filter((r) => timeOf(r) < since)), total(totals)];
  const diff = (k) => Math.max(0, (Number(now[k]) || 0) - (Number(before[k]) || 0));
  const turns = rows.filter((r) => r.type === "turn_context");
  const turn = turns[turns.length - 1]?.payload ?? {};
  return {
    agentId: meta.id,
    parentAgentId: parent,
    role: parent ? codexRole(meta) : "main",
    model: String(turn.model ?? "unknown").slice(0, 60),
    effort: effortOf(turn.effort),
    effortSource: "observed",
    tokens: {
      input: diff("input_tokens"),
      cachedInput: diff("cached_input_tokens"),
      output: diff("output_tokens"),
      reasoning: diff("reasoning_output_tokens"),
    },
    ...span,
    ...codexTiming(rows, since),
    ...versionOf("codex", meta.cli_version),
  };
}

function codex({ since, session, transcriptPath, codexHome }) {
  const files = recentFiles(join(codexHome, "sessions"), (f) => /rollout-[^/]*\.jsonl$/.test(f), since);
  let root = transcriptPath && existsSync(transcriptPath) ? transcriptPath : undefined;
  if (!root && session) root = files.find((f) => f.endsWith("-" + session + ".jsonl"));

  // Only the first line (session_meta) of every other recent file: enough to build the thread tree.
  // Full parsing is kept for the root and its descendants.
  const children = new Map();
  for (const file of files) {
    if (file === root) continue;
    const head = firstLine(file);
    const meta = head?.type === "session_meta" ? head.payload : null;
    if (typeof meta?.id !== "string") continue;
    if (!root && meta.id === session) {
      root = file;
      continue;
    }
    const parent = parentOf(meta);
    if (typeof parent !== "string") continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(file);
  }
  if (!root) return [];

  const agents = [];
  const seen = new Set();
  const visit = (file, parent) => {
    const agent = codexAgent(file, parent, since);
    if (!agent || seen.has(agent.agentId)) return;
    seen.add(agent.agentId);
    agents.push(agent);
    for (const child of children.get(agent.agentId) ?? []) visit(child, agent.agentId);
  };
  visit(root, null);
  return agents;
}

function claudeAgent(file, agentId, parentAgentId, role, configured, since) {
  const rows = lines(file);
  const span = window(rows, since);
  if (!span) return null;
  // One message can be logged more than once under the same id: it counts once.
  const seen = new Map();
  for (const r of rows) {
    if (r.type === "assistant" && timeOf(r) >= since && r.message?.usage) {
      seen.set(r.message.id ?? seen.size, r);
    }
  }
  const tokens = { input: 0, cachedInput: 0, output: 0, reasoning: 0 };
  for (const { message } of seen.values()) {
    const u = message.usage;
    tokens.input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    tokens.cachedInput += u.cache_read_input_tokens ?? 0;
    tokens.output += u.output_tokens ?? 0;
    tokens.reasoning += u.output_tokens_details?.thinking_tokens ?? 0;
  }
  const last = [...seen.values()].pop();
  const observed = last?.effort;
  const versioned = rows.filter((r) => timeOf(r) >= since && typeof r.version === "string").pop();
  return {
    agentId,
    parentAgentId,
    role: String(role).slice(0, 40),
    model: String(last?.message.model ?? "unknown").slice(0, 60),
    effort: effortOf(observed ?? configured),
    effortSource: observed || !parentAgentId ? "observed" : "configured",
    tokens,
    ...span,
    ...claudeTiming(rows, since),
    ...versionOf("claude", versioned?.version),
  };
}

/** The one transcript named <session>.jsonl in a project dir, modified at or after since. */
function claudeTranscript(claudeHome, session, since) {
  const projects = join(claudeHome, "projects");
  let dirs;
  try {
    dirs = readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return undefined;
  }
  const found = [];
  for (const d of dirs) {
    const f = join(projects, d.name, session + ".jsonl");
    try {
      if (statSync(f).mtimeMs >= since) found.push(f);
    } catch {}
  }
  return found.length === 1 ? found[0] : undefined;
}

function claude({ since, session, transcriptPath, claudeHome, configuredEffort }) {
  const main =
    transcriptPath && existsSync(transcriptPath)
      ? transcriptPath
      : session
        ? claudeTranscript(claudeHome, session, since)
        : undefined;
  if (!main) return [];
  const id = basename(main, ".jsonl");
  const configured = (role) => {
    try {
      const effort = configuredEffort?.(role);
      return typeof effort === "string" ? effort : undefined;
    } catch {
      return undefined;
    }
  };
  const subDir = join(dirname(main), id, "subagents");
  const subs = recentFiles(subDir, (f) => /agent-[^/]+\.jsonl$/.test(f), since).map((file) => {
    const agentId = basename(file, ".jsonl").replace(/^agent-/, "");
    let meta = {};
    try {
      meta = JSON.parse(readFileSync(join(subDir, "agent-" + agentId + ".meta.json"), "utf8")) ?? {};
    } catch {}
    const role = typeof meta.agentType === "string" && meta.agentType ? meta.agentType : "subagent";
    return claudeAgent(file, agentId, id, role, configured(role), since);
  });
  return [claudeAgent(main, id, null, "main", undefined, since), ...subs];
}

/**
 * Gemini CLI: one JSONL transcript per session (the hook gives its path). A message is written again each time it
 * changes, so only the last copy of each id counts. "gemini" messages carry model and tokens
 * {input, output, cached, thoughts, tool, total}. Gemini's input already includes the cached part.
 */
function gemini({ since, session, transcriptPath }) {
  if (!transcriptPath) return [];
  const rows = lines(transcriptPath);
  const byId = new Map();
  for (const r of rows) if (r?.type === "gemini" && r.id) byId.set(r.id, r);
  const inWindow = [...byId.values()].filter((r) => !(timeOf(r) < since));
  if (!inWindow.length) return [];
  const tokens = { input: 0, cachedInput: 0, output: 0, reasoning: 0 };
  for (const { tokens: t } of inWindow) {
    if (!t) continue;
    tokens.input += (t.input ?? 0) + (t.tool ?? 0);
    tokens.cachedInput += t.cached ?? 0;
    tokens.output += t.output ?? 0;
    tokens.reasoning += t.thoughts ?? 0;
  }
  const times = inWindow.map(timeOf).filter(Number.isFinite);
  const start = times.length ? Math.min(...times) : since;
  const meta = rows.find((r) => r?.sessionId && r?.startTime) ?? {};
  return [{
    agentId: String(session ?? meta.sessionId ?? "gemini").slice(0, 100),
    parentAgentId: null,
    role: "main",
    model: String(inWindow.findLast((r) => r.model)?.model ?? "unknown").slice(0, 60),
    effort: "unknown",
    effortSource: "observed",
    tokens,
    wallSeconds: times.length ? Math.round((Math.max(...times) - start) / 1000) : 0,
    startedAt: iso(start),
  }];
}

/** Usage an agent's own plugin counted and sent (OpenCode), shaped like the rest. */
function reportedAgent(session, r) {
  const n = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  return {
    agentId: String(session ?? "session").slice(0, 100),
    parentAgentId: null,
    role: "main",
    model: String(r.model ?? "unknown").slice(0, 60),
    effort: "unknown",
    effortSource: "observed",
    tokens: { input: n(r.input), cachedInput: n(r.cachedInput), output: n(r.output), reasoning: n(r.reasoning) },
    wallSeconds: n(r.wallSeconds),
    startedAt: typeof r.startedAt === "string" ? r.startedAt : iso(Date.now()),
  };
}


/**
 * The board's usage.reported agents for one run: root first, the rest by startedAt, at most 50.
 * since: ms epoch or ISO string. runtime: "codex" | "claude". session: the thread/session id.
 * transcriptPath: the root transcript, used directly when given. configuredEffort: (role) => effort
 * for a Claude sub-agent that logged none.
 */
export function usage({
  since,
  runtime,
  session,
  transcriptPath,
  codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
  claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  configuredEffort,
  reported,
} = {}) {
  try {
    const from = typeof since === "number" ? since : Date.parse(since ?? "");
    if (!Number.isFinite(from)) return [];
    const opts = { since: from, session, transcriptPath, codexHome, claudeHome, configuredEffort };
    // Gemini CLI writes a JSONL transcript; OpenCode's plugin totals its own messages and sends them (reported).
    const agents = (runtime === "codex" ? codex(opts) : runtime === "claude" ? claude(opts) : runtime === "gemini" ? gemini(opts)
      : reported ? [reportedAgent(session, reported)] : []).filter(Boolean);
    const [head, ...rest] = agents;
    if (!head) return [];
    rest.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return [head, ...rest].slice(0, MAX_AGENTS);
  } catch {
    return [];
  }
}

/**
 * The runtime version a transcript was written by, from its first line only:
 * "codex <cli_version>" for a Codex rollout, "claude <version>" for a Claude transcript.
 */
export function runtimeVersionOf(transcriptPath) {
  const head = transcriptPath ? firstLine(transcriptPath) : null;
  if (!head) return undefined;
  return (versionOf("codex", head.payload?.cli_version).runtimeVersion ??
    versionOf("claude", head.version).runtimeVersion);
}
