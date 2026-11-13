import assert from "node:assert/strict";
import test from "node:test";
import { CliProxyClient } from "../src/providers/cliproxy.js";
import { RateLimitError } from "../src/cache.js";

function setup(replies: any[], aliases = {}) {
  const calls: Array<{ url: string; body: any }> = [];
  const client = new CliProxyClient("http://proxy", "private-management-key", aliases, (async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    const reply = replies.shift();
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as typeof fetch);
  return { client, calls };
}
const file = (provider: string, email: string, disabled = false) => ({ provider, email, auth_index: email, disabled });
const ok = (body: any) => ({ status_code: 200, body: JSON.stringify(body) });

test("CPA discovery preserves migrated identities and ignores disabled/unrelated accounts", async () => {
  const { client } = setup([{ files: [file("codex", "one@example.com"), file("claude", "two@example.com"),
    file("codex", "disabled@example.com", true), file("antigravity", "other@example.com")] }],
    { "old-id": "codex:one@example.com" });
  const accounts = await client.listAccounts();
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].id, "old-id");
  assert.equal(accounts[1].id, "cpa:claude:two@example.com");
});

test("CPA discovery carries each account's routing priority, null when unset", async () => {
  const { client } = setup([{ files: [{ ...file("claude", "one@example.com"), priority: 10 },
    { ...file("codex", "two@example.com"), priority: "5" }, file("claude", "three@example.com")] }]);
  const accounts = await client.listAccounts();
  assert.deepEqual(accounts.map(a => a.priority), [10, 5, null]);
});

test("CPA fetches actual Codex windows through token substitution without exporting OAuth secrets", async () => {
  const { client, calls } = setup([{ files: [file("codex", "one@example.com")] }, ok({ plan_type: "pro",
    rate_limit: { primary_window: { used_percent: 47, limit_window_seconds: 604800, reset_at: 1800000000 } },
    credits: { balance: "123.45" }, rate_limit_reset_credits: { available_count: 0 } })]);
  const [account] = await client.listAccounts();
  const data: any = await client.fetchUsage(account.id);
  assert.equal(data.primary, null);
  assert.equal(data.secondary.used_percent, 47);
  assert.equal(data.credits_balance, "123.45");
  assert.equal(data.reset_credits.available_count, 0);
  assert.equal(data.source, "cliproxyapi");
  assert.equal(calls[1].body.header.Authorization, "Bearer $TOKEN$");
  assert.equal(calls[1].body.method, "GET");
  assert.ok(!JSON.stringify(data).includes("private-management-key"));
});

test("CPA reads Claude plans and genuine scoped Fable usage", async () => {
  const { client, calls } = setup([{ files: [file("claude", "one@example.com")] }, ok({
    five_hour: { utilization: 30 }, seven_day: { utilization: 50 },
    limits: [{ kind: "weekly_scoped", percent: 7, resets_at: "2026-10-25T00:00:00Z", scope: { model: { display_name: "Fable" } } }],
  }), ok({ account: { has_claude_max: true }, organization: { rate_limit_tier: "default_claude_max_20x" } })]);
  const [account] = await client.listAccounts();
  const data: any = await client.fetchUsage(account.id);
  assert.equal(data.subscription_type, "Max 20x");
  assert.equal(data.seven_day_fable.utilization, 7);
  assert.equal(data.seven_day.utilization, 50);
  assert.ok(calls.slice(1).every(c => c.body.method === "GET"));
});

test("CPA preserves provider Retry-After rather than fabricating fresh zero usage", async () => {
  const { client } = setup([{ files: [file("claude", "one@example.com")] },
    { status_code: 429, header: { "Retry-After": ["900"] }, body: "{}" }]);
  const [account] = await client.listAccounts();
  await assert.rejects(client.fetchUsage(account.id), (err: any) => err instanceof RateLimitError && err.retryAfterSec === 900);
});

test("optional reset-credit failures preserve successful Codex usage and expose unknown detail", async () => {
  const { client, calls } = setup([{ files: [file("codex", "one@example.com")] }, ok({
    rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000 } },
    rate_limit_reset_credits: { available_count: 2 } }), { status_code: 503, body: "{}" }]);
  const [account] = await client.listAccounts();
  const data: any = await client.fetchUsage(account.id);
  assert.equal(data.five_hour.used_percent, 5);
  assert.equal(data.reset_credits, null);
  assert.equal(data.reset_credits_checked_at, null);
  assert.ok(data.reset_credits_error);
  assert.ok(calls.every(c => c.body?.method !== "POST"));
});

test("CPA reports Claude's 5-hour window when the account has one and null when it does not", async () => {
  const { client } = setup([{ files: [file("claude", "one@example.com")] }, ok({
    five_hour: null, seven_day: { utilization: 41, resets_at: "2026-11-05T00:00:00Z" }, seven_day_omelette: null,
  }), ok({ account: { has_claude_max: true }, organization: { rate_limit_tier: "default_claude_max_20x" } }),
  ok({ five_hour: { utilization: 99, resets_at: "2026-11-03T23:30:00Z" }, seven_day: { utilization: 73, resets_at: "2026-11-06T01:00:00Z" } })]);
  const [account] = await client.listAccounts();
  const none: any = await client.fetchUsage(account.id);
  assert.equal(none.five_hour, null);
  assert.equal(none.seven_day.utilization, 41);
  // The plan label is cached, so the second check is a single upstream call.
  const session: any = await client.fetchUsage(account.id);
  assert.deepEqual(session.five_hour, { utilization: 99, resets_at: "2026-11-03T23:30:00Z" });
});

