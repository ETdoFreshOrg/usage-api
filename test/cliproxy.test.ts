import assert from "node:assert/strict";
import test from "node:test";
import { CliProxyClient, assertLocalManagementPath } from "../src/providers/cliproxy.js";

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

test("CPA discovery reports the credential file and an expired sign-in from the proxy's own status", async () => {
  const { client, calls } = setup([{ files: [
    { ...file("claude", "one@example.com"), name: "claude-one.json", status: "error", status_message: "unauthorized (refresh token invalid)" },
    { ...file("codex", "two@example.com"), name: "codex-two.json", status: "active", status_message: "" }] }]);
  const accounts = await client.listAccounts();
  assert.deepEqual(accounts.map(a => [a.fileName, a.loginExpired]), [["claude-one.json", true], ["codex-two.json", false]]);
  assert.deepEqual(calls.map(c => c.url), ["http://proxy/v0/management/auth-files"]);
});

test("the proxy client has no upstream pass-through: api-call is refused before any request", async () => {
  const { client, calls } = setup([]);
  assert.equal(typeof (client as any).fetchUsage, "undefined");
  assert.equal(typeof (client as any).providerGet, "undefined");
  await assert.rejects((client as any).management("api-call", { url: "https://api.anthropic.com/api/oauth/usage" }), /does not call CLIProxyAPI's api-call/);
  for (const path of ["api-call", "/api-call", "api-call?x=1", "requests/api-call"]) assert.throws(() => assertLocalManagementPath(path));
  for (const path of ["auth-files", "routing/cooldown/reset"]) assert.doesNotThrow(() => assertLocalManagementPath(path));
  assert.equal(calls.length, 0);
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
