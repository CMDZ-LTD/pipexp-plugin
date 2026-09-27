#!/usr/bin/env bash
# CMD-56 proof: a clean machine goes from the two install commands to a card on the board, timed. Codex and PipeXP both
# live in a temp folder for the run, so your own setup is never touched; only the Codex sign-in (auth.json) is linked.
# Record it:  script -r clean-install.rec scripts/clean-install.sh     (macOS; replay with script -p clean-install.rec)
# Step 3 opens pipexp.dev/connect: a project member checks the code and clicks Connect.
# Afterwards, revoke the "Clean install proof" machine's key in Settings > Machines.
set -euo pipefail
T=$(mktemp -d)
# The temp folder holds the proof machine's key and a link to your Codex sign-in: it goes when the script ends, however it ends.
trap 'rm -rf "$T"' EXIT
start=$(date +%s)
say() { printf '\n[%3ss] %s\n' "$(( $(date +%s) - start ))" "$*"; }
export CODEX_HOME="$T/codex" PIPEXP_HOME="$T/pipexp" PIPEXP_MACHINE_NAME="${PIPEXP_MACHINE_NAME:-Clean install proof}"
mkdir -p "$CODEX_HOME" "$PIPEXP_HOME"
ln -s "${HOME}/.codex/auth.json" "$CODEX_HOME/auth.json"

say "1/4 codex plugin marketplace add CMDZ-LTD/pipexp-plugin"
codex plugin marketplace add CMDZ-LTD/pipexp-plugin
say "2/4 codex plugin add pipexp@pipexp"
codex plugin add pipexp@pipexp
cli=$(ls -d "$CODEX_HOME"/plugins/cache/pipexp/pipexp/*/bin/pipexp.mjs | tail -n 1)

say "3/4 connect this machine: approve it in the browser tab"
node "$cli" connect

mkdir -p "$T/repo" && cd "$T/repo" && git init -q
say "4/4 one Codex session"
# The bypass flag stands in for trusting the hooks once in Codex's /hooks, for this run only.
codex exec --dangerously-bypass-hook-trust --skip-git-repo-check -s read-only "Reply with the word READY only. Do not run any tools." 2>/dev/null | tail -n 1
node "$cli" flush >/dev/null
node "$cli" status
say "done"
