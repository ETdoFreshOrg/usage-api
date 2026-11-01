// /mcp: owner-only OAuth in front of read-only usage tools.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import express from "express";
import { installMcp, CLAUDE_CLIENT_ID, OAUTH_PATH } from "../src/mcp.js";
import { suggest, summarizeAccount, type ToolContext } from "../src/mcp-tools.js";

const origin = "https://usage.etdofresh.com";
const ownerKey = "usage-owner-fixture-key";
const claudeRedirect = "https://claude.ai/api/mcp/auth_callback";
const NOW = Date.parse("2026-11-01T06:00:00Z");
const hoursFromNow = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

const providers: Record<string, any> = {
  claude: { data: { seven_day: { utilization: 49, resets_at: hoursFromNow(48), expected_percent: 71, slack: 22 }, seven_day_fable: { utilization: 10, resets_at: hoursFromNow(48) }, subscription_type: "Max 20x",
    reset_credits: { available_count: 2, next_expires_at: hoursFromNow(72), credits: [] } },
    fetchedAt: hoursFromNow(-0.05), ageSec: 180, staleness: "fresh", error: null, account: { id: "a1", name: "one@example.com", family: "claude" } },
  claude3: { data: { seven_day: { utilization: 2, resets_at: hoursFromNow(150) }, subscription_type: "Max 5x" },
    fetchedAt: hoursFromNow(-0.05), ageSec: 180, staleness: "fresh", error: null, account: { id: "a3", name: "three@example.com", family: "claude" } },
  claude4: { data: { seven_day: { utilization: 100, resets_at: hoursFromNow(5) } },
    fetchedAt: hoursFromNow(-0.05), ageSec: 180, staleness: "fresh", error: null, account: { id: "a4", name: "four@example.com", family: "claude" } },
  codex: { data: { plan_type: "pro", seven_day: { used_percent: 30, resets_at: hoursFromNow(24), window_minutes: 10080 }, five_hour: { used_percent: 100, resets_at: hoursFromNow(2), window_minutes: 300 }, additional: [] },
    fetchedAt: hoursFromNow(-0.05), ageSec: 180, staleness: "fresh", error: null, account: { id: "c1", name: "codex@example.com", family: "codex" } },
  zai: { data: null, error: "ZAI_API_KEY not set" },
};

const ctx: ToolContext = {
  now: () => NOW,
  getProviders: () => providers,
  getProxyAccounts: () => [
    { provider: "claude", email: "paused@example.com", enabled: false },
    { provider: "claude", email: "one@example.com", enabled: true, status: "active", unavailable: false }],
  getActivity: async (hours) => ({ window_hours: hours, total_in_window: 3, counted: 3, by_account: {
    "one@example.com": { provider: "claude", requests: 3, errors: 1, total_tokens: 900, last_at: hoursFromNow(-0.1), models: { "claude-opus-5-5": 3 } } } }),
  getHistory: (granularity) => ({ granularity, generatedAt: new Date(NOW).toISOString(), retentionDays: null, series: [
    { provider: "claude", metric: "seven_day", points: [
      { t: hoursFromNow(-24 * 10), value: 1, min: 1, max: 1, count: 1 },
      { t: hoursFromNow(-2), value: 48, expectedValue: 70, min: 48, max: 48, count: 1 }] },
    { provider: "claude", metric: "seven_day_fable", points: [] },
    { provider: "claude", metric: "five_hour", points: [{ t: hoursFromNow(-2), value: 5, min: 5, max: 5, count: 1 }] },
    { provider: "claude3", metric: "seven_day", points: [] }] }),
  getRecent: async () => [
    { startedAt: hoursFromNow(-0.1), model: "claude-opus-5-5", outcome: "ok", jev: { effort: "high", resolved: "claude-opus-5-5" } },
    { startedAt: hoursFromNow(-0.2), model: "claude-opus-5-5", outcome: "error", jev: { effort: null, resolved: "claude-opus-5-5" } }],
};

async function start(withKey = true) {
  const app = express();
  installMcp(app, { ...ctx, ownerKey: withKey ? ownerKey : undefined, publicOrigin: origin, log: () => {} });
  app.get("/api/health", (_req, res) => { res.json({ ok: true }); });
  const server = await new Promise<any>(r => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}
const form = (base: string, path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body) });
const pkce = () => { const verifier = randomBytes(32).toString("base64url"); return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }; };
async function signIn(base: string, key = ownerKey) {
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({ client_id: CLAUDE_CLIENT_ID, redirect_uri: claudeRedirect, resource: origin + "/mcp", response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "s1" });
  const page = await fetch(base + OAUTH_PATH + "/authorize?" + params, { redirect: "manual" });
  assert.equal(page.status, 200);
  const html = await page.text();
  const consent = await form(base, OAUTH_PATH + "/consent", { request: /name="request" value="([^"]+)"/.exec(html)![1], owner_key: key, decision: "allow" },
    { Origin: origin, Cookie: page.headers.get("set-cookie")!.split(";")[0] });
  if (consent.status !== 302) return { status: consent.status, html, tokens: null as any };
  const code = new URL(consent.headers.get("location")!).searchParams.get("code")!;
  const tokens = await (await form(base, OAUTH_PATH + "/token", { grant_type: "authorization_code", client_id: CLAUDE_CLIENT_ID, code, code_verifier: verifier, redirect_uri: claudeRedirect, resource: origin + "/mcp" })).json();
  return { status: 302, html, tokens };
}
const rpc = (base: string, token: string | null, method: string, params = {}) => fetch(base + "/mcp", { method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: "Bearer " + token } : {}) },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
const call = async (base: string, token: string, name: string, args: Record<string, unknown> = {}) =>
  (await (await rpc(base, token, "tools/call", { name, arguments: args })).json()).result;

