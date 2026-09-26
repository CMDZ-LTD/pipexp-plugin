// One POST to the board. Never throws; answers what the outbox should do with the event.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir, underTest, writeJson } from "./config.mjs";

const LOCAL = ["localhost", "127.0.0.1"];

/** Refuses anything but https (localhost excepted), and anything but localhost under a test runner. */
export function checkUrl(url) {
  const { protocol, hostname } = new URL(url);
  if (protocol !== "https:" && !LOCAL.includes(hostname)) return "the board URL must be https";
  if (underTest() && !LOCAL.includes(hostname)) return "a test may only send to localhost";
  return null;
}

export async function call(creds, path, init = {}, timeoutMs = 5000) {
  const problem = checkUrl(creds.url);
  if (problem) throw new Error(problem);
  const res = await fetch(creds.url.replace(/\/+$/, "") + path, {
    ...init,
    headers: { "content-type": "application/json", "x-api-key": creds.key, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
    // The key is a custom header, so a redirect would carry it to another host.
    redirect: "error",
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

const cappedFile = () => join(stateDir(), "capped");
export const isCapped = (runId) => existsSync(cappedFile()) && readFileSync(cappedFile(), "utf8").split("\n").includes(runId);

/** One line per refused send: time, type, status and the first failing field. Never a value. Last 100 kept. */
function logRefusal(event, status, body) {
  try {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const file = join(stateDir(), "errors.log");
    const field = body?.details?.[0]?.path?.join?.(".") ?? "";
    appendFileSync(file, [new Date().toISOString(), event.type, status, field].join("\t") + "\n", { mode: 0o600 });
    const kept = readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (kept.length > 100) writeFileSync(file, kept.slice(-100).join("\n") + "\n");
  } catch {
    // A folder that cannot be written loses the note, never the event.
  }
}

/** "sent" | "refused" (drop it) | "retry" (keep it, stop for now). */
export async function post(creds, event) {
  if (event.runId && event.type !== "run.finished" && isCapped(event.runId)) return "refused";
  let res;
  try {
    res = await call(creds, "/events", { method: "POST", body: JSON.stringify(event) });
  } catch {
    return "retry";
  }
  if (res.status >= 200 && res.status < 300) {
    markConnected();
    return "sent";
  }
  if (res.status === 401) {
    // Revoked or wrong key: keep the events, stop sending, and say so at the next session start.
    try {
      writeJson(join(stateDir(), "disconnected.json"), { at: new Date().toISOString() });
    } catch {}
    return "retry";
  }
  if (res.status === 429 && event.runId) {
    // The run reached the board's event limit: from now on it sends only its run.finished.
    try {
      mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
      if (!isCapped(event.runId)) appendFileSync(cappedFile(), event.runId + "\n");
    } catch {}
  }
  if (res.status === 403 && event.repo && /No project for this repo/.test(res.body?.error ?? "")) {
    const { markRefused } = await import("./stages.mjs");
    markRefused(event.repo);
    const { repo: _repo, ...rest } = event;
    return post(creds, rest);
  }
  if (res.status >= 400 && res.status < 500) {
    logRefusal(event, res.status, res.body);
    return "refused";
  }
  return "retry";
}

function markConnected() {
  const file = join(stateDir(), "disconnected.json");
  try {
    if (existsSync(file)) writeFileSync(file, "null");
  } catch {}
}
