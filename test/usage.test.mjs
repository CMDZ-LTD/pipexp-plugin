import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runtimeVersionOf, usage } from "../core/usage.mjs";

const FIX = fileURLToPath(new URL("./fixtures", import.meta.url));
const codexHome = join(FIX, "codex");
const claudeHome = join(FIX, "claude");
const ROOT = "11111111-1111-4111-8111-111111111111";
const SUB = "22222222-2222-4222-8222-222222222222";
const NESTED = "33333333-3333-4333-8333-333333333333";
const CLAUDE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROOT_FILE = join(codexHome, "sessions", "2026", "09", "24", "rollout-2026-09-24T10-00-00-" + ROOT + ".jsonl");
const CLAUDE_FILE = join(claudeHome, "projects", "-fixture-repo", CLAUDE + ".jsonl");

// ship's models.json, standard and fast profiles, as configuredEffort functions.
const PROFILES = {
  standard: { security: "xhigh", tester: "high" },
  fast: { security: "high", tester: "medium" },
};
const configured = (profile) => (role) => PROFILES[profile][role];

const tokens = (input, cachedInput, output, reasoning) => ({ input, cachedInput, output, reasoning });

const CODEX_TREE = [
  {
    agentId: ROOT,
    parentAgentId: null,
    role: "main",
    model: "gpt-6-sol",
    effort: "xhigh",
    effortSource: "observed",
    // Cumulative total minus the total already spent before since.
    tokens: tokens(4900, 3950, 290, 115),
    wallSeconds: 120,
    startedAt: "2026-09-24T10:03:00.000Z",
    // One 90 s command is waiting; the gap before the person's message is idle; 20 s is working.
    // The compaction before since is not counted.
    activeSeconds: 20,
    toolWaitSeconds: 90,
    compactions: 1,
    runtimeVersion: "codex 0.155.0-alpha.16.3",
  },
  {
    agentId: SUB,
    parentAgentId: ROOT,
    role: "explorer",
    model: "claude-opus-5-5",
    effort: "medium",
    effortSource: "observed",
    tokens: tokens(800, 600, 90, 10),
    wallSeconds: 90,
    startedAt: "2026-09-24T10:01:00.000Z",
  },
  {
    agentId: NESTED,
    parentAgentId: SUB,
    role: "worker-with-a-role-name-well-past-forty-characters".slice(0, 40),
    model: "gpt-6-sol",
    effort: "low",
    effortSource: "observed",
    tokens: tokens(200, 0, 20, 5),
    wallSeconds: 10,
    startedAt: "2026-09-24T10:02:00.000Z",
  },
];

test("codex: the thread and its sub-agents at any depth, counted from since", () => {
  const since = "2026-09-24T10:00:45Z";
  assert.deepEqual(usage({ since, runtime: "codex", session: ROOT, codexHome }), CODEX_TREE);
  // since as ms epoch, and the root given directly by the hook's transcript path.
  assert.deepEqual(
    usage({ since: Date.parse(since), runtime: "codex", session: ROOT, transcriptPath: ROOT_FILE, codexHome }),
    CODEX_TREE
  );
});

test("codex: a thread nobody has touched since since, or an unknown one, reports nothing", () => {
  assert.deepEqual(usage({ since: "2026-09-24T10:00:45Z", runtime: "codex", session: "nope", codexHome }), []);
  assert.deepEqual(usage({ since: "not a date", runtime: "codex", session: ROOT, codexHome }), []);
  assert.deepEqual(usage({ since: 0, runtime: "codex", session: ROOT, codexHome: join(FIX, "missing") }), []);
});

