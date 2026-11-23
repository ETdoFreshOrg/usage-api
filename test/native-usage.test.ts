import assert from "node:assert/strict";
import test from "node:test";
import { callTool, type ToolContext } from "../src/mcp-tools.js";
import { nativeUsageAt, parseAntigravityQuota } from "../src/native-usage.js";

const observed = Date.parse("2026-01-12T15:00:00Z");
const fixture = {
  account: "antigravity-personal",
  model_id: "gemini-4-neon-high",
  group: "Gemini Models",
  observed_at: "2026-01-12T09:00:00-06:00",
  windows: {
    five_hour: { remaining_percent: 75.25, resets_at: "2026-01-12T18:00:00Z" },
    weekly: { remaining_percent: null, resets_at: "2026-01-15T15:00:00Z" },
  },
};

test("manual quota exposes reported windows with their source and capture time", () => {
  const snapshot = parseAntigravityQuota(fixture, observed);
  assert.ok(snapshot);
  const quota = nativeUsageAt(snapshot, observed).antigravity.quota;
  assert.deepEqual(quota, {
    source: "antigravity_manual", account: "antigravity-personal", group: "Gemini Models",
    observed_at: "2026-01-12T15:00:00.000Z", status: "fresh",
    windows: [
      { period: "five_hour", remaining_percent: 75.25, used_percent: 24.75, resets_at: "2026-01-12T18:00:00.000Z", expired: false },
      { period: "weekly", remaining_percent: null, used_percent: null, resets_at: "2026-01-15T15:00:00.000Z", expired: false },
    ],
  });
  assert.equal(nativeUsageAt(snapshot, observed + 30 * 60_000).antigravity.quota?.status, "stale");
  const expired = nativeUsageAt(snapshot, observed + 3 * 60 * 60_000).antigravity.quota;
  assert.deepEqual(expired?.windows[0], {
    period: "five_hour", remaining_percent: null, used_percent: null,
    resets_at: "2026-01-12T18:00:00.000Z", expired: true,
  });
});

test("missing, malformed, future and unrelated observations keep quota unavailable", () => {
  for (const value of [
    null, { ...fixture, model_id: "gemini-4-neon-xhigh" },
    { ...fixture, account: "person@example.test" }, { ...fixture, observed_at: "2099-01-01T00:00:00Z" },
    { ...fixture, windows: { five_hour: { remaining_percent: 101 } } },
  ]) {
    assert.equal(parseAntigravityQuota(value, observed), null);
  }
  assert.ok(!("quota" in nativeUsageAt(null, observed).antigravity));
  const zero = parseAntigravityQuota({ ...fixture, windows: { weekly: { remaining_percent: 0 } } }, observed);
  assert.equal(nativeUsageAt(zero, observed).antigravity.quota?.windows[0].used_percent, 100);
});

test("MCP exposes the same quota shape as REST without altering account rows", async () => {
  const snapshot = parseAntigravityQuota(fixture, observed);
  const context: ToolContext = {
    now: () => observed, getNativeUsage: now => nativeUsageAt(snapshot, now),
    getProviders: () => ({}), getProxyAccounts: () => null,
    getHistory: () => ({ series: [] }),
    getRecent: async () => null, getActivity: async () => null,
  };
  const result = (await callTool("list_accounts", {}, context)).structuredContent;
  assert.deepEqual(result.native_usage, nativeUsageAt(snapshot, observed));
  assert.deepEqual(result.accounts, []);
  const filtered = (await callTool("list_accounts", { provider: "codex" }, context)).structuredContent;
  assert.ok(!("native_usage" in filtered));
});
