// The outbox: one JSON file per event under state/outbox. A hook only writes here (fast, never waits on the
// network); flush() sends them in order, eventId makes every resend safe. Kept by age, not count (CMD-95): a board
// or network down for days loses nothing younger than MAX_AGE_MS. Repeated heartbeats and usage snapshots merge as they
// are written, so a long outage stays small. Anything dropped is counted, and the next machine.audit reports it.
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, stateDir, writeJson } from "./config.mjs";

export const MAX_AGE_MS = 7 * 86_400_000;
// Disk, not time: a hard cap whatever the age. Merging keeps a normal week far below it.
export const MAX_FILES = 10_000;
// A server error counts one try an hour, so a board that errors for a day loses nothing, and one event it will never
// take (a board bug) waits about a day, not a week, before it is dropped and the rest go on.
export const MAX_TRIES = 24;
export const TRY_GAP_MS = 3_600_000;
// How far back a new heartbeat or usage snapshot looks for one it replaces.
const RECENT = 200;
const outbox = () => join(stateDir(), "outbox");
let seq = 0;

const read = (name) => {
  try {
    return JSON.parse(readFileSync(join(outbox(), name), "utf8"));
  } catch {
    return null;
  }
};
/** When a queued file was written (ms), from its name. */
const writtenAt = (name) => Number(name.slice(0, 15));

/** Adds events to the outbox. Names sort in the order they were written. */
export function enqueue(...events) {
  const dir = outbox();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const event of events) {
    merge(event);
    const name = Date.now().toString().padStart(15, "0") + "-" + process.pid + "-" + String(seq++).padStart(4, "0") + ".json";
    const tmp = join(dir, "." + name);
    writeFileSync(tmp, JSON.stringify({ tries: 0, event }), { mode: 0o600 });
    renameSync(tmp, join(dir, name));
  }
  trim();
}

/**
 * A heartbeat (_beat) replaces the run's queued heartbeat for the same stage: the stage's entry stays, only the newest
 * "still here" is worth sending. A usage snapshot (_usage, filled in from the transcript when sent) replaces the run's
 * newest queued event when that is a snapshot for the same stage and attempt: both would send the same totals.
 */
function merge(event) {
  if (!event?.runId || (!event._beat && !event._usage)) return;
  const recent = names().slice(-RECENT);
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = read(recent[i])?.event;
    if (!e || e.runId !== event.runId) continue;
    if (event._beat) {
      if (e._beat && e.stage === event.stage) drop(recent[i]);
      continue;
    }
    if (e._beat) continue;
    if (e._usage && e.stage === event.stage && e.attemptId === event.attemptId) drop(recent[i]);
    return;
  }
}

const names = () => {
  try {
    return readdirSync(outbox()).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort();
  } catch {
    return [];
  }
};

/** Drops what is older than MAX_AGE_MS, then the oldest past MAX_FILES, and counts both. */
function trim(now = Date.now()) {
  const all = names();
  let old = 0;
  while (old < all.length && now - writtenAt(all[old]) > MAX_AGE_MS) drop(all[old++]);
  const over = Math.max(0, all.length - old - MAX_FILES);
  for (const name of all.slice(old, old + over)) drop(name);
  if (old + over) noteDropped(old + over);
}

function drop(name) {
  try {
    unlinkSync(join(outbox(), name));
  } catch {
    // Another flush got there first.
  }
}

// --- Events dropped before the board took them: counted for the next machine.audit, never silent. ---
const droppedFile = () => join(stateDir(), "dropped.json");
export const droppedCount = () => readJson(droppedFile())?.count ?? 0;
function noteDropped(n) {
  try {
    writeJson(droppedFile(), { count: droppedCount() + n });
  } catch {}
}
/** The board stored an audit that reported n dropped: those are told. */
export function clearDropped(n) {
  if (!n) return;
  try {
    writeJson(droppedFile(), { count: Math.max(0, droppedCount() - n) });
  } catch {}
}

export const pending = () => names().length;

/** The events waiting to be sent, oldest first, exactly as they will go (already scrubbed): pipexp preview reads them. */
export function queued() {
  const out = [];
  for (const name of names()) {
    const item = read(name);
    if (item) out.push(item.event);
  }
  return out;
}

/** What waits, by event type: how many and the oldest (ms), plus the oldest overall. Types and ages only, no values. */
export function waiting(now = Date.now()) {
  const byType = new Map();
  let oldest = null;
  for (const name of names()) {
    const type = read(name)?.event?.type ?? "unreadable";
    const age = now - writtenAt(name);
    const t = byType.get(type) ?? { type, count: 0, oldestMs: 0 };
    t.count++;
    t.oldestMs = Math.max(t.oldestMs, age);
    byType.set(type, t);
    oldest = Math.max(oldest ?? 0, age);
  }
  return { total: [...byType.values()].reduce((n, t) => n + t.count, 0), oldestMs: oldest, byType: [...byType.values()].sort((a, b) => b.oldestMs - a.oldestMs) };
}

/** One flush at a time per machine: a lock file, taken over when older than a minute. */
function lock() {
  const path = join(stateDir(), "flush.lock");
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  try {
    closeSync(openSync(path, "wx"));
    return () => drop2(path);
  } catch {
    try {
      if (Date.now() - statSync(path).mtimeMs > 60_000) {
        unlinkSync(path);
        return lock();
      }
    } catch {
      // Gone in between: try once more.
      return null;
    }
    return null;
  }
}
const drop2 = (path) => {
  try {
    unlinkSync(path);
  } catch {}
};

/**
 * Sends what waits, oldest first. send(event) resolves to "sent", "refused" (drop it: a 4xx will not change),
 * "error" (the board answered with a server error: keep it, one try an hour) or "retry" (the board could not be
 * reached, or refused the key: keep it, no try used). Returns counts and why it stopped, if it did.
 */
export async function flush(send, now = () => Date.now()) {
  const release = lock();
  if (!release) return { sent: 0, left: pending(), busy: true };
  let sent = 0;
  let stopped = null;
  try {
    trim(now());
    // Keeps going while events arrive: a hook that found this flush running left its events for it to send.
    for (let batch = names(); batch.length && !stopped; batch = names()) for (const name of batch) {
      const path = join(outbox(), name);
      const item = read(name);
      if (!item) {
        drop(name);
        continue;
      }
      const result = await send(item.event);
      if (result === "sent" || result === "refused") {
        drop(name);
        if (result === "sent") sent++;
        continue;
      }
      stopped = result === "error" ? "error" : "retry";
      if (result === "error" && now() - (item.triedAt ?? 0) >= TRY_GAP_MS) {
        item.tries = (item.tries ?? 0) + 1;
        item.triedAt = now();
      }
      if (item.tries >= MAX_TRIES) {
        drop(name);
        noteDropped(1);
      } else writeFileSync(path, JSON.stringify(item), { mode: 0o600 });
      break;
    }
  } finally {
    release();
  }
  return { sent, left: pending(), busy: false, ...(stopped && { stopped }) };
}
