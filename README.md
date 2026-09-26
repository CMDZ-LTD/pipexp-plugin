# PipeXP plugin

See every coding-agent session live on your [PipeXP](https://pipexp.dev) board: which stage it is in, how long
it has sat there, what it cost in tokens, what slowed it down, and questions it needs a person to answer.
Install it once per machine. Your own skills need no changes.

| Harness | Status |
|---|---|
| Codex | Works: hooks, skill, MCP server |
| Claude Code | Works: the same hooks file, skill and MCP server (`.claude-plugin/`) |
| Gemini CLI | Works: a Gemini extension (`gemini-extension.json`); tokens from its transcript |
| Cursor | Works: `pipexp install cursor` adds hooks to `~/.cursor/hooks.json`. Cursor keeps no token counts on the machine, so cards say "Tokens not reported" |
| OpenCode | Works: `pipexp install opencode` adds a small plugin; tokens from OpenCode's own messages |
| Qoder, Devin | Next |

## Install (Codex)

```bash
codex plugin marketplace add CMDZ-LTD/pipexp-plugin
codex plugin add pipexp@pipexp
```

Then open `/hooks` in Codex and trust PipeXP's hooks (Codex asks once; updates keep the same hook command,
so they do not ask again). Start a session: a browser tab opens at pipexp.dev/connect with a code. Check the
code, click **Connect**, and the session is on your board. Over SSH, run `pipexp connect` and open the link it prints.

## Install (Claude Code)

```text
/plugin marketplace add CMDZ-LTD/pipexp-plugin
/plugin install pipexp@pipexp
```

Or from a terminal: `claude plugin marketplace add CMDZ-LTD/pipexp-plugin` then `claude plugin install pipexp@pipexp`.
Start a session and approve the code, as for Codex. A machine connected once serves both: they share `~/.config/pipexp`.
Claude sessions show as `claude <version>` on the card. Failed tool calls come from Claude's `PostToolUseFailure` hook, and tokens from its
transcript, counted once per message, with sub-agents included.

## Install (Gemini CLI, Cursor, OpenCode)

```bash
gemini extensions install https://github.com/CMDZ-LTD/pipexp-plugin   # Gemini CLI
~/.config/pipexp/bin/pipexp install cursor                          # Cursor (IDE and cursor-agent)
~/.config/pipexp/bin/pipexp install opencode                        # OpenCode
```

`~/.config/pipexp/bin/pipexp` is written by the first Codex or Claude Code session with the plugin. Without either, run
`node <plugin checkout>/bin/pipexp.mjs install cursor`. The Cursor install merges: other tools' hooks stay, the old file is
kept as `hooks.json.before-pipexp`, and `pipexp uninstall cursor` takes only PipeXP's entries out.

## What it sends

One JSON event per change to `POST <board>/events` with `x-api-key`, in the board's event schema
(CMDZ-LTD/agent-pipeline `lib/event-schema.ts`):

| Hook | Event |
|---|---|
| SessionStart | `run.started` (title, branch, ticket from the branch, plugin and Codex version, machine id) |
| UserPromptSubmit | `step.entered agent:S1` Explore |
| PostToolUse | `step.entered` Build (edits), Test (test, lint, build commands), Pull request (`gh pr create`, `git push`); a heartbeat every 30 min; a snag after 3 failing test runs in a row |
| Stop | `usage.reported` for the turn, then `step.entered agent:S5` Waiting for you (never shown as stalled) |
| SessionEnd | `run.finished`: ready when the session ended after its turn (or opened a PR), abandoned when it was cut off mid-turn |

Skills with their own stages (ship, shepherd, fix-pr-comments, or yours) report them with the
`pipexp_report_stage` MCP tool or `~/.config/pipexp/bin/pipexp stage ship:S4 --ticket NJ-1234`. The board
defines lanes and stages (`GET /plugin/config`), not the plugin.

**Never sent:** prompts, code, file contents, command output. Free text (titles, snags, questions) is scrubbed
on this machine first: keys and tokens, env values, emails, home folders, machine names, IPv4 and IPv6 addresses,
store domains and database ids. `pipexp content minimal` also drops session titles and branch names.

**Never blocks:** a hook writes to a local outbox and exits in milliseconds; a detached process sends. Offline,
events wait (at most 500, each retried up to 8 times) and go out in order when the board is back. Each event keeps
its id, so a resend is never counted twice.

## Files

Everything lives in `~/.config/pipexp` (`PIPEXP_HOME` overrides it): `credentials.json` (the key, mode 600),
`machine.json`, `settings.json`, `state/` (sessions, outbox, errors log), `bin/pipexp` (a stable path to the CLI).
Key lookup order: `PIPEXP_URL` + `PIPEXP_KEY` env (CI), then `credentials.json`, then the older `~/.config/nudj/telemetry.env` (kept so machines set up before PipeXP had its own name keep reporting).

