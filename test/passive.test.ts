import assert from "node:assert/strict";
import test from "node:test";
import { codexFeatureLimit, describesAccountLimits, mergePassive, parsePassiveClaude, parsePassiveCodex, readObservation } from "../src/passive.js";

const NOW = Date.parse("2026-11-03T19:40:00Z");

// Shapes copied from CPA 8.0.44's /v0/management/auth-files on 2026-11-03.
const claudeQuota = {
  observed_at: "2026-11-03T13:34:25.916274792-06:00",
  signals: {
    "Anthropic-Ratelimit-Unified-7d-Reset": "1793926800",
    "Anthropic-Ratelimit-Unified-7d-Status": "allowed",
    "Anthropic-Ratelimit-Unified-7d-Utilization": "0.59",
    "Anthropic-Ratelimit-Unified-5h-Utilization": "0.19",
  },
};
const promaxQuota = {
  observed_at: "2026-11-03T13:05:31.085214317-06:00",
  signals: {
    "X-Codex-Credits-Balance": "22602.5294768333", "X-Codex-Credits-Unlimited": "False",
    "X-Codex-Plan-Type": "promax",
    "X-Codex-Primary-Reset-At": "1794235136", "X-Codex-Primary-Used-Percent": "100", "X-Codex-Primary-Window-Minutes": "10080",
    "X-Codex-Secondary-Reset-After-Seconds": "0", "X-Codex-Secondary-Used-Percent": "0", "X-Codex-Secondary-Window-Minutes": "0",
  },
};
const plusQuota = (observed: string, primaryReset: number) => ({
  observed_at: observed,
  signals: {
    "X-Codex-Plan-Type": "plus", "X-Codex-Credits-Balance": "0",
    "X-Codex-Primary-Reset-At": String(primaryReset), "X-Codex-Primary-Used-Percent": "26", "X-Codex-Primary-Window-Minutes": "300",
    "X-Codex-Secondary-Reset-At": "1794235136", "X-Codex-Secondary-Used-Percent": "87", "X-Codex-Secondary-Window-Minutes": "10080",
  },
});

test("CPA quota block becomes an observation; empty or missing signals are ignored", () => {
  const o = readObservation(claudeQuota)!;
  assert.equal(o.observedAt, "2026-11-03T19:34:25.916Z");
  assert.equal(o.signals["anthropic-ratelimit-unified-7d-utilization"], "0.59");
  assert.equal(readObservation({ signals: {} }), null);
  assert.equal(readObservation(null), null);
});

test("Claude headers replace the weekly and 5-hour windows and keep active-only fields", () => {
  const active = { seven_day: { utilization: 55, resets_at: "x" }, seven_day_fable: { utilization: 3, resets_at: null },
    subscription_type: "Max 20x" };
  const merged = mergePassive("claude", active, "2026-11-03T19:00:00Z", readObservation(claudeQuota), NOW);
  assert.deepEqual(merged.seven_day, { utilization: 59, resets_at: "2026-11-06T01:00:00.000Z" });
  assert.deepEqual(merged.five_hour, { utilization: 19, resets_at: null });
  assert.equal(merged.seven_day_fable.utilization, 3);
  assert.equal(merged.subscription_type, "Max 20x");
});

test("Codex windows are classified by length: promax reports its weekly window as primary", () => {
  const p = parsePassiveCodex(readObservation(promaxQuota)!)!;
  assert.equal(p.five_hour, null);
  assert.equal(p.seven_day!.used_percent, 100);
  assert.equal(p.seven_day!.window_minutes, 10080);
  assert.equal(p.plan_type, "promax");
  assert.equal(p.credits_balance, "22602.5294768333");

  const plus = parsePassiveCodex(readObservation(plusQuota("2026-11-03T19:30:00Z", 1793745000))!)!;
  assert.equal(plus.five_hour!.used_percent, 26);
  assert.equal(plus.seven_day!.used_percent, 87);
});