test("CPA keeps polling Claude when the weekly window is null or only in limits[]", async () => {
  const { client } = setup([{ files: [file("claude", "one@example.com")] },
    ok({ seven_day: null }), ok({}),
    ok({ limits: [{ kind: "weekly_all", percent: 12, resets_at: "2026-11-05T00:00:00Z" }] }), ok({})]);
  const [account] = await client.listAccounts();
  const idle: any = await client.fetchUsage(account.id);
  assert.equal(idle.seven_day.utilization, 0);
  const fromLimits: any = await client.fetchUsage(account.id);
  assert.equal(fromLimits.seven_day.utilization, 12);
  assert.equal(fromLimits.seven_day.resets_at, "2026-11-05T00:00:00Z");
});

test("CPA still rejects a Claude body with no quota windows at all", async () => {
  const { client } = setup([{ files: [file("claude", "one@example.com")] }, ok({ error: { type: "x" } })]);
  const [account] = await client.listAccounts();
  await assert.rejects(client.fetchUsage(account.id), /missing the weekly window/);
});

test("Codex reset-credit detail is re-read only when the count changes, and CPA's passive quota is carried", async () => {
  const usage = (count: number) => ok({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 1,
    limit_window_seconds: 604800, reset_at: 1800000000 } }, rate_limit_reset_credits: { available_count: count } });
  const detail = ok({ available_count: 2, credits: [] });
  const { client, calls } = setup([{ files: [{ ...file("codex", "one@example.com"),
    quota: { observed_at: "2026-11-03T19:00:00Z", signals: { "X-Codex-Primary-Used-Percent": "4" } } }] },
    usage(2), detail, ok({ accounts: {} }), usage(2), usage(3), ok({ available_count: 3, credits: [] })]);
  const [account] = await client.listAccounts();
  assert.equal(account.observation?.signals["x-codex-primary-used-percent"], "4");
  await client.fetchUsage(account.id);
  const cached: any = await client.fetchUsage(account.id);
  assert.equal(cached.reset_credits.available_count, 2);
  const changed: any = await client.fetchUsage(account.id);
  assert.equal(changed.reset_credits.available_count, 3);
  const detailCalls = calls.filter(c => c.body?.url?.includes("rate-limit-reset-credits")).length;
  assert.equal(detailCalls, 2);
});

const accountsCheck = (willRenew: boolean, expires = "2026-12-09T06:15:18+00:00") => ok({ accounts: {
  other: { entitlement: { has_active_subscription: true, expires_at: "2027-01-01T00:00:00+00:00" }, last_active_subscription: { will_renew: true } },
  "ws-1": { entitlement: { has_active_subscription: true, subscription_plan: "chatgptprolite", expires_at: expires,
    renews_at: "2026-12-09T00:15:18+00:00", cancels_at: null, billing_period: "monthly" },
  last_active_subscription: { will_renew: willRenew, cancellation_outcome: willRenew ? null : "deactivate" } } } });

test("CPA reads whether a Codex plan renews from accounts/check, for the account's own workspace, and caches it", async () => {
  const usage = ok({ rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 604800 } }, rate_limit_reset_credits: { available_count: 0 } });
  const { client, calls } = setup([{ files: [{ ...file("codex", "one@example.com"), id_token: { chatgpt_account_id: "ws-1" } }] },
    usage, accountsCheck(false), usage]);
  const [account] = await client.listAccounts();
  const data: any = await client.fetchUsage(account.id);
  assert.equal(calls[2].body.url, "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27");
  assert.equal(calls[2].body.method, "GET");
  assert.equal(calls[2].body.header["ChatGPT-Account-ID"], "ws-1");
  assert.deepEqual({ ...data.subscription, checked_at: "x" }, { source: "chatgpt", status: "active", will_renew: false,
    renews_at: "2026-12-09T00:15:18.000Z", expires_at: "2026-12-09T06:15:18.000Z", cancels_at: null, billing_period: "monthly", checked_at: "x" });
  const again: any = await client.fetchUsage(account.id);
  assert.equal(calls.length, 4, "subscription state is cached between usage checks");
  assert.equal(again.subscription.will_renew, false);
});

test("a failed Codex accounts/check leaves usage intact with subscription null", async () => {
  const { client } = setup([{ files: [file("codex", "one@example.com")] },
    ok({ rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 604800 } }, rate_limit_reset_credits: { available_count: 0 } }),
    { status_code: 403, body: "{}" }]);
  const [account] = await client.listAccounts();
  const data: any = await client.fetchUsage(account.id);
  assert.equal(data.seven_day.used_percent, 5);
  assert.equal(data.subscription, null);
});

test("CPA keeps Claude's subscription_status from the profile (Anthropic reports no end date)", async () => {
  const { client } = setup([{ files: [file("claude", "one@example.com")] }, ok({ seven_day: { utilization: 5 } }),
    ok({ account: { has_claude_max: true }, organization: { rate_limit_tier: "default_claude_max_20x", subscription_status: "active" } })]);
  const [account] = await client.listAccounts();
  const data: any = await client.fetchUsage(account.id);
  assert.equal(data.subscription.source, "anthropic");
  assert.equal(data.subscription.status, "active");
  assert.equal(data.subscription.expires_at, null);
});
