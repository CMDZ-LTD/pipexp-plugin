#!/usr/bin/env node
// Sends the outbox. Started detached by every hook; also "pipexp flush". Fills in usage.reported from the
// transcript just before sending, so hooks never read big files. Silent: never prints, always exits 0.
import { credentials } from "../core/config.mjs";
import { flush } from "../core/queue.mjs";
import { post } from "../core/send.mjs";
import { usage } from "../core/usage.mjs";

export async function sendOne(creds, event) {
  if (!event._usage) return post(creds, event);
  const { _usage: u, ...rest } = event;
  const agents = usage({ since: u.since, runtime: u.runtime, session: u.session, transcriptPath: u.transcriptPath });
  // No usage to report (no transcript, nothing since the start): nothing to send.
  if (!agents.length) return "refused";
  return post(creds, { ...rest, agents });
}

export async function run() {
  const creds = credentials();
  if (!creds) return { sent: 0, left: 0 };
  return flush((event) => sendOne(creds, event));
}

if (import.meta.url === "file://" + process.argv[1]) run().catch(() => {});
