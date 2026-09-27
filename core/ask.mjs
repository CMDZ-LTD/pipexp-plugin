// Ask a person on the board and wait for the answer. The question shows in the board's "Needs me" list.
import { randomUUID } from "node:crypto";
import { credentials } from "./config.mjs";
import { call, unknownOrigin } from "./send.mjs";
import { contentFor, loadSession, report } from "./run.mjs";
import { scrub } from "./scrub.mjs";

const POLL_S = 20;
// The board's own rule (agent-pipeline lib/people.ts GITHUB_LOGIN): POST /questions refuses any other recipient.
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
// How long the board keeps a question open when none is given: a day when it waits on someone else, else an hour.
const DAY_MIN = 24 * 60;

/** The board page with this question open on its own: tap an option there to answer. */
export const questionLink = (boardUrl, questionId) => (boardUrl || "https://pipexp.dev").replace(/\/+$/, "") + "/?question=" + encodeURIComponent(questionId);

/**
 * wait: "all" waits until answered or timed out (CLI); a number waits at most that many seconds and returns
 * { status: "waiting", questionId, link } so an MCP call can come back and wait again.
 * onAsked(link): called once the board has the question, before waiting, so the link can be shared at once.
 * recipient: the GitHub login the question waits on, when it is someone else (CMD-230): after 4 working hours unanswered,
 * the standup shows the asker Blocked. timeoutMin: left out, the board picks (an hour, or a day with a recipient).
 */
export async function ask({ sessionId, question, context, options, timeoutMin, recipient, questionId, wait = "all", onAsked }) {
  const creds = credentials();
  if (!creds) return { status: "failed", reason: "PipeXP is not connected (run pipexp connect)" };
  const to = recipient == null || recipient === "" ? null : String(recipient).trim().replace(/^@/, "");
  if (to !== null && !GITHUB_LOGIN.test(to)) return { status: "failed", reason: "recipient is a GitHub login (letters, numbers and dashes), like octocat" };
  let id = questionId;
  const link = () => questionLink(creds.boardUrl, id);
  let repo = loadSession(sessionId)?.repo ?? null;
  let origin = loadSession(sessionId)?.origin ?? null;
  let runId = loadSession(sessionId)?.runId ?? null;
  if (!id) {
    if (!question?.trim()) return { status: "failed", reason: "the question is empty" };
    let s = loadSession(sessionId);
    // The question hangs off this session's card, so the run must exist on the board first.
    if (!s?.started || s.finished) s = report(sessionId, { type: "run.started", fields: {} }).state;
    repo = s.repo ?? null;
    origin = s.origin ?? null;
    runId = s.runId;
    id = randomUUID();
    const body = {
      questionId: id,
      runId: s.runId,
      // The run's repo, as on its events, so the question lands in the run's project.
      ...(s.repo && { repo: s.repo }),
      ...(s.origin && { origin: s.origin }),
      ...(s.ticket && { ticket: s.ticket }),
      question: scrub(question).slice(0, 1000),
      ...(context && { context: scrub(context).slice(0, 2000) }),
      ...(options?.length && { options: options.slice(0, 6).map((o) => scrub(String(o)).slice(0, 120)) }),
      ...(timeoutMin != null && { timeoutMin: Math.min(DAY_MIN, Math.max(1, Math.round(timeoutMin))) }),
      // Minimal content names nobody (CMD-343), so the question goes without its recipient.
      ...(to && contentFor(s.cwd) !== "minimal" && { recipient: to }),
    };
    // The run.started above is queued; give the sender a moment so the card exists when the question lands.
    const { run } = await import("../bin/flush.mjs");
    await run().catch(() => {});
    let asked;
    try {
      asked = await call(creds, "/questions", { method: "POST", body: JSON.stringify(body) }, 10_000);
      // An older board does not know origin (CMD-374): ask again without it, and poll without it.
      if (body.origin && unknownOrigin(asked)) {
        delete body.origin;
        origin = null;
        asked = await call(creds, "/questions", { method: "POST", body: JSON.stringify(body) }, 10_000);
      }
    } catch (e) {
      return { status: "failed", reason: "board unreachable (" + (e.cause?.code ?? e.name) + ")" };
    }
    if (asked.status !== 201 && asked.status !== 200) return { status: "failed", reason: "the board refused the question (HTTP " + asked.status + ")" };
    onAsked?.(link());
  }
  // The CLI waits as long as the board keeps the question open; the board says expired when it closes.
  const until = wait === "all" ? Date.now() + (timeoutMin ?? (to ? DAY_MIN : 60)) * 60_000 + 30_000 : Date.now() + wait * 1000;
  let misses = 0;
  while (Date.now() < until) {
    const left = Math.max(1, Math.min(POLL_S, Math.floor((until - Date.now()) / 1000)));
    let got;
    try {
      // Found the way it was asked: by repo, or (CMD-374) by origin and run.
      const where = (repo ? "&repo=" + encodeURIComponent(repo) : "") + (origin ? "&origin=" + origin + (runId ? "&run=" + runId : "") : "");
      got = await call(creds, "/questions/" + id + "?wait=" + left + where, {}, (left + 10) * 1000);
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
