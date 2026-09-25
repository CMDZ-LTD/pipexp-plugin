---
name: pipexp
description: Report this coding session to the PipeXP board. Use when a skill or task has named stages or a ticket id, when something slows you down (a snag), when you need a person to decide something (ask on the board), when work is finished or blocked, or when the user asks to connect this machine to PipeXP or check its status.
---

# PipeXP

The PipeXP plugin already reports every session by itself: it starts a card when you start, moves it
between Explore, Build, Test and Pull request from your tool calls, and marks it "Waiting for you" when
your turn ends. Do nothing for that. Use the tools below only to add what hooks cannot see.

## Tools

| Tool | When |
|---|---|
| `pipexp_report_stage` | A skill you are running has stages (ship:S0 to S11, shepherd:S1 to S6, fix-pr-comments:S1 to S8): report each one on entry. Also when the work is for a ticket (pass `ticket`, e.g. ABC-123). |
| `pipexp_report_snag` | Something cost real time: a flaky test, a wrong doc, a missing tool. One or two sentences. |
| `pipexp_ask_human` | You need a decision only a person can make. It waits on the board. If it returns `waiting`, call it again with the `question_id`. If it fails, ask in the chat. |
| `pipexp_finish` | The work is done (`ready` with the PR number, `merged`), `blocked` on a person (say what in `question`), or `abandoned`. |
| `pipexp_status` | The user asks whether PipeXP is connected, or where this session is on the board. |

Always pass `cwd` (your working folder) so the report lands on this session's card.

## Rules

- Never put secrets, keys, customer data or personal details in any text you send. The plugin scrubs
  what it can, but do not rely on it.
- Reporting never blocks your work. If a tool fails, carry on.
- From a script or skill, use the CLI instead: `~/.config/pipexp/bin/pipexp stage ship:S4 --ticket NJ-1234`,
  `pipexp event snag.reported --json '{...}'`, `pipexp ask "..."`. It exits 0 unless its arguments are wrong.

## Connect this machine

When the user asks to connect PipeXP (or `pipexp_status` says not connected), run:

```bash
node "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/bin/pipexp.mjs" connect
```

It opens pipexp.dev/connect with a code. The user checks the code and clicks Connect; the terminal says
"Connected". Over SSH it prints the link instead. Check with `pipexp status`; disconnect with `pipexp disconnect`.
For less detail on the board (no session titles or branch names), run `pipexp content minimal`.
