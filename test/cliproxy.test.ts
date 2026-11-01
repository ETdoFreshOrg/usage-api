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

test("CPA treats idle Claude windows (null after a reset) as 0% instead of failing", async () => {
  const { client } = setup([{ files: [file("claude", "one@example.com")] }, ok({
    five_hour: null, seven_day: { utilization: 41, resets_at: "2026-11-05T00:00:00Z" }, seven_day_omelette: null,
  }), ok({ account: { has_claude_max: true }, organization: { rate_limit_tier: "default_claude_max_20x" } })]);
  const [account] = await client.listAccounts();
  const data: any = await client.fetchUsage(account.id);
  assert.equal(data.five_hour.utilization, 0);
  assert.equal(data.five_hour.resets_at, null);
  assert.equal(data.seven_day.utilization, 41);
});

test("CPA still rejects a Claude body with no quota windows at all", async () => {
  const { client } = setup([{ files: [file("claude", "one@example.com")] }, ok({ error: { type: "x" } })]);
  const [account] = await client.listAccounts();
  await assert.rejects(client.fetchUsage(account.id), /missing quota windows/);
});
