---
name: pipexp
description: Report this coding session to the PipeXP board. Use when a skill or task has named stages or a ticket id, when something slows you down (a snag), when you need a person to decide something (ask on the board), when work is finished or blocked, or when the user asks to connect this machine to PipeXP or check its status.
---

# PipeXP

The PipeXP plugin reports activity from hooks: working during a turn, idle when the turn ends.
Activity is separate from the workflow stage and ticket completion. Use the tools below for what hooks cannot see.

## Tools

| Tool | When |
|---|---|
| `pipexp_stages` | Once, at the start of a session where you run a skill with stages: it lists this repo's lanes and stage ids as the board has them (each project sets its own). |
| `pipexp_report_stage` | A skill you are running has stages: report each one on entry, using an id `pipexp_stages` listed (e.g. ship:S4). Also when the work is for a ticket (pass `ticket`, e.g. ABC-123). You may pass `note`, your one-line summary (below). |
| `pipexp_report_status` | `working` with a `note`: your one-line summary (below). `paused`, `blocked` or `waiting` with a short reason; `idle` when no work is running. Pass the current ticket when it changes. A status report never marks the ticket done. Requires a board with activity reporting support; on an older board it says so and nothing is sent. |
| `pipexp_report_snag` | Something cost real time: a flaky test, a wrong doc, a missing tool. One or two sentences. |
| `pipexp_ask_human` | You need a decision only a person can make. It waits on the board. If you know it waits on someone other than the person you work for, pass their GitHub login as `recipient`. If it returns `waiting`, call it again with the `question_id`. If it fails, ask in the chat. |
| `pipexp_finish` | The work is done (`ready` with the PR number, `merged`), `blocked` on a person (say what in `question`), or `abandoned`. |
| `pipexp_status` | The user asks whether PipeXP is working, or where this session is on the board. Its `summary` is one line: what is wrong and the fix. Tell the user that line as it is. |

Always pass `cwd` (your working folder) so the report lands on this session's card.

## Say what you are working on

The board shows each agent's own one-line summary first. At the start of a task, and whenever your work really
changes (a new ticket, a new part of the job), report one short line you write yourself: `pipexp_report_status` with
state `working` and `note` (or `note` on `pipexp_report_stage`), with `ticket` when you know it, and `cwd`. From a
script: `pipexp activity working --note "..."` or `pipexp stage agent:S2 --note "..."`.

- Plain words for a person, at most 300 characters: "Adding the export button to Insights", not a file list.
- Never copy prompts, code, command output or your reasoning into it. The plugin scrubs secrets and drops the line
  on a project set to minimal content, but do not rely on that.
- The line stays while you do that work, and goes when a new turn starts or you report a new stage or status.
  Report it again when the work changes; do not repeat it on every step.

## Notes and stops from the board

A person can send you a note or stop you from your card. It arrives as context at your next step, starting
"Note from ... on the PipeXP board" or "Stopped from the PipeXP board by ...". Treat a note like a message from
the user. On a stop, call no more tools: end your turn, say in one line that you were stopped from the board and
why, and report `pipexp_finish` with outcome `blocked`.

## Stages come from the board

Each project sets its lanes and stages in PipeXP (Settings > Pipeline), and a repo can suggest its own in
`.pipexp/stages.json`. Do not assume a list: call `pipexp_stages` (or `pipexp stages` from a script) and report
only ids it gives. A stage marked "waits on a person" is where you hand over to a human. An id the board does not
list still lands, under Unmapped, so a new stage never loses a report; tell the user to add it in Settings > Pipeline.

If you hand out and follow other agents' work (a manager or lead session), report the `manager` lane's stages
(for example manager:S2), not an agent or ship stage. Your card then waits in Managers at each turn's end.

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
