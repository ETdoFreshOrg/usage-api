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

// clear_proxy_cooldown against a fake CPA management server (no live proxy is touched).
const KEY = "private-management-key";
function fakeCpa(files: any[], reset: (body: any) => { status: number; body: any } = (b) => ({ status: 200, body: { status: "ok", auth_index: b.auth_index, models: ["m1"] } })) {
  const calls: Array<{ method: string; url: string; auth: string | null; body: any }> = [];
  let state = files;
  const client = new CliProxyClient("http://proxy/", KEY, {}, (async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init?.method ?? "GET", url: String(url), auth: (init?.headers as any)?.Authorization ?? null, body });
    if (String(url).endsWith("/v0/management/auth-files")) return new Response(JSON.stringify({ files: state }), { status: 200 });
    if (String(url).endsWith("/v8/management/routing/cooldown/reset")) {
      const r = reset(body);
      if (r.status === 200) state = state.map(f => f.auth_index === body.auth_index ? { ...f, status: "active", unavailable: false, quota_blocked: false, next_retry_after: null, cooldowns: [] } : f);
      return new Response(JSON.stringify(r.body), { status: r.status });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch);
  return { client, calls };
}
const cooled = (name: string, provider: string, email: string, authIndex: string, extra: any = {}) => ({ name, provider, email, auth_index: authIndex, disabled: false,
  status: "error", unavailable: true, quota_blocked: true, next_retry_after: "2026-11-19T13:00:14Z", id_token: "eyJ.secret-id-token.sig", access_token: "secret-access",
  cooldowns: [{ scope: "model", model_key: "claude-opus-5-5", reason: "quota", retry_at: "2026-11-19T13:00:14Z", remaining_seconds: 9, http_status: 429 }], ...extra });

test("clearCooldown resolves a unique match and sends only its auth_index to the v8 reset route", async () => {
  const { client, calls } = fakeCpa([cooled("claude-a-one@example.com.json", "claude", "one@example.com", "idx-one"),
    cooled("claude-b-two@example.com.json", "claude", "two@example.com", "idx-two"), cooled("codex-one@example.com.json", "codex", "one@example.com", "idx-codex")]);
  const accounts = await client.listAccounts();
  const result = await client.clearCooldown(accounts.find(a => a.email === "one@example.com" && a.provider === "claude")!.id);
  const resets = calls.filter(c => c.method === "POST");
  assert.equal(resets.length, 1);
  assert.equal(resets[0].url, "http://proxy/v8/management/routing/cooldown/reset");
  assert.deepEqual(resets[0].body, { auth_index: "idx-one" });
  assert.equal(resets[0].auth, `Bearer ${KEY}`);
  assert.equal(result.auth_index, "idx-one");
  assert.equal(result.auth_file, "claude-a-one@example.com.json");
  assert.equal(result.provider, "claude");
  assert.deepEqual(result.models_reset, ["m1"]);
  assert.equal(result.before.unavailable, true);
  assert.equal(result.before.cooldowns[0].model, "claude-opus-5-5");
  assert.equal(result.after?.unavailable, false);
  assert.deepEqual(result.after?.cooldowns, []);
  const text = JSON.stringify(result);
  for (const secret of [KEY, "secret-id-token", "secret-access"]) assert.ok(!text.includes(secret), secret);
});

test("clearCooldown refuses with no match, ambiguity or a disabled credential, and never calls reset", async () => {
  // No match: the credential vanished between discovery and the call.
  const gone = fakeCpa([cooled("claude-a.json", "claude", "one@example.com", "idx-one")]);
  const [acct] = await gone.client.listAccounts();
  const g2 = fakeCpa([]);
  (g2.client as any).accounts = [{ ...acct }];
  await assert.rejects(g2.client.clearCooldown(acct.id), (e: any) => e.code === "no_match");
  // Two files for the same login.
  const dup = fakeCpa([cooled("claude-a-one@example.com.json", "claude", "one@example.com", "idx-1"),
    cooled("claude-b-one@example.com.json", "claude", "one@example.com", "idx-2")]);
  const [d] = await dup.client.listAccounts();
  await assert.rejects(dup.client.clearCooldown(d.id), (e: any) => e.code === "ambiguous"
    && /claude-a-one@example\.com\.json, claude-b-one@example\.com\.json/.test(e.message) && !e.message.includes("idx-"));
  // Paused on the proxy since discovery.
  const paused = fakeCpa([cooled("claude-a.json", "claude", "one@example.com", "idx-one")]);
  const [p] = await paused.client.listAccounts();
  const p2 = fakeCpa([cooled("claude-a.json", "claude", "one@example.com", "idx-one", { disabled: true })]);
  (p2.client as any).accounts = [{ ...p }];
  await assert.rejects(p2.client.clearCooldown(p.id), (e: any) => e.code === "disabled");
  // Unknown connection id.
  await assert.rejects(dup.client.clearCooldown("cpa:claude:nobody@example.com"), (e: any) => e.code === "not_found");
  for (const c of [g2.calls, dup.calls, p2.calls]) assert.ok(!c.some(x => x.method === "POST"));
});

test("clearCooldown separates Codex workspaces that share an email", async () => {
  const token = (ws: string) => `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: ws } })).toString("base64url")}.y`;
  const { client, calls } = fakeCpa([cooled("codex-one-team.json", "codex", "one@example.com", "idx-team", { id_token: token("ws-team") }),
    cooled("codex-one-plus.json", "codex", "one@example.com", "idx-plus", { id_token: token("ws-plus") })]);
  const accounts = await client.listAccounts();
  assert.equal(accounts.length, 2);
  const result = await client.clearCooldown(accounts.find(a => a.accountId === "ws-plus")!.id);
  assert.equal(result.auth_index, "idx-plus");
  assert.deepEqual(calls.find(c => c.method === "POST")!.body, { auth_index: "idx-plus" });
});

test("clearCooldown surfaces proxy errors without leaking the management key", async () => {
  for (const [status, body] of [[404, { error: "auth not found" }], [500, { error: `failed to reset quota: boom ${KEY}` }], [401, { error: "invalid management key" }], [503, null]] as const) {
    const { client } = fakeCpa([cooled("claude-a.json", "claude", "one@example.com", "idx-one")], () => ({ status, body }));
    const [a] = await client.listAccounts();
    await assert.rejects(client.clearCooldown(a.id), (e: any) => e.code === "proxy_error"
      && e.message.includes(`HTTP ${status}`) && !e.message.includes(KEY));
  }
  // A 200 that names some other credential is not trusted.
  const { client } = fakeCpa([cooled("claude-a.json", "claude", "one@example.com", "idx-one")], () => ({ status: 200, body: { status: "ok", auth_index: "idx-other" } }));
  const [a] = await client.listAccounts();
  await assert.rejects(client.clearCooldown(a.id), (e: any) => e.code === "proxy_error");
});
