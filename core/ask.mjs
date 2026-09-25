// Ask a person on the board and wait for the answer. The question shows in the board's "Needs me" list.
import { randomUUID } from "node:crypto";
import { credentials } from "./config.mjs";
import { call } from "./send.mjs";
import { loadSession, report } from "./run.mjs";
import { scrub } from "./scrub.mjs";

const POLL_S = 20;

/**
 * wait: "all" waits until answered or timed out (CLI); a number waits at most that many seconds and returns
 * { status: "waiting", questionId } so an MCP call can come back and wait again.
 */
export async function ask({ sessionId, question, context, options, timeoutMin = 60, questionId, wait = "all" }) {
  const creds = credentials();
  if (!creds) return { status: "failed", reason: "PipeXP is not connected (run pipexp connect)" };
  let id = questionId;
  if (!id) {
    if (!question?.trim()) return { status: "failed", reason: "the question is empty" };
    let s = loadSession(sessionId);
    // The question hangs off this session's card, so the run must exist on the board first.
    if (!s?.started || s.finished) s = report(sessionId, { type: "run.started", fields: {} }).state;
    id = randomUUID();
    const body = {
      questionId: id,
      runId: s.runId,
      ...(s.ticket && { ticket: s.ticket }),
      question: scrub(question).slice(0, 1000),
      ...(context && { context: scrub(context).slice(0, 2000) }),
      ...(options?.length && { options: options.slice(0, 6).map((o) => scrub(String(o)).slice(0, 120)) }),
      timeoutMin: Math.min(24 * 60, Math.max(1, Math.round(timeoutMin))),
    };
    // The run.started above is queued; give the sender a moment so the card exists when the question lands.
    const { run } = await import("../bin/flush.mjs");
    await run().catch(() => {});
    let asked;
    try {
      asked = await call(creds, "/questions", { method: "POST", body: JSON.stringify(body) }, 10_000);
    } catch (e) {
      return { status: "failed", reason: "board unreachable (" + (e.cause?.code ?? e.name) + ")" };
    }
    if (asked.status !== 201 && asked.status !== 200) return { status: "failed", reason: "the board refused the question (HTTP " + asked.status + ")" };
  }
  const until = wait === "all" ? Date.now() + timeoutMin * 60_000 + 30_000 : Date.now() + wait * 1000;
  let misses = 0;
  while (Date.now() < until) {
    const left = Math.max(1, Math.min(POLL_S, Math.floor((until - Date.now()) / 1000)));
    let got;
    try {
      got = await call(creds, "/questions/" + id + "?wait=" + left, {}, (left + 10) * 1000);
    } catch {
      got = null;
    }
    if (!got || got.status >= 500) {
      if (++misses >= 5) return { status: "failed", questionId: id, reason: "the board stopped answering" };
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    misses = 0;
    if (got.status !== 200) return { status: "failed", questionId: id, reason: "the board refused the poll (HTTP " + got.status + ")" };
    if (got.body?.status === "answered") return { status: "answered", questionId: id, answer: got.body.answer, answeredBy: got.body.answeredBy };
    if (got.body?.status === "expired") return { status: "expired", questionId: id, reason: "nobody answered in time" };
  }
  return wait === "all" ? { status: "expired", questionId: id, reason: "nobody answered in time" } : { status: "waiting", questionId: id };
}
