#!/usr/bin/env node
// Sends the outbox. Started detached by every hook; also "pipexp flush". Fills in usage.reported from the
// transcript just before sending, so hooks never read big files. Silent: never prints, always exits 0.
import { credentials } from "../core/config.mjs";
import { checkLatest, noteAudit, noteFlush, queueAudit } from "../core/health.mjs";
import { clearDropped, flush } from "../core/queue.mjs";
import { post } from "../core/send.mjs";
import { usage } from "../core/usage.mjs";
import { hook, loadSession, sweepIdle } from "../core/run.mjs";
import { lookUpPr } from "../core/pr.mjs";
import { fetchSteers } from "../core/steer.mjs";
import { stagesFor } from "../core/stages.mjs";
import { carryOutRestarts } from "../core/run.mjs";

export async function sendOne(creds, event) {
  if (event.type === "machine.audit") {
    const result = await post(creds, event);
    if (result === "sent" || result === "refused") noteAudit(result === "sent");
    // The board has the count of events this machine dropped: they are told (CMD-95).
    if (result === "sent") clearDropped(event.plugin?.dropped);
    return result;
  }
  // Marks for the outbox only, never sent: _beat (a heartbeat it may merge), _usage (filled in below).
  const { _usage: u, _beat, ...rest } = event;
  if (!u) return post(creds, rest);
  const agents = usage({ since: u.since, runtime: u.runtime, session: u.session, transcriptPath: u.transcriptPath, reported: u.reported });
  // No usage to report (no transcript, nothing since the start): nothing to send.
  if (!agents.length) return "refused";
  return post(creds, { ...rest, agents });
}

export async function run() {
  const creds = credentials();
  if (!creds) return { sent: 0, left: 0 };
  // Once a day, the machine's own health rides along with whatever is sent.
  queueAudit();
  sweepIdle();
  const result = await flush((event) => sendOne(creds, event));
  noteFlush(result);
  // Once a day, whether a newer plugin is out, so status can say when an upgrade would help.
  await checkLatest();
  // A hook that found this session due a steer check named it here (CMD-80).
  const steerFor = process.env.PIPEXP_STEER_SESSION;
  if (steerFor) {
    // The steers just fetched, straight to the restart: never re-read from the inbox a hook may take in between.
    const fresh = await fetchSteers(creds, loadSession(steerFor)).catch(() => []);
    carryOutRestarts(steerFor, fresh);
  }
  // A hook found this session's PR due a lookup (CMD-427). A new number goes on the card through the session's own
  // state, as a PrFound hook; that queues the event and starts one more flush to send it.
  const prFor = process.env.PIPEXP_PR_SESSION;
  const s = prFor ? loadSession(prFor) : null;
  if (s) {
    const number = lookUpPr(s);
    if (number && number !== s.prNumber) hook({ session_id: prFor, cwd: s.cwd, hook_event_name: "PrFound" }, s.runtime);
  }
  // A session started where this machine's copy of the lanes is old or missing (CMD-421): read them again.
  if (process.env.PIPEXP_STAGES_CWD) await stagesFor(process.env.PIPEXP_STAGES_CWD).catch(() => null);
  return result;
}

if (import.meta.url === "file://" + process.argv[1]) run().catch(() => {});
