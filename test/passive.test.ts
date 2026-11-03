import assert from "node:assert/strict";
import test from "node:test";
import { mergePassive, parsePassiveCodex, readObservation } from "../src/passive.js";

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

test("Claude headers replace only the weekly window and keep active-only fields", () => {
  const active = { seven_day: { utilization: 55, resets_at: "x" }, seven_day_fable: { utilization: 3, resets_at: null },
    subscription_type: "Max 20x" };
  const merged = mergePassive("claude", active, "2026-11-03T19:00:00Z", readObservation(claudeQuota), NOW);
  assert.deepEqual(merged.seven_day, { utilization: 59, resets_at: "2026-11-06T01:00:00.000Z" });
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
