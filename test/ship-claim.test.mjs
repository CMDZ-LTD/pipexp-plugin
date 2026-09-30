// Which ship claim a session follows (core/probe.mjs shipClaim).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { shipClaim } from "../core/probe.mjs";

test("CMD-535: a session holding two claims follows the ticket whose state names its worktree", () => {
  const top = mkdtempSync(join(tmpdir(), "pipexp-wt-"));
  const common = mkdtempSync(join(tmpdir(), "pipexp-git-"));
  mkdirSync(join(top, ".claude", "skills", "ship", "scripts", "telemetry"), { recursive: true });
  writeFileSync(join(top, ".claude", "skills", "ship", "scripts", "telemetry", "emit.mjs"), "");
  const claim = (ticket, state) => {
    mkdirSync(join(common, "ship", ticket, "owner.lock"), { recursive: true });
    writeFileSync(join(common, "ship", ticket, "owner.lock", "owner.json"), JSON.stringify({ task: "s-1" }));
    writeFileSync(join(common, "ship", ticket, "state.json"), JSON.stringify(state));
  };
  const g = { top, common };
  // Claimed first, then left for NJ-3331: no worktree of its own.
  claim("NJ-3256", { status: "claimed" });
  assert.equal(shipClaim(top, "s-1", g), "NJ-3256", "one claim: that one");
  claim("NJ-3331", { status: "in_progress", worktree: top });
  assert.equal(shipClaim(top, "s-1", g), "NJ-3331");
  assert.equal(shipClaim(top, "s-2", g), null, "another session's claims are not this one's");
});
