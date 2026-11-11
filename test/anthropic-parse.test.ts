import assert from "node:assert/strict";
import test from "node:test";
import { classifyClaudeGrant, openFiveHour, parseClaudeResetCredits, parseClaudeUsage } from "../src/providers/anthropic.ts";

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
  assert.deepEqual(usage.five_hour, { utilization: 13, resets_at: "2026-07-12T21:20:00.114410+00:00" });
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

test("parseClaudeUsage reports the 5-hour window only for accounts that have one", () => {
  // Shapes from live CPA api-call responses on 2026-11-03.
  const withSession = parseClaudeUsage({ five_hour: { utilization: 6, resets_at: "2026-11-04T03:50:00Z" },
    seven_day: { utilization: 2, resets_at: "2026-11-05T13:00:00Z" } }, null);
  assert.deepEqual(withSession.five_hour, { utilization: 6, resets_at: "2026-11-04T03:50:00Z" });

  const none = parseClaudeUsage({ five_hour: null, seven_day: { utilization: 100, resets_at: "2026-11-06T02:00:00Z" },
    limits: [{ kind: "weekly_all", percent: 100, resets_at: "2026-11-06T02:00:00Z" }] }, null);
  assert.equal(none.five_hour, null);

  const fromLimits = parseClaudeUsage({ limits: [{ kind: "session", percent: 40, resets_at: "2026-11-04T03:50:00Z" },
    { kind: "weekly_all", percent: 9, resets_at: "2026-11-05T13:00:00Z" }] }, null);
  assert.deepEqual(fromLimits.five_hour, { utilization: 40, resets_at: "2026-11-04T03:50:00Z" });
});

test("openFiveHour drops a missing or already-reset 5-hour window instead of reading 0%", () => {
  const now = Date.parse("2026-11-03T23:00:00Z");
  assert.equal(openFiveHour(null, now), null);
  assert.equal(openFiveHour({ utilization: 99, resets_at: "2026-11-03T22:30:00Z" }, now), null);
  assert.deepEqual(openFiveHour({ utilization: 99, resets_at: "2026-11-03T23:30:00Z" }, now), { utilization: 99, resets_at: "2026-11-03T23:30:00Z" });
  assert.deepEqual(openFiveHour({ utilization: 5, resets_at: null }, now), { utilization: 5, resets_at: null });
});

test("parseClaudeResetCredits splits weekly and Fable resets by the limits each grant clears", () => {
  // Grant shapes from a live oauth/usage?cedar_ember=1 response on 2026-11-11.
  const full = { id: "full-reset-2611", label: "One full limit reset (November 2026)", type: "weekly", resets_left: 1,
    starts_at: "2026-11-10T21:30:00+00:00", ends_at: "2026-12-10T22:00:00+00:00",
    clears: ["seven_day", "seven_day_overage_included"], paused: false, usable_now: true };
  const free = { id: "free_reset_oct_2026", label: "Free limit reset", type: "weekly", resets_left: 1,
    ends_at: "2026-12-16T04:59:00+00:00", clears: ["seven_day", "seven_day_overage_included"], paused: false, usable_now: true };
  const fable = { id: "launch-2610-fable", label: "New model launch: one Fable reset for Max, Team Premium and Enterprise Premium",
    type: "full", resets_left: 1, starts_at: "2026-11-09T18:00:00+00:00", ends_at: "2027-03-09T07:59:00+00:00",
    clears: ["seven_day_overage_included"], paused: false, usable_now: false };
  const rc = parseClaudeResetCredits({ eligible: true, grants: [full, free, fable, { ...fable, id: "launch-2610-fable-6mo", resets_left: 0 }] });
  assert.equal(rc?.available_count, 3);
  assert.equal(rc?.weekly_available, 2);
  assert.equal(rc?.fable_available, 1);
  assert.equal(rc?.other_available, 0);
  assert.deepEqual(rc?.credits.map((c) => [c.grant_id, c.type, c.usable_now]),
    [["full-reset-2611", "weekly", true], ["free_reset_oct_2026", "weekly", true], ["launch-2610-fable", "fable", false]]);
  // The Fable label is not what decides it: a grant's `clears` list is.
  assert.equal(classifyClaudeGrant({ label: "Fable", clears: ["seven_day"] }), "weekly");
});

test("parseClaudeResetCredits keeps grants of an unknown kind apart and logs them once", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const grants = { eligible: true, grants: [
    { id: "mystery", label: "Something new", resets_left: 2, clears: ["seven_day_mystery"] },
    { id: "legacy", label: "One full limit reset", resets_left: 1 },
    { id: "spent", label: "gone", resets_left: 0, clears: ["nope"] },
  ] };
  const rc = parseClaudeResetCredits(grants);
  parseClaudeResetCredits(grants);
  assert.equal(rc?.available_count, 3);
  assert.equal(rc?.other_available, 3);
  assert.equal(rc?.weekly_available, 0);
  assert.equal(rc?.fable_available, 0);
  assert.equal(warn.mock.callCount(), 2);
});