test("Codex merge keeps Spark and reset credits from the active check and fills legacy aliases", () => {
  const active = { additional: [{ name: "spark" }], reset_credits: { available_count: 2 }, plan_type: "plus" };
  const merged = mergePassive("codex", active, null, readObservation(plusQuota("2026-11-03T19:30:00Z", 1793745000)), NOW);
  assert.equal(merged.primary.used_percent, 26);
  assert.equal(merged.secondary.used_percent, 87);
  assert.deepEqual(merged.additional, [{ name: "spark" }]);
  assert.equal(merged.reset_credits.available_count, 2);
});

test("passive data is not used when older than the active check or after its window reset", () => {
  const obs = readObservation(claudeQuota);
  assert.equal(mergePassive("claude", {}, "2026-11-03T19:35:00Z", obs, NOW), null);
  // The 5-hour window reset at 1793379667 (Oct 30), before NOW.
  const rolled = readObservation(plusQuota("2026-10-30T13:41:43Z", 1793379667));
  assert.equal(mergePassive("codex", {}, null, rolled, NOW), null);
});

test("headers that round down never show less than the older active check of the same window", () => {
  const obs = readObservation(claudeQuota);
  const sameWindow = mergePassive("claude", { seven_day: { utilization: 60, resets_at: "2026-11-06T01:00:00+00:00" } },
    "2026-11-03T19:00:00Z", obs, NOW);
  assert.equal(sameWindow.seven_day.utilization, 60);
  const lastWeek = mergePassive("claude", { seven_day: { utilization: 95, resets_at: "2026-10-30T01:00:00+00:00" } },
    "2026-11-03T19:00:00Z", obs, NOW);
  assert.equal(lastWeek.seven_day.utilization, 59);
});

// etdofreshai@gmail.com and etgarcia@uno.edu headers from CPA on 2026-11-03 (trimmed).
const claude5hQuota = { observed_at: "2026-11-03T16:38:24.562071781-06:00", signals: {
  "Anthropic-Ratelimit-Unified-5h-Reset": "1793748600", "Anthropic-Ratelimit-Unified-5h-Status": "allowed_warning",
  "Anthropic-Ratelimit-Unified-5h-Utilization": "0.99",
  "Anthropic-Ratelimit-Unified-7d-Reset": "1793926800", "Anthropic-Ratelimit-Unified-7d-Utilization": "0.73" } };
const claudeWeeklyOnlyQuota = { observed_at: "2026-11-03T10:52:17.362713179-06:00", signals: {
  "Anthropic-Ratelimit-Unified-7d-Reset": "1793930400", "Anthropic-Ratelimit-Unified-7d-Status": "rejected",
  "Anthropic-Ratelimit-Unified-7d-Utilization": "1.0" } };

test("Claude 5h headers become five_hour; accounts without them report null, not 0%", () => {
  const p = parsePassiveClaude(readObservation(claude5hQuota)!)!;
  assert.deepEqual(p.five_hour, { utilization: 99, resets_at: "2026-11-03T23:30:00.000Z" });
  assert.equal(p.seven_day.utilization, 73);
  const weeklyOnly = parsePassiveClaude(readObservation(claudeWeeklyOnlyQuota)!)!;
  assert.equal(weeklyOnly.five_hour, null);
  assert.equal(mergePassive("claude", { seven_day: { utilization: 99, resets_at: null } }, "2026-11-03T16:00:00Z",
    readObservation(claudeWeeklyOnlyQuota), Date.parse("2026-11-03T17:00:00Z")).five_hour, null);
});

