// Redacts secrets, home folders, machine and customer identifiers from free text before it leaves the machine.
// Ported from the Nudj ship skill's emit.mjs (monorepo #4823), plus the board's key shapes (lib/questions.ts).
const TOKENS = [
  /eyJ[\w-]+\.[\w-]+\.[\w-]+/g,
  /\b[a-f0-9]{32,}\b/gi,
  // A long run is a key, unless it reads like a path or branch slug (words joined by / or -).
  [/\b[A-Za-z0-9_+/-]{40,}={0,2}/g, (m) => !/[/-]/.test(m) || (/[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m))],
  /\b(?:sk|pk|rk)_(?:live|test)_\w+|\bgh[pousr]_\w+|\bgithub_pat_\w+|\bxox[abprs]-[\w-]+|\blin_api_\w+|\bnudj_rk_[\w-]+|\bpxp_[\w-]+|\bAKIA\w{12,}|\bAIza[\w-]{20,}|\bsk-[\w-]{16,}/g,
  /-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g,
  /(:\/\/)[^\s/:@]+:[^\s/@]+@/g,
  /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  /\b([A-Z][A-Z0-9_]{2,}=)\S+/g,
  /\b(Bearer\s+)\S+/gi,
  /((?:password|secret|token|api[_-]?key|key)\s*[:=]\s*)\S+/gi,
  [/\/(?:Users|home)\/[^/\s]+\//g, () => true, "~/"],
  /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g,
  // IPv6, full or compressed ("2001:db8::1", "::1"): it holds a digit and never sits mid-word, so
  // "std::vector", "Abc::Def" and times such as 10:30:00 are kept.
  /(?<![\w:])(?=[0-9A-Fa-f:]*\d)(?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:)+:(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)?|::[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)(?![\w:])/g,
  // ".env.local" is a file, not a machine: a name right after a dot is skipped.
  /(?<![.\w-])[\w-]+\.(?:local|lan)\b/gi,
  /\b[\w-]+\.myshopify\.com\b/gi,
  /(?<![0-9a-f])[0-9a-f]{24}(?![0-9a-f])/g,
];

const one = (text, [re, isSecret = () => true, to]) =>
  text.replace(re, (match, keep) =>
    !isSecret(match) ? match : to !== undefined ? to : typeof keep === "string" ? keep + "[REDACTED]" : "[REDACTED]",
  );

export const scrub = (value) =>
  typeof value === "string" ? TOKENS.map((t) => (Array.isArray(t) ? t : [t])).reduce(one, value) : value;

// Free text the board stores, with its length limits. Redacted first, then cut, so a cut never leaves half a secret.
export const LIMITS = { theme: 60, what: 500, title: 200, branch: 200, owner: 80, question: 300 };

/** The event with every free-text field redacted and cut; empty text becomes null (the board refuses "" ). */
export function scrubEvent(event) {
  const out = { ...event };
  for (const [key, max] of Object.entries(LIMITS)) {
    if (!(key in out)) continue;
    const value = out[key];
    out[key] = typeof value === "string" && value.trim() ? scrub(value).slice(0, max) : null;
  }
  if (Array.isArray(out.reasons))
    out.reasons = out.reasons.filter((r) => typeof r === "string" && r.trim()).slice(0, 10).map((r) => scrub(r).slice(0, 200));
  return out;
}
