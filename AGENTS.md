# PipeXP plugin

Reports coding-agent sessions to a PipeXP board (CMDZ-LTD/agent-pipeline, live at https://pipexp.dev).
Codex first, Claude Code next, then other harnesses. Derek (CMDZ CEO, dyslexic: short answers, tables) merges.

## Shape

- `core/` is shared by every harness: `session.mjs` (hook to event mapping, pure, the file to change when stages
  or events change), `scrub.mjs`, `queue.mjs` (outbox), `send.mjs`, `usage.mjs` (tokens from transcripts),
  `connect.mjs` (the only code that knows how a machine connects), `ask.mjs`, `run.mjs` (glue).
- `hooks/pipexp-hook.mjs` is the one command every hook runs. Keep `hooks/hooks.json` byte-stable: Codex asks people
  to re-trust hooks whose definition changes. Add behaviour in core, not new hook commands.
- Codex, Claude Code and Gemini CLI all load `hooks/hooks.json` and skip event names they do not have (checked live for
  Codex and Claude). Gemini's entries use its own names (BeforeAgent, AfterTool, AfterAgent), `${extensionPath}` and a timeout in
  milliseconds. Cursor (`~/.cursor/hooks.json`) and OpenCode (a JS plugin, `opencode/pipexp.mjs`) are set up by
  `pipexp install` (`core/install.mjs`). `core/adapt.mjs` turns each agent's payload into the Claude-shaped one core reads.
- Hooks run as separate processes that can overlap; `withSessionLock` in `core/run.mjs` keeps one per session at a time.
- Never add a `hooks` key to `.claude-plugin/plugin.json`: Claude loads it
  as well as the default file, and every event is sent twice. `runtimeOf()` in `core/run.mjs` tells the harnesses apart
  (PLUGIN_ROOT is Codex only; a CODEX_THREAD_ID leaks into a Claude started from a Codex terminal).
- `mcp/server.mjs` (stdio MCP, no SDK) and `bin/pipexp.mjs` (CLI) are thin over core.
- No npm dependencies. Node 18+. Hooks must never block or fail: write to the outbox, kick `bin/flush.mjs` detached, exit 0.

## The board contract

- Events: `POST <ingest>/events` with `x-api-key`; schema is agent-pipeline `lib/event-schema.ts` (strict: unknown
  fields are refused). `test/fixtures/board-contract.json` mirrors agent-pipeline `lib/plugin-contract.test.ts`; change both together.
- Lanes and stages come from `GET <ingest>/plugin/config`. The plugin's own lane is `agent` (S1 Explore to S5 Waiting for you).
- Connect: `POST /device/code` and `POST /device/token` (RFC 8628), page `pipexp.dev/connect` (agent-pipeline PR #69).
  Questions: `POST /questions`, `GET /questions/<id>?wait=20`.
- Ingest URL today is the Convex site (prod `exciting-ox-380`, set as `DEFAULT_URL` in `core/connect.mjs`).

## Test

- `npm test`. Tests run with a temp `PIPEXP_HOME` and a fake board on localhost; the sender refuses any other host under test.
- End to end against a dev board: set `PIPEXP_URL` and `PIPEXP_KEY` (read from `~/.config/pipexp/dev-credentials.json`,
  never print the key), pipe hook JSON into `node hooks/pipexp-hook.mjs`, then `node bin/flush.mjs`.
- Gotcha: real Codex transcripts are 5 to 25 MB. Hooks never read them; only the flusher does, and `usage.mjs` reads
  first lines to find sub-agents.
- Gotcha: the local `validate_plugin.py` rejects a `hooks` key in plugin.json, so hooks load from the default `hooks/hooks.json`.
  Hook commands use `${CLAUDE_PLUGIN_ROOT}` (Codex sets it too), so one hooks.json serves both harnesses.
- Gotcha: Codex starts the MCP server in the plugin's cache folder with a bare environment (no `PIPEXP_*`, no thread id,
  no PWD). So the tools need the agent's `cwd` to find the session, and env overrides never reach them. To test against a
  dev board, write `credentials.json` with `PIPEXP_URL=<dev> pipexp connect --key-stdin`; env-only setups send MCP calls to
  whatever `credentials.json` or the legacy file says (prod).
- Gotcha: `codex exec` runs with approvals off, so MCP tools must not need approval: `.mcp.json` sets
  `default_tools_approval_mode: approve` and every tool carries honest MCP annotations (nothing destructive).
- A real session end to end: `codex exec --dangerously-bypass-hook-trust -C <folder> "..."` (the flag skips the
  /hooks trust step for that one run only).
