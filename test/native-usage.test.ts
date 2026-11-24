import assert from "node:assert/strict";
import test from "node:test";
import { callTool, type ToolContext } from "../src/mcp-tools.js";
import { antigravitySnapshotTarget, nativeUsageAt, parseAntigravityQuota, parseAntigravityScreenshot } from "../src/native-usage.js";
import { ManagerClient } from "../src/providers/local.js";

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

test("screenshot keeps both groups in one Pro subscription with unknown freshness and resets", () => {
  const snapshot = parseAntigravityScreenshot({
    source: "antigravity_screenshot", account: "antigravity-personal", plan: "Pro",
    observed_at: "2026-01-12T15:00:00Z",
    groups: { gemini_models: { five_hour: 12, weekly: 73 }, claude_gpt_models: { five_hour: 86, weekly: 94 } },
  });
  const entry = nativeUsageAt(snapshot).antigravity;
  assert.equal(entry.display_name, "Antigravity");
  assert.equal(entry.model_id, "gemini-4-neon-high");
  assert.equal(entry.quota, undefined);
  const subscription = entry.subscription;
  assert.ok(subscription);
  assert.equal(subscription.status, "unknown");
  assert.equal(subscription.observed_at, null);
  assert.deepEqual(subscription.groups.map(g => g.label), ["Gemini Models", "Claude and GPT Models"]);
  assert.deepEqual(subscription.groups.flatMap(g => g.windows.map(w =>
    [w.used_percent, w.remaining_percent, w.resets_at])), [[88, 12, null], [27, 73, null], [14, 86, null], [6, 94, null]]);
  assert.ok(subscription.groups.every(g => g.windows.every(w => w.expired === null)));
});

test("one selected Antigravity account reuses the stored-window query and exposes only safe quota", async () => {
  const calls: string[] = [];
  const target = antigravitySnapshotTarget("private-contact@example.test.json", "private-index");
  assert.ok(target);
  assert.equal(antigravitySnapshotTarget(target.fileName!, undefined), null);
  const reset = observed + 5 * 60 * 60_000;
  const recent = { source: "api_query", observed_at_ms: observed - 60_000, availability: "active", remaining_percent: 62 };
  const manager = new ManagerClient("http://fixture", "fixture-key", async (input, req) => {
    const route = String(input).split("/").pop()!;
    calls.push(route);
    if (route === "auto-ping") {
      assert.equal(req?.method, "GET");
      return Response.json({ accounts: [] });
    }
    assert.equal(route, "query");
    assert.equal(req?.method, "POST");
    const body = JSON.parse(String(req?.body));
    assert.deepEqual(body.accounts, [{ row_key: "antigravity-personal", provider: "antigravity", account: {
      auth_file_snapshot: target.fileName, auth_index: "private-index",
      auth_provider_snapshot: "antigravity", source: target.fileName,
    } }]);
    return Response.json({ items: [{ row_key: "antigravity-personal", windows: [
      { ...recent, provider_window_id: "gemini-models:gemini-5h", window_kind: "five_hour",
        cycle_end_ms: reset, boundary_accuracy: "exact", plan_type: "must-not-be-invented" },
      { ...recent, provider_window_id: "gemini-models:gemini-5h", window_kind: "five_hour",
        observed_at_ms: observed - 120_000, remaining_percent: 90 },
      { ...recent, provider_window_id: "claude-and-gpt-models:3p-weekly", window_kind: "weekly",
        remaining_percent: 0, cycle_end_ms: reset, boundary_accuracy: "estimated" },
      { ...recent, provider_window_id: "gemini-models:gemini-weekly", window_kind: "weekly",
        cycle_end_ms: observed - 1, boundary_accuracy: "exact" },
      { ...recent, provider_window_id: "gemini-models:unfamiliar", window_kind: "weekly" },
      { ...recent, provider_window_id: "claude-and-gpt-models:3p-5h", window_kind: "five_hour",
        availability: "inactive" },
    ] }] });
  }, 10_000, () => observed);
  const state = await manager.state([target]);
  const windows = state.snapshots.get(target.id);
  assert.ok(windows);
  const native = nativeUsageAt(null, observed, windows);
  const subscription = native.antigravity.subscription;
  assert.equal(subscription?.source, "manager_snapshot");
  assert.equal(subscription.plan, null);
  assert.deepEqual(subscription.groups.map(g => [g.id, g.windows.map(w =>
    [w.period, w.remaining_percent, w.used_percent, w.resets_at, w.expired])]), [
    ["gemini_models", [["five_hour", 62, 38, new Date(reset).toISOString(), false],
      ["weekly", null, null, new Date(observed - 1).toISOString(), true]]],
    ["claude_gpt_models", [["weekly", 0, 100, null, false]]],
  ]);
  assert.doesNotMatch(JSON.stringify(native), /private-|example\.test|must-not-be-invented/);
  assert.deepEqual(calls.sort(), ["auto-ping", "query"]);
  assert.equal(nativeUsageAt(null, observed).antigravity.subscription, undefined);
});
