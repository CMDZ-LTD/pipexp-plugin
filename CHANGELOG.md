# Changelog

Every released version of the PipeXP plugin. Tags are `v<version>` on `main`.

## Unreleased

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