## Commands

```text
pipexp connect | status | disconnect | flush | allow restart | deny restart | content standard|minimal
pipexp stages [--raw]          this repo's lanes and stage ids, from the board (cached for offline)
pipexp stage <lane:S<n>> [--ticket ABC-12] [--counters '{...}'] [--replay]
pipexp event <type> --json '{...}'
pipexp ask "question" [--context ...] [--option A --option B] [--timeout-min 60]
```

### Contract for skills (a skill with its own stages calls these)

Call `~/.config/pipexp/bin/pipexp` detached and ignore its exit code. It exits 0 unless its arguments are wrong (2); `ask` exits 3 when
nobody answered. `--session` defaults to `CODEX_THREAD_ID` or `CLAUDE_CODE_SESSION_ID`, so a skill running inside a session never passes it.

| When | Command |
|---|---|
| Claim (step 1) | `pipexp stage ship:S1 --ticket NJ-1234 --claim new` (or `resume`, `takeover`) |
| Enter step N | `pipexp stage ship:SN [--counters '{"reviewRound":2}'] [--replay]` |
| Displaced owner on takeover | `pipexp event run.finished --session <old task id> --lane ship --ticket NJ-1234 --json '{"outcome":"abandoned"}'` |
| Run fields change (title, owner, tier, branch) | `pipexp event run.started --json '{"title":"...","owner":"...","tier":"standard"}'` |
| Snag, gate, review | `pipexp event snag.reported`, `gate.checked` or `review.done` with `--json '{...}'` (the board's fields) |
| Release | `pipexp event run.finished --json '{"outcome":"ready","prNumber":123,"stopReason":"green"}'` (usage for the last stage goes first) |
| Ask a person | `pipexp ask "..." [--option A --option B] [--timeout-min 60]` (prints the answer) |

Not installed: `[ -x ~/.config/pipexp/bin/pipexp ] || exit 0`. The path is written the first time a session starts with the plugin.

## Replaces a skill's own telemetry sender

A ship skill's own telemetry sender moves into this plugin. Ticked items are built and tested here.

- [x] Scrubbing: home paths, .local/.lan hosts, IPv4 and IPv6, myshopify.com, 24-hex ids, token shapes; redact before cut (`core/scrub.mjs`, `test/scrub.test.mjs`)
- [x] Test runs send only to localhost (`PIPEXP_TEST`, `NODE_TEST_CONTEXT`, `VITEST`, `PYTEST_CURRENT_TEST`)
- [x] Refused sends logged as type, status and field, never a value; after a 429 only run.finished (`test/queue.test.mjs`)
- [x] Bad JSON arguments get a fixed message, never the raw input (`bin/pipexp.mjs`)
- [x] run.started: skillVersion, skillTree (same hash as emit.mjs), machineId, parentRunId, claim, pluginVersion, runtimeVersion
- [x] step.entered: counters and replay; usage.reported for the stage being left; heartbeat every 30 min
- [x] run.finished: stopReason, question, link, postMerge, followUps, ownerTold pass through `pipexp event run.finished`
- [x] Usage per agent: activeSeconds, toolWaitSeconds (calls over 60 s), compactions, runtimeVersion, Codex sub-agent trees and Claude sub-agents (`core/usage.mjs`, #4823's fixtures)
- [x] gate.checked and review.done: `pipexp event gate.checked|review.done --json`, detached and fail-open
- [x] Ask a person on the board (`pipexp ask`, `pipexp_ask_human`), with no key prefix check
- [x] attemptId per claim (`--claim new|resume|takeover`) and finishing a displaced run as abandoned on takeover (`pipexp event run.finished --session <old task id> --lane ship`)
- [ ] Ship skill calls the plugin instead of its own scripts, and does nothing when the plugin is not installed (monorepo change)

## Develop

```bash
npm test            # node:test, no dependencies
npm run validate    # Codex plugin manifest check
```

To try local changes in Codex: `python3 ~/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py .`,
then `codex plugin add pipexp@personal` and start a new session. Never commit the `+codex.<stamp>` version it writes:
`test/version.test.mjs` fails on it.

Release: bump the version in `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`, `package.json`, `gemini-extension.json` and `VERSION` in
`core/config.mjs` (the test checks they match), push to main, and tag it (`git tag v0.1.10 && git push --tags`). In the same go, set
`LATEST_PLUGIN` in agent-pipeline `lib/machines.ts` to the new version, so machines behind it show "Update available". Installed copies
pick it up with `codex plugin marketplace upgrade pipexp`.
