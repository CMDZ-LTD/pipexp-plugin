#!/usr/bin/env node
// Sends the outbox. Started detached by every hook; also "pipexp flush". Fills in usage.reported from the
// transcript just before sending, so hooks never read big files. Silent: never prints, always exits 0.
import { credentials } from "../core/config.mjs";
import { checkLatest, noteAudit, noteFlush, queueAudit } from "../core/health.mjs";
import { flush } from "../core/queue.mjs";
import { post } from "../core/send.mjs";
import { usage } from "../core/usage.mjs";
import { loadSession, sweepIdle } from "../core/run.mjs";
import { fetchSteers } from "../core/steer.mjs";

export async function sendOne(creds, event) {
  if (event.type === "machine.audit") {
    const result = await post(creds, event);
    if (result !== "retry") noteAudit(result === "sent");
    return result;
  }
  if (!event._usage) return post(creds, event);
  const { _usage: u, ...rest } = event;
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
  if (steerFor) await fetchSteers(creds, loadSession(steerFor)).catch(() => 0);
  return result;
}

if (import.meta.url === "file://" + process.argv[1]) run().catch(() => {});
