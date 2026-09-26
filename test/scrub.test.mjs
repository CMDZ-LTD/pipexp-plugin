import assert from "node:assert/strict";
import test from "node:test";
import { scrub, scrubEvent } from "../core/scrub.mjs";

test("secrets never leave the machine: keys, tokens, JWTs, env values, passwords, URLs with logins", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
  const cases = [
    ["aws AKIAABCDEFGHIJKLMNOP", "aws [REDACTED]"],
    ["auth Bearer abc.def.ghi", "auth Bearer [REDACTED]"],
    ["key ghp_" + "a".repeat(36), "key [REDACTED]"],
    ["pipexp nudj_rk_" + "Ab1-".repeat(10), "pipexp [REDACTED]"],
    ["env MONGODB_URI=mongodb+srv://u:p@x/y", "env MONGODB_URI=[REDACTED]"],
    ["db mongodb+srv://admin:hunter2@cluster0.example.net/app", "db mongodb+srv://[REDACTED]@cluster0.example.net/app"],
    ["pw password: hunter2", "pw password: [REDACTED]"],
    ["sent " + jwt, "sent [REDACTED]"],
    ["-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", "[REDACTED]"],
    ["mail derek@example.com", "mail [REDACTED]"],
  ];
  for (const [input, want] of cases) assert.equal(scrub(input), want, input);
});

test("home folders, machine names, IPs, store domains and Mongo ids are removed; code and files stay", () => {
  assert.equal(
    scrub("ran /Users/derek/x.ts on derek-mbp.local via 192.168.1.20 for snug.myshopify.com member 65f1a2b3c4d5e6f7a8b9c0d1; read .env.local"),
    "ran ~/x.ts on [REDACTED] via [REDACTED] for [REDACTED] member [REDACTED]; read .env.local",
  );
  assert.equal(scrub("/home/ci/repo/src"), "~/repo/src");
});

test("IPv6 is redacted, full or compressed; C++ scopes and clock times are kept", () => {
  assert.equal(
    scrub("db at 2001:db8::1 and 2001:0db8:85a3:0000:0000:8a2e:0370:7334, local ::1; std::vector at 10:30:00"),
    "db at [REDACTED] and [REDACTED], local [REDACTED]; std::vector at 10:30:00",
  );
});

test("branch names and paths are not mistaken for keys", () => {
  assert.equal(scrub("codex/nj-3236-report-plugin-sessions-to-the-board-live"), "codex/nj-3236-report-plugin-sessions-to-the-board-live");
});

test("free text is redacted before it is cut, so a cut never leaves half a secret; empty text becomes null", () => {
  const e = scrubEvent({ type: "snag.reported", what: "word ".repeat(99) + "ghp_" + "a".repeat(36), theme: "  ", title: "t" });
  assert.equal(e.what.length, 500);
  assert.ok(!e.what.includes("ghp_"));
  assert.equal(e.theme, null);
  const g = scrubEvent({ type: "gate.checked", reasons: ["", ...Array(12).fill("r ".repeat(150))] });
  assert.equal(g.reasons.length, 10);
  assert.ok(g.reasons.every((r) => r.length === 200));
});
