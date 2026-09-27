// Ask a person on the board and wait for the answer. The question shows in the board's "Needs me" list.
import { randomUUID } from "node:crypto";
import { credentials } from "./config.mjs";
import { call } from "./send.mjs";
import { loadSession, report } from "./run.mjs";
import { scrub } from "./scrub.mjs";

const POLL_S = 20;

/** The board page with this question open on its own: tap an option there to answer. */
export const questionLink = (boardUrl, questionId) => (boardUrl || "https://pipexp.dev").replace(/\/+$/, "") + "/?question=" + encodeURIComponent(questionId);

/**
 * wait: "all" waits until answered or timed out (CLI); a number waits at most that many seconds and returns
 * { status: "waiting", questionId, link } so an MCP call can come back and wait again.
 * onAsked(link): called once the board has the question, before waiting, so the link can be shared at once.
 */
export async function ask({ sessionId, question, context, options, timeoutMin = 60, questionId, wait = "all", onAsked }) {
  const creds = credentials();
  if (!creds) return { status: "failed", reason: "PipeXP is not connected (run pipexp connect)" };
  let id = questionId;
  const link = () => questionLink(creds.boardUrl, id);
  let repo = loadSession(sessionId)?.repo ?? null;
  if (!id) {
    if (!question?.trim()) return { status: "failed", reason: "the question is empty" };
    let s = loadSession(sessionId);
    // The question hangs off this session's card, so the run must exist on the board first.
    if (!s?.started || s.finished) s = report(sessionId, { type: "run.started", fields: {} }).state;
    repo = s.repo ?? null;
    id = randomUUID();
    const body = {
      questionId: id,
      runId: s.runId,
      // The run's repo, as on its events, so the question lands in the run's project.
      ...(s.repo && { repo: s.repo }),
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
    onAsked?.(link());
  }
  const until = wait === "all" ? Date.now() + timeoutMin * 60_000 + 30_000 : Date.now() + wait * 1000;
  let misses = 0;
  while (Date.now() < until) {
    const left = Math.max(1, Math.min(POLL_S, Math.floor((until - Date.now()) / 1000)));
    let got;
    try {
      got = await call(creds, "/questions/" + id + "?wait=" + left + (repo ? "&repo=" + encodeURIComponent(repo) : ""), {}, (left + 10) * 1000);
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
    if (got.body?.status === "answered") return { status: "answered", questionId: id, answer: got.body.answer, answeredBy: got.body.answeredBy, link: link() };
    if (got.body?.status === "expired") return { status: "expired", questionId: id, reason: "nobody answered in time", link: link() };
  }
  return wait === "all" ? { status: "expired", questionId: id, reason: "nobody answered in time", link: link() } : { status: "waiting", questionId: id, link: link() };
}