test("Claude headers without a 5h window keep the active check's 5h window; headers that round down never lower it", () => {
  const now = Date.parse("2026-11-03T22:40:00Z");
  const active = { five_hour: { utilization: 100, resets_at: "2026-11-03T23:30:00.368Z" }, seven_day: { utilization: 73, resets_at: null } };
  const kept = mergePassive("claude", active, "2026-11-03T16:00:00Z", readObservation(claudeWeeklyOnlyQuota),
    Date.parse("2026-11-03T17:00:00Z"));
  assert.deepEqual(kept.five_hour, active.five_hour);
  const higher = mergePassive("claude", active, "2026-11-03T22:00:00Z", readObservation(claude5hQuota), now);
  assert.equal(higher.five_hour.utilization, 100);
});

// etdofresh@gmail.com (promax) from CPA on 2026-11-03 21:48 CST, after two gpt-image-2 requests: the
// headers describe the 24-hour image quota (active limit imagegen_premium), not the Codex limit.
const promaxImageQuota = { observed_at: "2026-11-03T21:48:28.305910945-06:00", signals: {
  "X-Codex-Active-Limit": "imagegen_premium", "X-Codex-Credits-Unlimited": "False",
  "X-Codex-Plan-Type": "promax", "X-Codex-Primary-Over-Secondary-Limit-Percent": "0",
  "X-Codex-Primary-Reset-After-Seconds": "86359", "X-Codex-Primary-Reset-At": "1793850421",
  "X-Codex-Primary-Used-Percent": "0", "X-Codex-Primary-Window-Minutes": "1440",
  "X-Codex-Secondary-Reset-After-Seconds": "0", "X-Codex-Secondary-Used-Percent": "0", "X-Codex-Secondary-Window-Minutes": "0" } };
// The usage endpoint at 04:44Z the same night: the account's Codex limit is the weekly one, used up.
const promaxActive = { plan_type: "promax", five_hour: null, one_day: null,
  seven_day: { used_percent: 100, resets_at: "2026-11-09T14:38:56.000Z", window_minutes: 10080 }, additional: [] };

test("image-request headers are not read as the account's Codex limit", () => {
  const o = readObservation(promaxImageQuota)!;
  assert.equal(codexFeatureLimit(o), "imagegen_premium");
  assert.equal(describesAccountLimits("codex", o), false);
  assert.equal(parsePassiveCodex(o), null);
  // Newer than the active check, but it must not replace the weekly window with the image quota.
  assert.equal(mergePassive("codex", promaxActive, "2026-11-03T20:00:00Z", o, Date.parse("2026-11-04T04:00:00Z")), null);

  const plus = readObservation({ ...plusQuota("2026-11-03T19:30:00Z", 1793745000) });
  plus!.signals["x-codex-active-limit"] = "premium";
  assert.equal(codexFeatureLimit(plus!), null);
  assert.equal(describesAccountLimits("codex", plus), true);
  assert.equal(parsePassiveCodex(plus!)!.seven_day!.used_percent, 87);
  assert.equal(describesAccountLimits("claude", readObservation(claudeQuota)), true);
});

test("a 24-hour window in the Codex limit's headers becomes one_day, and stops counting once it resets", () => {
  const day = { observed_at: "2026-11-04T04:00:00Z", signals: { ...promaxImageQuota.signals, "X-Codex-Active-Limit": "premium",
    "X-Codex-Primary-Used-Percent": "40" } };
  const p = parsePassiveCodex(readObservation(day)!)!;
  assert.deepEqual(p.one_day, { used_percent: 40, resets_at: "2026-11-05T03:47:01.000Z", window_minutes: 1440 });
  assert.equal(p.five_hour, null);
  assert.equal(p.seven_day, null);
  const merged = mergePassive("codex", promaxActive, "2026-11-03T20:00:00Z", readObservation(day), Date.parse("2026-11-04T04:30:00Z"));
  assert.equal(merged.one_day.used_percent, 40);
  assert.equal(merged.primary, null);
  assert.equal(merged.secondary, null);
  assert.equal(mergePassive("codex", promaxActive, "2026-11-03T20:00:00Z", readObservation(day),
    Date.parse("2026-11-05T03:48:00Z")), null);
});
