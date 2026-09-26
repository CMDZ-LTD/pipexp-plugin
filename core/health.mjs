// This machine's own health: is it connected, do its hooks run, is sending working. pipexp status, pipexp_status and
// the daily machine.audit all read it here. Codes, counts and versions only: nothing here ever carries a value.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { credentials, machine, osName, readJson, stateDir, underTest, VERSION, writeJson } from "./config.mjs";
import { disconnected } from "./connect.mjs";
import { enqueue, pending } from "./queue.mjs";

const DAY = 86_400_000;
const HOUR = 3_600_000;
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

/** The last refusal in the past day, from state/errors.log (core/send.mjs logRefusal): { at, type, status, field }, or null. */
export function lastRefusal(now = Date.now()) {
  try {
    const [at, type, status, field] = readFileSync(join(stateDir(), "errors.log"), "utf8").trimEnd().split("\n").at(-1).split("\t");
    return now - Date.parse(at) < DAY ? { at, type, status: Number(status), field: field || null } : null;
  } catch {
    return null;
  }
}

// --- Is a newer plugin out? The newest v<x.y.z> tag, read at most once a day by the flusher, kept in state/latest.json.
const RELEASES = "https://api.github.com/repos/CMDZ-LTD/pipexp-plugin/tags?per_page=20";
const parts = (v) => String(v).replace(/^v/, "").split(".").map(Number);
/** a > b for x.y.z versions. */
export const newer = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};
/** The newest released version known on this machine, or null when it has not been read yet. */
export const latestKnown = () => readJson(join(stateDir(), "latest.json"))?.version ?? null;
/** True only when a released version is known and ahead of this one. */
export const behind = (latest = latestKnown()) => !!latest && newer(latest, VERSION);

/** Reads the newest release tag, once a day. Never throws; a failed read keeps what was known. Tests pass their own fetch. */
export async function checkLatest(now = Date.now(), get = fetch) {
  const file = join(stateDir(), "latest.json");
  if (underTest() && get === fetch) return latestKnown();
  if (now - (readJson(file)?.at ?? 0) < DAY) return latestKnown();
  try {
    const res = await get(RELEASES, { headers: { accept: "application/vnd.github+json", "user-agent": "pipexp-plugin" }, signal: AbortSignal.timeout(5000) });
    const tags = res.ok ? await res.json() : [];
    const version = tags.map((t) => t?.name).filter((n) => /^v\d+\.\d+\.\d+$/.test(n ?? "")).map((n) => n.slice(1)).sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0))[0] ?? null;
    writeJson(file, { at: now, version: version ?? latestKnown() });
  } catch {
    writeJson(file, { at: now, version: latestKnown() });
  }
  return latestKnown();
}

export const FIX = {
  not_connected: "PipeXP is not connected, so sessions do not show on the board. Fix: pipexp connect",
  key_refused: "The board refused this machine's key. Fix: pipexp connect",
  hooks_untrusted: "PipeXP's hooks are not trusted, so sessions do not show on the board. Fix: in Codex, open /hooks and trust PipeXP",
  board_unreachable: "Events are waiting: the board could not be reached. Fix: check the network, then run pipexp flush",
  // Filled in by problem() with what was refused and why (refusedLine).
  event_refused: "The board refused an event in the last day (see state/errors.log).",
};

/** What the board refused and why, and the fix: an upgrade only when a newer plugin is out, else report it. */
export function refusedLine(r, latest = latestKnown()) {
  const what = "The board refused a " + r.type + " event (" + r.status + (r.field ? ", field " + r.field : "") + ") at " + r.at.slice(11, 16) + " UTC.";
  return behind(latest)
    ? what + " Fix: a newer plugin is out (" + latest + "): codex plugin marketplace upgrade pipexp"
    : what + " This plugin (" + VERSION + ") is the newest, so an upgrade will not fix it: tell whoever runs the board, with that line.";
}

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
          : lastRefusal(now)
            ? "event_refused"
            : null;
  return code && { code, line: code === "event_refused" ? refusedLine(lastRefusal(now)) : FIX[code] };
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

/**
 * Queues the audit: always on connect (force), else once a day after the board took one. A refused audit (a board that
 * did not know the plugin block yet, CMD-370) is tried again an hour later, not a day. True when it queued one.
 */
export function queueAudit(force = false, now = Date.now()) {
  const file = join(stateDir(), "audit.json");
  const last = readJson(file) ?? {};
  const wait = last.stored === false ? HOUR : DAY;
  if (!credentials() || (!force && now - (last.at ?? 0) < wait)) return false;
  try {
    writeJson(file, { at: now, stored: null });
    enqueue(audit(now));
    return true;
  } catch {
    return false;
  }
}

/** What the board said to the last audit: true stored, false refused. The next audit waits a day only after a stored one. */
export function noteAudit(stored) {
  const file = join(stateDir(), "audit.json");
  try {
    writeJson(file, { ...(readJson(file) ?? {}), stored });
  } catch {}
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
