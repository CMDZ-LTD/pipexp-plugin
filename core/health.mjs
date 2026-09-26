// This machine's own health: is it connected, do its hooks run, is sending working. pipexp status, pipexp_status and
// the daily machine.audit all read it here. Codes, counts and versions only: nothing here ever carries a value.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { credentials, machine, osName, readJson, stateDir, VERSION, writeJson } from "./config.mjs";
import { disconnected } from "./connect.mjs";
import { enqueue, pending } from "./queue.mjs";

const DAY = 86_400_000;
const WORD = /^[0-9A-Za-z.+-]{1,40}$/;

/**
 * Codex runs a plugin's hooks only after a person trusts them in /hooks; it records that in config.toml.
 * True or false when Codex has pipexp installed, null otherwise (Claude Code and the rest have no trust step).
 */
// ponytail: any trusted pipexp entry counts, even one Codex wants reviewed again after hooks.json changes;
// hooks.json is kept byte-stable so that never happens. Compare hashes if it ever has to change.
export function hooksTrusted(codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")) {
  let text;
  try {
    text = readFileSync(join(codexHome, "config.toml"), "utf8");
  } catch {
    return null;
  }
  if (!/^\[plugins\."pipexp@[^"]+"\]\s*\n\s*enabled\s*=\s*true/m.test(text)) return null;
  return /^\[hooks\.state\."pipexp@[^"]+"\]\s*\n\s*trusted_hash\s*=/m.test(text);
}

/** What the last flush left: { at, left, sentAt }. bin/flush.mjs writes it. */
export const flushNote = () => readJson(join(stateDir(), "flush.json")) ?? {};

function refusedLately(now) {
  try {
    const last = readFileSync(join(stateDir(), "errors.log"), "utf8").trimEnd().split("\n").at(-1);
    return now - Date.parse(last.split("\t")[0]) < DAY;
  } catch {
    return false;
  }
}

export const FIX = {
  not_connected: "PipeXP is not connected, so sessions do not show on the board. Fix: pipexp connect",
  key_refused: "The board refused this machine's key. Fix: pipexp connect",
  hooks_untrusted: "PipeXP's hooks are not trusted, so sessions do not show on the board. Fix: in Codex, open /hooks and trust PipeXP",
  board_unreachable: "Events are waiting: the board could not be reached. Fix: check the network, then run pipexp flush",
  event_refused: "The board refused an event in the last day (see state/errors.log). Fix: codex plugin marketplace upgrade pipexp",
};

/** The one thing to fix first, as { code, line }, or null when all is well. */
export function problem(now = Date.now()) {
  const code = !credentials()
    ? "not_connected"
    : disconnected()
      ? "key_refused"
      : hooksTrusted() === false
        ? "hooks_untrusted"
        : flushNote().left > 0 && pending() > 0
          ? "board_unreachable"
          : refusedLately(now)
            ? "event_refused"
            : null;
  return code && { code, line: FIX[code] };
}

/** The agents this machine ran lately, newest version of each, from the sessions the hooks saved. */
function harnesses() {
  const seen = new Map();
  try {
    for (const name of readdirSync(join(stateDir(), "sessions"))) {
      if (!name.endsWith(".json")) continue;
      const s = readJson(join(stateDir(), "sessions", name));
      if (!/^[a-z][a-z0-9-]{1,19}$/.test(s?.runtime ?? "") || (seen.get(s.runtime)?.at ?? -1) > (s.lastSeenAt ?? 0)) continue;
      const version = String(s.runtimeVersion ?? "").split(" ")[1];
      seen.set(s.runtime, { at: s.lastSeenAt ?? 0, version: WORD.test(version ?? "") ? version : null });
    }
  } catch {}
  return [...seen].slice(0, 10).map(([name, h]) => ({ name, version: h.version }));
}

/** The machine.audit the board's Machines tab reads. No setup rows: the board keeps the ones the setup check sent. */
export function audit(now = Date.now()) {
  const me = machine();
  return {
    type: "machine.audit",
    eventId: randomUUID(),
    occurredAt: new Date(now).toISOString(),
    machineId: me.id,
    name: me.name.slice(0, 80),
    os: osName().slice(0, 80),
    skills: [],
    rows: [],
    plugin: {
      version: VERSION,
      harnesses: harnesses(),
      hooksTrusted: hooksTrusted(),
      queued: pending(),
      lastError: problem(now)?.code ?? null,
      lastEventAt: flushNote().sentAt ?? null,
    },
  };
}

/** Queues the audit: always on connect (force), else at most once a day. True when it queued one. */
export function queueAudit(force = false, now = Date.now()) {
  const file = join(stateDir(), "audit.json");
  if (!credentials() || (!force && now - (readJson(file)?.at ?? 0) < DAY)) return false;
  try {
    writeJson(file, { at: now });
    enqueue(audit(now));
    return true;
  } catch {
    return false;
  }
}

/** Records how a flush went, for the audit's last event and for status. */
export function noteFlush(result, now = Date.now()) {
  if (result.busy) return;
  try {
    writeJson(join(stateDir(), "flush.json"), { at: now, left: result.left, sentAt: result.sent ? new Date(now).toISOString() : (flushNote().sentAt ?? null) });
  } catch {}
}

/** The untrusted-hooks line, at most once a day: a session whose hooks do not run has no other way to hear it. */
export function tellOnce(now = Date.now()) {
  if (hooksTrusted() !== false) return "";
  const file = join(stateDir(), "told.json");
  if (now - (readJson(file)?.at ?? 0) < DAY) return "";
  try {
    writeJson(file, { at: now });
  } catch {}
  return "PipeXP: " + FIX.hooks_untrusted + ".";
}