test("claude: the session plus sub-agents, with sub-agent effort from configuredEffort", () => {
  const since = "2026-09-24T09:00:00Z";
  const agents = usage({ since, runtime: "claude", session: CLAUDE, claudeHome, configuredEffort: configured("standard") });
  assert.deepEqual(agents, [
    {
      agentId: CLAUDE,
      parentAgentId: null,
      role: "main",
      model: "claude-opus-5-5",
      effort: "high",
      effortSource: "observed",
      // A message logged twice under one id counts once; input includes cache reads and writes.
      tokens: tokens(3115, 3000, 80, 20),
      wallSeconds: 605,
      startedAt: "2026-09-24T09:00:00.000Z",
      // A tool result is logged as a user line: it ends a 120 s wait, not a person's turn.
      activeSeconds: 485,
      toolWaitSeconds: 120,
      compactions: 1,
      runtimeVersion: "claude 2.1.270",
    },
    {
      agentId: "a1",
      parentAgentId: CLAUDE,
      role: "security",
      model: "claude-opus-5-5",
      effort: "xhigh",
      effortSource: "configured",
      tokens: tokens(313, 300, 12, 0),
      wallSeconds: 60,
      startedAt: "2026-09-24T09:02:00.000Z",
      activeSeconds: 60,
      toolWaitSeconds: 0,
      compactions: 0,
    },
    {
      agentId: "a2",
      parentAgentId: CLAUDE,
      role: "tester",
      model: "claude-sonnet-5",
      effort: "high",
      effortSource: "configured",
      tokens: tokens(3, 0, 4, 0),
      wallSeconds: 0,
      startedAt: "2026-09-24T09:04:00.000Z",
    },
  ]);
  const fast = usage({ since, runtime: "claude", session: CLAUDE, claudeHome, configuredEffort: configured("fast") });
  assert.deepEqual(fast.map((a) => a.effort), ["high", "high", "medium"]);
  // No configuredEffort: a sub-agent that logged no effort is "unknown", still "configured".
  const bare = usage({ since, runtime: "claude", session: CLAUDE, claudeHome });
  assert.deepEqual(
    bare.map((a) => [a.effort, a.effortSource]),
    [["high", "observed"], ["unknown", "configured"], ["unknown", "configured"]]
  );
  // A configuredEffort that throws is treated as no answer.
  const throwing = () => {
    throw new Error("boom");
  };
  assert.equal(usage({ since, runtime: "claude", session: CLAUDE, claudeHome, configuredEffort: throwing }).length, 3);
});

