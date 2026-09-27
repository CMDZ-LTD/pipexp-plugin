# Changelog

Every released version of the PipeXP plugin. Tags are `v<version>` on `main`.

## 0.1.19 (2026-09-27)

- Agent activity (CMD-518, board #520). Working, Idle, Paused, Blocked and Waiting are reported apart from the workflow stage, only to a board that advertises agent-activity-v1. At most one activity beat every 4 minutes and 300 per run, so a run stays under the board's 2,000 events. A Codex turn with no prompt (a delegated turn) is Working at its first tool call; a finish still ends the turn idle; a board stop or an explicit blocked or paused status holds until a new turn. An agent-lane session that reports its own stage waits for you at each turn's end. A PR is unlinked only when the work changes. New tool pipexp_report_status (and pipexp activity from scripts) reports a status with a reason. A session whose work moves to another project's repository ends its run in the old project and reports on a new run in the new one, only after the board confirmed this machine may report there; otherwise nothing is moved or sent.

## 0.1.18 (2026-09-27)

- A snag always reaches the board (CMD-370). An agent could call pipexp_report_snag with a kind the board does not know ("flaky") or a note in place of what, and the board refused the whole snag. Now a known kind passes as it is, any other goes as snag with the agent's word kept in theme, and what falls back to the note, so nothing is lost. The same holds for pipexp event snag.reported.

## 0.1.17 (2026-09-27)

- Never lose a session on a flaky network (CMD-95). The outbox keeps events for 7 days instead of 500 events, and a board that answers with a server error costs one try an hour (up to 24), so a day-long outage loses nothing. While waiting, a stage's repeated heartbeats and a run's back-to-back usage snapshots merge, so the queue stays small. Anything dropped anyway is counted and reported in the next machine audit, and the Machines tab shows it (board #465). pipexp flush --verbose lists what waits by type and age, and why it stopped; pipexp status says how old the oldest is. Types and ages only, never values.

## 0.1.16 (2026-09-27)

- Sessions outside your project's repo stay off its board (CMD-374). Every event and question says where its session runs (`origin`: repo, or none for a folder with no GitHub remote). The board, since #442, no longer files such a session on your key's own project, so personal threads in other repos and scratch folders stop cluttering it. A repo with no project is no longer sent again without its repo, and its refusal is not reported as a fault. A board from before #442, which does not know origin, still gets every event and question: they go again without it.
- Managers have their own lane (CMD-374). A session that reports `manager:Sx` waits in Managers at each turn's end and after two quiet hours, picks up its stage again at the next prompt, and never lands in a builder's Explore or Test.
- A session learns its branch's PR, so its run links to the merge it produced, with no gh pr create needed (CMD-427). The detached flush asks gh (never a hook, at most every ten minutes, at once after a push, never for main), and the PR rides on the run's next step. A session that ended first sends its finish again with the PR. The board takes prNumber on step.entered since #441.
- Each run counts the messages a person sent and how many came mid-turn (CMD-428). Counts only: the words are never read, kept or sent. The board shows them as Steering in the run drawer since #441.

## 0.1.15 (2026-09-27)

- A question can name who it waits on: `pipexp_ask_human` takes `recipient` and `pipexp ask` takes `--recipient`, a GitHub login (a leading @ is dropped). The board keeps such a question open a day by default, and after 4 working hours unanswered its standup shows the asker Blocked, waiting on that person (CMD-230, board #406). A login the board would refuse is refused here, before anything is asked. Minimal content sends no recipient. Without a timeout, the board now picks how long a question stays open (an hour, as before, when it names nobody).

## 0.1.14 (2026-09-27)

- A session start says, once a day, when events are waiting on a board it can't reach or the board refused one, with the fix (CMD-88). Before, you found out only when a card was missing. Connecting and a refused key were already said.
- pipexp status names the newest release and how old that knowledge is. A release list read before this plugin was tagged is read again within the hour, so status no longer calls an old release the newest (CMD-370).
- A session that moves to a branch with no ticket (back on main, say) now drops its card's old ticket: run.started carries ticket: null, which the board accepts since #344. Only then: a session that never had a ticket sends none (CMD-452).
- A session is told its repo's own stages when it starts (CMD-421), so the agent reports them with pipexp_report_stage on any harness that takes session context: Codex, Claude Code, Cursor and Gemini CLI (not OpenCode yet). Only when the project has a lane besides agent. Read from the cached board answer, never the network; the flush refreshes it when a session starts and it is over an hour old, and a session that started first is told at its first prompt. Stage names and descriptions go in as single plain lines.
- Cursor: a note from the board on a prompt now lets the prompt go on (continue: true).

## 0.1.13 (2026-09-27)

- A new machine connects to https://api.pipexp.dev, PipeXP's own address, instead of the Convex one (CMD-56). Machines already connected keep the address they have; both work.
- CI first runs `scripts/secret-scan.mjs`, the board's secret scan: it fails on a private key, GitHub token, PipeXP reporting key, Stripe or Resend live key, or a long random value named like a key, and prints file, line and rule, never the value. `git config core.hooksPath scripts/hooks` runs it before each commit (CMD-471).
- pipexp ask prints the question's own link (`Answer it here: <board>/?question=<id>`) as soon as the board has it, and pipexp_ask_human returns it while waiting, so a person nearby can answer in one tap (CMD-77).

## 0.1.12 (2026-09-26)

- Restart on another model from the board (CMD-80), off until this machine's owner runs `pipexp allow restart` (`pipexp deny restart` turns it off; `pipexp status` says which). Only the owner of this machine's key can ask. The run's turn ends, and a new run starts on the same ticket and a listed model, in the same folder and the same sandbox or permission mode (refused if that cannot be read), from a fixed prompt and an args list with no shell. It links back with parentRunId, and the old run's card logs it.

## 0.1.11 (2026-09-26)

- `pipexp preview` prints what this session sends next, exactly as it will go: scrubbed and at the content level (`--all` for every session, `--raw` for JSON). Nothing is sent (CMD-343).
- A project set to minimal on the board sends minimal from every machine: no titles, branches or creator for its repo's sessions. A machine can be stricter than its project, never looser (CMD-343).
- The scrubber passes the board's own redaction cases. It now redacts pipexp_rk_ keys, and keeps the @ in a URL with a password, as the board stores it (CMD-343).

## 0.1.10 (2026-09-26)

- Notes and stops sent from a card on the board reach the running session (CMD-80). A note arrives as context on the next tool call, or at the turn's end (the agent goes on with it). A stop ends the turn with who stopped it and why, and an agent-lane card moves to Waiting for you. Ship and other skill runs keep their stage.
- gemini-extension.json's version is checked with the rest.

## 0.1.8 (2026-09-26)

- The Machines tab catches up at once when a fault clears: a fresh audit goes when hook trust changes or a fault the last audit showed has gone, checked at every session start and flush, not once a day (CMD-370).

## 0.1.7 (2026-09-26)

- A finish stays on the board: after pipexp_finish, the rest of that turn's tool calls and its end no longer reopen the card (a finish was undone 144 ms later). The next prompt starts it again.
- pipexp_finish takes prNumber and pr as well as pr_number, refuses any other field with what to use ("unknown field status; use outcome"), and answers with what it recorded: "Marked ready, PR #355" or "Marked ready, no PR".
- The pipexp shim runs the newest installed version, so an upgrade that deletes the old folder no longer breaks scripts that call it.
- A new Mac is named after its Computer Name, with the hostname when they differ; PIPEXP_MACHINE_NAME and a name set in machine.json win.

## 0.1.6 (2026-09-26)

- Status says which event the board refused and its 400 reason, and suggests an upgrade only when a newer release is out (CMD-370).
- Tools find the session from a git worktree the session did not start in: by the Codex thread id, else by the one session in another worktree of the same repo; the error names the folder it looked in (CMD-370).
- Includes everything in 0.1.5, which was merged but never tagged.

## 0.1.5 (2026-09-26, not tagged)

- Cards say who started them: the machine's GitHub login, read from gh's config (never the network). Minimal content names nobody.
- A card's ticket, branch and PR follow the branch the session is on now, checked at each prompt and after git switch or checkout. A ticket the agent reported stays until a branch names another.
- Events name their repo from the git remote at once, so they land in that repo's project. A repo the board refuses is sent again without it and remembered.
- A refused machine audit is sent again an hour later, not a day, so the Machines tab fills in.
- A Codex session no hook has heard from for two hours (a closed thread, an interrupted turn) moves to Waiting for you instead of showing Stalled.
- pipexp_finish refuses a missing outcome instead of queueing an event the board rejects.

## 0.1.4 (2026-09-26)

- `pipexp status` and `pipexp_status` lead with what is wrong and the fix: not connected, key refused, hooks not trusted in Codex, board unreachable, event refused.
- A `machine.audit` goes to the board on connect and once a day: plugin version, agent versions, hook trust, queue size and last error code.
- A session whose hooks are not trusted hears it once a day, on its first PipeXP tool reply.

## 0.1.3 (2026-09-26)

- Cursor sessions tell the board that tokens are not reported, so cards say "Tokens not reported" rather than showing zero.

## 0.1.2 (2026-09-26)

- Reads the repo's own lanes and stages from the board (`GET /plugin/config`) and tells agents about them through the skill.
- Names the repo on events once it is known.

## 0.1.1 (2026-09-26)

- One version everywhere, with a test that keeps the manifests and CLI in step; release steps in the README.
- Claude Code: the same hooks file, skill and MCP server as Codex, with runtime detection, transcript version and title, and failed tool calls.
- Cursor, Gemini CLI and OpenCode report through the plugin. Hooks of one session never race.
- Real-session fixes: the MCP server finds the session from the agent's folder, a failed send stays queued, a flush drains events that arrive mid-flush, usage is read from the transcript's start, and claims carry an attempt id.
- A session handed back after its turn finishes as ready. A takeover finishes the displaced run. No second card while a ship skill's own scripts hold the claim.

## 0.1.0 (2026-09-25)

- First release for Codex: hooks, skill, MCP server and `pipexp` CLI.
- Connect a machine with a code approved on the board (device flow).
- Offline outbox: events wait on disk and resend with their own ids, so nothing counts twice.
- Scrubbing of secrets, home folders, hosts, IPs and ids before anything leaves the machine.
- Token and time usage per agent, read from the runtime's own logs.
