import assert from "node:assert/strict";
import test from "node:test";
import { parseClaudeResetCredits, parseClaudeUsage } from "../src/providers/anthropic.ts";

test("parseClaudeUsage reads model-scoped weekly limits (Fable) from limits[]", () => {
  const usage = parseClaudeUsage({
    five_hour: { utilization: 13, resets_at: "2026-07-12T21:20:00.114410+00:00" },
    seven_day: { utilization: 32, resets_at: "2026-07-14T14:00:00.114429+00:00" },
    // Legacy per-model fields now come back null on newer responses.
    seven_day_sonnet: null,
    seven_day_opus: null,
    seven_day_omelette: null,
    limits: [
      { kind: "session", group: "session", percent: 13, resets_at: "2026-07-12T21:20:00.114410+00:00", is_active: false },
      { kind: "weekly_all", group: "weekly", percent: 32, resets_at: "2026-07-14T14:00:00.114429+00:00", is_active: false },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 42,
        resets_at: "2026-07-14T14:00:00.114634+00:00",
        is_active: true,
        scope: { model: { display_name: "Fable" } },
      },
    ],
  }, "max");

  assert.deepEqual(usage.seven_day_fable, {
    utilization: 42,
    resets_at: "2026-07-14T14:00:00.114634+00:00",
  });
  assert.equal("five_hour" in usage, false);
  assert.equal(usage.seven_day.utilization, 32);
  assert.equal(usage.seven_day_sonnet, null);
  assert.equal(usage.subscription_type, "max");
});

test("parseClaudeUsage falls back to scoped limits when legacy per-model fields are null", () => {
  const usage = parseClaudeUsage({
    five_hour: { utilization: 1 },
    seven_day: { utilization: 2 },
    limits: [
      { kind: "weekly_scoped", group: "weekly", percent: 7, resets_at: "2026-07-14T00:00:00Z", scope: { model: { display_name: "Sonnet" } } },
      { kind: "weekly_scoped", group: "weekly", percent: 9, resets_at: "2026-07-14T00:00:00Z", scope: { model: { display_name: "Opus" } } },
    ],
  }, null);

  assert.equal(usage.seven_day_sonnet?.utilization, 7);
  assert.equal(usage.seven_day_opus?.utilization, 9);
  assert.equal(usage.seven_day_fable, null);
});

test("parseClaudeUsage keeps legacy per-model fields when present and ignores malformed limits", () => {
  const usage = parseClaudeUsage({
    five_hour: { utilization: 10, resets_at: "2026-06-20T19:49:59Z" },
    seven_day: { utilization: 36, resets_at: "2026-06-23T13:59:59Z" },
    seven_day_sonnet: { utilization: 1, resets_at: "2026-06-23T13:59:59Z" },
    seven_day_omelette: { utilization: 5, resets_at: "2026-06-23T13:59:59Z" },
    limits: [
      { kind: "weekly_scoped", group: "weekly", percent: 99, scope: { model: { display_name: "Sonnet" } } },
      { kind: "weekly_scoped", group: "weekly", scope: { model: { display_name: "Fable" } } }, // no percent
      { kind: "weekly_scoped", group: "weekly", percent: 50, scope: { model: {} } },           // no name
      { kind: "weekly_all", group: "weekly", percent: 36 },
    ],
  }, "max");

  // Legacy field wins over the scoped entry.
  assert.equal(usage.seven_day_sonnet?.utilization, 1);
  assert.equal(usage.seven_day_design?.utilization, 5);
  // Malformed scoped entries are ignored rather than throwing.
  assert.equal(usage.seven_day_fable, null);
});

test("parseClaudeResetCredits counts grants and ignores ineligible responses", () => {
  const rc = parseClaudeResetCredits({
    eligible: true,
    grants: [
      { label: "launch", resets_left: 1, starts_at: "2026-09-22T16:00:00+00:00", ends_at: "2026-10-22T16:00:00+00:00", paused: false },
      { label: "old", resets_left: 0, ends_at: "2026-09-30T00:00:00+00:00" },
      { label: "held", resets_left: 1, ends_at: "2026-09-25T00:00:00+00:00", paused: true },
    ],
  });
  assert.equal(rc?.available_count, 1);
  assert.equal(rc?.next_expires_at, "2026-10-22T16:00:00+00:00");
  assert.equal(rc?.credits.length, 2);
  assert.equal(parseClaudeResetCredits({ eligible: false, grants: [] }), null);
  assert.equal(parseClaudeResetCredits(undefined), null);
});