test("claude: the session is found by id, the transcript path is used directly, an unknown id reports nothing", () => {
  const since = "2026-09-24T09:00:00Z";
  const byId = usage({ since, runtime: "claude", session: CLAUDE, claudeHome });
  assert.equal(byId[0].agentId, CLAUDE);
  assert.equal(byId.length, 3);
  // transcriptPath wins even when claudeHome points nowhere.
  const byPath = usage({ since, runtime: "claude", transcriptPath: CLAUDE_FILE, claudeHome: join(FIX, "missing") });
  assert.deepEqual(byPath, byId);
  assert.deepEqual(usage({ since, runtime: "claude", session: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", claudeHome }), []);
});

test("claude: a session id found in two projects is ambiguous and reports nothing", () => {
  const home = mkdtempSync(join(tmpdir(), "usage-claude-"));
  cpSync(join(claudeHome, "projects"), join(home, "projects"), { recursive: true });
  mkdirSync(join(home, "projects", "-other-checkout"), { recursive: true });
  cpSync(CLAUDE_FILE, join(home, "projects", "-other-checkout", CLAUDE + ".jsonl"));
  assert.deepEqual(usage({ since: "2026-09-24T09:00:00Z", runtime: "claude", session: CLAUDE, claudeHome: home }), []);
});

const row = (at, type, payload) => JSON.stringify({ timestamp: "2026-09-25T10:" + at + "Z", type, payload });

test("a wait that started before since counts from since; a reset is kept when there is no time to split", () => {
  const home = mkdtempSync(join(tmpdir(), "usage-codex-"));
  const day = join(home, "sessions", "2026", "09", "25");
  mkdirSync(day, { recursive: true });
  const T = "55555555-5555-4555-8555-555555555555";
  const file = join(day, "rollout-2026-09-25T10-00-00-" + T + ".jsonl");
  writeFileSync(file, [
    row("00:00.000", "session_meta", { id: T, parent_thread_id: null }),
    row("00:01.000", "turn_context", { model: "gpt-6-sol", effort: "high" }),
    // A 4-minute test run: started at 10:01, before since (10:03), ended at 10:05.
    row("01:00.000", "response_item", { type: "function_call", call_id: "w1" }),
    row("05:00.000", "response_item", { type: "function_call_output", call_id: "w1" }),
    row("05:30.000", "response_item", { type: "message", role: "assistant" }),
  ].join("\n"));
  const since = "2026-09-25T10:03:00Z";
  const [agent] = usage({ since, runtime: "codex", session: T, codexHome: home });
  // 120 s of the wait fall after since; the 30 s after it is working; nothing before since counts.
  assert.deepEqual([agent.toolWaitSeconds, agent.activeSeconds], [120, 30]);

  writeFileSync(file, [
    row("00:00.000", "session_meta", { id: T, parent_thread_id: null }),
    row("04:00.000", "compacted", { message: "redacted" }),
    row("04:10.000", "response_item", { type: "message", role: "assistant" }),
  ].join("\n"));
  const [thin] = usage({ since, runtime: "codex", session: T, codexHome: home });
  assert.equal(thin.compactions, 1);
  assert.equal("activeSeconds" in thin, false, "one line has no interval to time");
});

test("a malformed line is skipped, not fatal", () => {
  const home = mkdtempSync(join(tmpdir(), "usage-codex-"));
  const day = join(home, "sessions", "2026", "09", "25");
  mkdirSync(day, { recursive: true });
  const T = "66666666-6666-4666-8666-666666666666";
  writeFileSync(join(day, "rollout-2026-09-25T10-00-00-" + T + ".jsonl"), [
    row("00:00.000", "session_meta", { id: T, parent_thread_id: null, cli_version: "0.155.1" }),
    row("00:01.000", "turn_context", { model: "gpt-6-sol", effort: "high" }),
    '{"timestamp":"2026-09-25T10:00:02Z","type":"event_msg","payload":{"type":"token_co',
    "not json at all",
    "null",
    row("00:10.000", "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 70, output_tokens: 7 } } }),
  ].join("\n") + "\n");
  const agents = usage({ since: "2026-09-25T10:00:00Z", runtime: "codex", session: T, codexHome: home });
  assert.equal(agents.length, 1);
  assert.deepEqual(agents[0].tokens, tokens(70, 0, 7, 0));
  assert.equal(agents[0].wallSeconds, 10);
  assert.equal(agents[0].runtimeVersion, "codex 0.155.1");
});

test("codex: 50 unrelated rollouts and a 2 MB unrelated root do not change the tree", () => {
  const home = mkdtempSync(join(tmpdir(), "usage-codex-"));
  cpSync(join(codexHome, "sessions"), join(home, "sessions"), { recursive: true });
  const day = join(home, "sessions", "2026", "09", "24");
  const noise = (i) => "77777777-7777-4777-8777-" + String(i).padStart(12, "0");
  for (let i = 0; i < 50; i++) {
    // Each unrelated thread's parent is another unrelated thread (or none), never in our tree.
    const meta = { id: noise(i), parent_thread_id: i % 2 ? noise(i - 1) : null, agent_role: "noise" };
    writeFileSync(join(day, "rollout-2026-09-24T11-00-00-" + noise(i) + ".jsonl"), [
      JSON.stringify({ timestamp: "2026-09-24T11:00:00.000Z", type: "session_meta", payload: meta }),
      JSON.stringify({ timestamp: "2026-09-24T11:00:05.000Z", type: "turn_context", payload: { model: "x", effort: "low" } }),
    ].join("\n"));
  }
  // A big unrelated root: a ~25 KB session_meta line then 2 MB of lines that are never parsed.
  const BIG = "88888888-8888-4888-8888-888888888888";
  const meta = JSON.stringify({
    timestamp: "2026-09-24T11:00:00.000Z",
    type: "session_meta",
    payload: { id: BIG, parent_thread_id: null, base_instructions: { text: "x".repeat(25_000) }, cli_version: "0.155.1" },
  });
  const filler = JSON.stringify({ timestamp: "2026-09-24T11:00:01.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: "y".repeat(1000) } });
  const bigFile = join(day, "rollout-2026-09-24T11-00-00-" + BIG + ".jsonl");
  writeFileSync(bigFile, meta + "\n" + Array(2048).fill(filler).join("\n") + "\n");
  assert.ok(readFileSync(bigFile).length > 2_000_000);

  const since = "2026-09-24T10:00:45Z";
  assert.deepEqual(usage({ since, runtime: "codex", session: ROOT, codexHome: home }), CODEX_TREE);
  // A sub-agent whose parent is only nested under source.subagent is still found.
  const NESTED_META = "99999999-9999-4999-8999-999999999999";
  writeFileSync(join(day, "rollout-2026-09-24T10-04-00-" + NESTED_META + ".jsonl"), [
    JSON.stringify({
      timestamp: "2026-09-24T10:04:00.000Z",
      type: "session_meta",
      payload: { id: NESTED_META, source: { subagent: { thread_spawn: { parent_thread_id: ROOT, depth: 1 } } } },
    }),
    JSON.stringify({ timestamp: "2026-09-24T10:04:30.000Z", type: "turn_context", payload: { model: "gpt-6-sol", effort: "high" } }),
  ].join("\n"));
  const withNested = usage({ since, runtime: "codex", session: ROOT, codexHome: home });
  assert.deepEqual(withNested.map((a) => [a.agentId, a.parentAgentId, a.role]), [
    [ROOT, null, "main"],
    [SUB, ROOT, "explorer"],
    [NESTED, SUB, CODEX_TREE[2].role],
    [NESTED_META, ROOT, "subagent"],
  ]);
  assert.equal(runtimeVersionOf(bigFile), "codex 0.155.1");
});

test("runtimeVersionOf reads only the first line, and is undefined when it cannot tell", () => {
  assert.equal(runtimeVersionOf(ROOT_FILE), "codex 0.155.0-alpha.16.3");
  assert.equal(runtimeVersionOf(join(FIX, "missing.jsonl")), undefined);
  assert.equal(runtimeVersionOf(undefined), undefined);
  const dir = mkdtempSync(join(tmpdir(), "usage-version-"));
  const bad = join(dir, "bad.jsonl");
  writeFileSync(bad, "{not json\n");
  assert.equal(runtimeVersionOf(bad), undefined);
});