test("MCP is off without an owner key and other routes still work", async () => {
  const s = await start(false);
  try {
    assert.equal((await rpc(s.base, null, "tools/list")).status, 503);
    assert.equal((await fetch(s.base + "/api/health")).status, 200);
  } finally { await s.close(); }
});

test("/mcp requires OAuth and consent needs the owner key", async () => {
  const s = await start();
  try {
    const r = await rpc(s.base, null, "tools/list");
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate")!, /oauth-protected-resource\/mcp/);
    const as = await (await fetch(s.base + "/.well-known/oauth-authorization-server")).json();
    assert.deepEqual(as.scopes_supported, ["usage.read"]);
    assert.equal(as.token_endpoint, origin + "/mcp/oauth/token");
    const padded = await signIn(s.base, "  " + ownerKey + "\n");
    assert.equal(padded.status, 302);
    const bad = await signIn(s.base, "wrong");
    assert.equal(bad.status, 401);
    assert.match(bad.html, /Read-only/);
  } finally { await s.close(); }
});

test("signed-in client lists read-only tools and reads usage", async () => {
  const s = await start();
  try {
    const { tokens } = await signIn(s.base);
    assert.ok(tokens.access_token);
    const list = await (await rpc(s.base, tokens.access_token, "tools/list")).json();
    const names = list.result.tools.map((t: any) => t.name);
    assert.deepEqual(names, ["list_accounts", "get_usage", "suggest_account", "usage_history", "recent_requests"]);
    for (const t of list.result.tools) assert.equal(t.annotations.readOnlyHint, true);

    const accounts = (await call(s.base, tokens.access_token, "list_accounts")).structuredContent;
    assert.deepEqual(accounts.accounts.map((a: any) => a.account), ["claude", "claude3", "claude4", "codex"]);
    const claude = accounts.accounts[0];
    assert.equal(claude.weekly.used_percent, 49);
    assert.equal(claude.weekly.hours_until_reset, 48);
    assert.equal(claude.weekly.pace_slack, 22);
    assert.equal(claude.weekly_by_model.fable.used_percent, 10);
    assert.equal("five_hour" in claude, false);
    assert.deepEqual(claude.reset_credits, { available: 2, next_expires_at: hoursFromNow(72) });
    assert.equal(accounts.accounts[1].reset_credits, null);
    assert.deepEqual(claude.proxy, { enabled: true, status: "active", unavailable: false });
    assert.equal("proxy" in accounts.accounts[1], false);
    assert.deepEqual(accounts.paused_on_proxy, [{ provider: "claude", email: "paused@example.com" }]);
    assert.deepEqual(accounts.other_providers, [{ provider: "zai", has_data: false, note: "ZAI_API_KEY not set" }]);

    const codexOnly = (await call(s.base, tokens.access_token, "list_accounts", { provider: "codex" })).structuredContent;
    assert.deepEqual(codexOnly.accounts.map((a: any) => a.account), ["codex"]);

    const ranking = (await call(s.base, tokens.access_token, "suggest_account")).structuredContent.ranking;
    assert.deepEqual(ranking.map((r: any) => r.account), ["claude3", "claude", "codex", "claude4"]);
    assert.equal(ranking.find((r: any) => r.account === "codex").blocked_reason, "5-hour limit reached");
    assert.equal(ranking.find((r: any) => r.account === "claude").reset_credits_available, 2);
    assert.equal(ranking.find((r: any) => r.account === "claude4").blocked_reason, "weekly limit reached");

    const detail = (await call(s.base, tokens.access_token, "get_usage", { account: "codex" })).structuredContent;
    assert.equal(detail.five_hour.used_percent, 100);
    assert.equal(detail.plan, "pro");
    assert.equal((await call(s.base, tokens.access_token, "get_usage", { account: "nope" })).isError, true);

    const hist = (await call(s.base, tokens.access_token, "usage_history", { account: "claude", days: 7 })).structuredContent;
    assert.deepEqual(hist.series, [{ metric: "weekly", points: [{ t: hoursFromNow(-2), used_percent: 48, expected_percent: 70 }] }]);

    const recent = (await call(s.base, tokens.access_token, "recent_requests", { hours: 6 })).structuredContent;
    assert.equal(recent.by_account.window_hours, 6);
    assert.equal(recent.by_account.by_account["one@example.com"].errors, 1);
    assert.equal(recent.latest.length, 2);
    assert.equal((await call(s.base, tokens.access_token, "recent_requests", { hours: 500 })).isError, true);
    assert.equal((await call(s.base, tokens.access_token, "pause_account", {})).isError, true);
  } finally { await s.close(); }
});

test("suggest puts stale and empty accounts after usable ones", () => {
  const list = [
    summarizeAccount("claude", { data: null, staleness: "stale", account: { id: "x", name: "x", family: "claude" } }, NOW),
    summarizeAccount("claude2", { data: { seven_day: { utilization: 90, resets_at: hoursFromNow(10) } }, staleness: "fresh", account: { id: "y", name: "y", family: "claude" } }, NOW),
  ];
  const ranked = suggest(list);
  assert.equal(ranked[0].account, "claude2");
  assert.equal(ranked[0].spare_percent_per_day, 24);
  assert.equal(ranked[1].blocked_reason, "no usage data yet");
});
