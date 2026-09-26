// The outbox: one JSON file per event under state/outbox. A hook only writes here (fast, never waits on the
// network); flush() sends them in order. Bounded: at most MAX_FILES wait, the oldest are dropped past that,
// and an event that keeps failing is dropped after MAX_TRIES. eventId makes every resend safe.
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./config.mjs";

export const MAX_FILES = 500;
export const MAX_TRIES = 8;
const outbox = () => join(stateDir(), "outbox");
let seq = 0;

/** Adds events to the outbox. Names sort in the order they were written. */
export function enqueue(...events) {
  const dir = outbox();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const event of events) {
    const name = Date.now().toString().padStart(15, "0") + "-" + process.pid + "-" + String(seq++).padStart(4, "0") + ".json";
    const tmp = join(dir, "." + name);
    writeFileSync(tmp, JSON.stringify({ tries: 0, event }), { mode: 0o600 });
    renameSync(tmp, join(dir, name));
  }
  trim();
}

const names = () => {
  try {
    return readdirSync(outbox()).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort();
  } catch {
    return [];
  }
};

// ponytail: drops the oldest past MAX_FILES; a board down for days loses the oldest steps, never the newest.
function trim() {
  const all = names();
  for (const name of all.slice(0, Math.max(0, all.length - MAX_FILES))) drop(name);
}

function drop(name) {
  try {
    unlinkSync(join(outbox(), name));
  } catch {
    // Another flush got there first.
  }
}

export const pending = () => names().length;

/** The events waiting to be sent, oldest first, exactly as they will go (already scrubbed): pipexp preview reads them. */
export function queued() {
  const out = [];
  for (const name of names()) {
    try {
      out.push(JSON.parse(readFileSync(join(outbox(), name), "utf8")).event);
    } catch {}
  }
  return out;
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
 * Sends what waits, oldest first. send(event) resolves to "sent", "refused" (drop it: a 4xx will not change)
 * or "retry" (keep it, stop this flush). Returns counts.
 */
export async function flush(send) {
  const release = lock();
  if (!release) return { sent: 0, left: pending(), busy: true };
  let sent = 0;
  try {
    // Keeps going while events arrive: a hook that found this flush running left its events for it to send.
    let stop = false;
    for (let batch = names(); batch.length && !stop; batch = names()) for (const name of batch) {
      const path = join(outbox(), name);
      let item;
      try {
        item = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        drop(name);
        continue;
      }
      const result = await send(item.event);
      if (result === "sent" || result === "refused") {
        drop(name);
        if (result === "sent") sent++;
        continue;
      }
      item.tries = (item.tries ?? 0) + 1;
      if (item.tries >= MAX_TRIES) drop(name);
      else writeFileSync(path, JSON.stringify(item), { mode: 0o600 });
      stop = true;
      break;
    }
  } finally {
    release();
  }
  return { sent, left: pending(), busy: false };
}
