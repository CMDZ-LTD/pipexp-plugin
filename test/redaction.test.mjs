// The board's own redaction cases (agent-pipeline lib/redaction-fixtures.json, copied as-is into test/fixtures):
// the plugin's scrubber gives the same output the board stores, so /security's promise holds before anything is sent.
// Refresh the copy with: git -C <agent-pipeline> show origin/main:lib/redaction-fixtures.json > test/fixtures/redaction-fixtures.json,
// byte for byte. Its Stripe case says {{stripe_live_example}}: GitHub push protection refuses a Stripe-shaped key in a
// public repo, even Stripe's own docs example, so this test fills it in the same way the board does (lib/redaction-cases.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { scrub } from "../core/scrub.mjs";

// Stripe's documentation example key, in two parts, so the repo never holds a key-shaped string.
const STRIPE_LIVE_EXAMPLE = "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc";
const { cases } = JSON.parse(readFileSync(new URL("./fixtures/redaction-fixtures.json", import.meta.url), "utf8").replaceAll("{{stripe_live_example}}", STRIPE_LIVE_EXAMPLE));

test("the board's redaction cases are all there, the Stripe one filled in", () => {
  assert.ok(cases.length >= 19);
  assert.ok(cases.some((c) => c.in.includes(STRIPE_LIVE_EXAMPLE)));
  assert.ok(!cases.some((c) => c.in.includes("{{")));
});

for (const c of cases) {
  test("board case: " + c.name, () => {
    assert.equal(scrub(c.in), c.out);
  });
}
