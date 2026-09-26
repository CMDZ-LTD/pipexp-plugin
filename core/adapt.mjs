// Each coding agent's hook payload, turned into the one shape core/session.mjs reads (Claude Code's, which Codex
// also uses): hook_event_name, session_id, cwd, transcript_path, tool_name, tool_input, tool_response.
// Codex and Claude Code need nothing. Sources: cursor.com/docs/hooks, gemini-cli docs/hooks/reference.md,
// and our own OpenCode plugin (opencode/pipexp.mjs), which already sends this shape.

export const RUNTIMES = ["codex", "claude", "cursor", "gemini", "opencode"];

const CURSOR_EVENTS = {
  sessionStart: "SessionStart",
  beforeSubmitPrompt: "UserPromptSubmit",
  postToolUse: "PostToolUse",
  postToolUseFailure: "PostToolUseFailure",
  stop: "Stop",
  sessionEnd: "SessionEnd",
};
const GEMINI_EVENTS = { SessionStart: "SessionStart", BeforeAgent: "UserPromptSubmit", AfterTool: "PostToolUse", AfterAgent: "Stop", SessionEnd: "SessionEnd" };

const parse = (v) => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

/** The payload in the shared shape, or null when this event means nothing to the board. */
export function adapt(runtime, input, env = process.env) {
  if (!input || typeof input !== "object") return null;
  if (runtime === "cursor") {
    const name = CURSOR_EVENTS[input.hook_event_name];
    if (!name) return null;
    return {
      ...input,
      hook_event_name: name,
      // conversation_id names the chat on every event; session_id is only on start and end (and equals it).
      session_id: input.conversation_id ?? input.session_id,
      cwd: input.cwd ?? input.workspace_roots?.[0] ?? env.CURSOR_PROJECT_DIR ?? null,
      transcript_path: input.transcript_path ?? env.CURSOR_TRANSCRIPT_PATH ?? null,
      tool_response: name === "PostToolUseFailure" ? input.error_message ?? input.failure_type ?? "failed" : parse(input.tool_output),
    };
  }
  if (runtime === "gemini") {
    const name = GEMINI_EVENTS[input.hook_event_name];
    if (!name) return null;
    // One AfterTool event for both: an error means the tool could not run; a shell's exit code is in its text.
    const failedToRun = name === "PostToolUse" && input.tool_response?.error;
    return {
      ...input,
      hook_event_name: failedToRun ? "PostToolUseFailure" : name,
      session_id: input.session_id ?? env.GEMINI_SESSION_ID,
      cwd: input.cwd ?? env.GEMINI_CWD ?? env.GEMINI_PROJECT_DIR ?? null,
      tool_response: input.tool_response?.llmContent ?? input.tool_response,
    };
  }
  return input;
}

/** What a SessionStart hook may print for each agent: Cursor's sessionStart takes additional_context only. */
export function noticeOutput(runtime, message) {
  if (!message) return "";
  if (runtime === "cursor") return JSON.stringify({ additional_context: message });
  return JSON.stringify({ systemMessage: message });
}
