import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ManagerClient, ManagerAccount, buildLocalUsage, loginRejected, parseAutoPing, parseSnapshots } from "../src/providers/local.js";
import { mergePassive } from "../src/passive.js";
import { summarizeAccount, suggest } from "../src/mcp-tools.js";

const NOW = Date.parse("2026-11-20T16:00:00Z");
const MIN = 60_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

const claude: ManagerAccount = { id: "claude-id", provider: "claude", email: "one@example.com", fileName: "claude-one.json", authIndex: "idx-c", accountId: null };
const codex: ManagerAccount = { id: "codex-id", provider: "codex", email: "two@example.com", fileName: "codex-two.json", authIndex: "idx-x", accountId: "ws-1" };

// Shapes copied from CPA Manager's answers on 2026-11-20 (values changed).
const win = (id: string, kind: string, used: number, endMs: number, seenMs: number, extra: Record<string, unknown> = {}) => ({
  provider_window_id: id, window_kind: kind, model_scope_kind: "all", used_percent: used, remaining_percent: 100 - used,
  cycle_end_ms: endMs, duration_seconds: kind === "five_hour" ? 18000 : kind === "daily" ? 86400 : 604800, observed_at_ms: seenMs,
  source: "api_query", field_sources: { quota: { source: "api_query", observed_at_ms: seenMs } }, ...extra });
const codexWin = (id: string, kind: string, used: number, endMs: number, seenMs: number) =>
  win(id, kind, used, endMs, seenMs, { model_scope_kind: "family", model_scope_key: "codex_main", plan_type: "prolite", source: "response_header" });
const ping = (name: string, status: string, weekly: number | undefined, checkedMs: number, enabled = true) =>
  ({ id: `x:${name}:idx`, name, provider: name.split("-")[0], enabled, status, weekly_percent: weekly, checked_ms: checkedMs, pings: 3 });

const state = (pings: any[], items: any[]) => ({ autoPing: parseAutoPing({ accounts: pings }), snapshots: parseSnapshots({ items }) });

test("a Claude account is built from stored snapshots: weekly and 5-hour with reset times and as_of; everything else null", () => {
  const s = state([ping("claude-one.json", "Already pinged or attempted this window", 42, NOW - 3 * MIN)],
    [{ row_key: "claude-id", windows: [
      win("seven-day", "weekly", 42, NOW + 4 * DAY, NOW - 3 * MIN),
      win("five-hour", "five_hour", 19, NOW + 2 * 3_600_000, NOW - 3 * MIN),
      // A scoped (Fable) window and an unrelated weekly one are stored too; neither is shown.
      win("weekly-scoped-fable", "weekly", 7, NOW + 4 * DAY, NOW - 3 * MIN, { model_scope_kind: "feature", model_scope_key: "scope_unknown" }),
      win("iguana-necktie", "weekly", 0, NOW + 4 * DAY, NOW - 3 * MIN)] }]);
  const d: any = buildLocalUsage(claude, s, NOW);
  assert.deepEqual(d.seven_day, { utilization: 42, resets_at: iso(NOW + 4 * DAY), as_of: iso(NOW - 3 * MIN), source: "manager_snapshot" });
  assert.deepEqual(d.five_hour, { utilization: 19, resets_at: iso(NOW + 2 * 3_600_000), as_of: iso(NOW - 3 * MIN), source: "manager_snapshot" });
  assert.equal(d.as_of, iso(NOW - 3 * MIN));
  for (const lost of ["seven_day_sonnet", "seven_day_opus", "seven_day_design", "seven_day_fable", "subscription_type", "reset_credits", "subscription"])
    assert.equal(d[lost], null, `${lost} is not available locally and must be null`);
  assert.equal(d.source, "local");
});

test("a window that has reset is dropped, never shown with its old number or as 0%", () => {
  const s = state([], [{ row_key: "claude-id", windows: [
    win("seven-day", "weekly", 80, NOW + DAY, NOW - 20 * MIN),
    win("five-hour", "five_hour", 100, NOW - MIN, NOW - 6 * 3_600_000)] }]);
  const d: any = buildLocalUsage(claude, s, NOW);
  assert.equal(d.five_hour, null);
  assert.equal(d.seven_day.utilization, 80);
  // Nothing stored at all: no data, not zeros.
  assert.equal(buildLocalUsage(claude, state([], [{ row_key: "claude-id", windows: [win("seven-day", "weekly", 100, NOW - DAY, NOW - 2 * DAY)] }]), NOW), null);
  assert.equal(buildLocalUsage(claude, state([], []), NOW), null);
});

test("freshest wins: auto-ping's newer weekly % replaces an older snapshot's number and keeps its reset time", () => {
  const s = state([ping("codex-two.json", "No five-hour limit reported", 71, NOW - 2 * MIN)],
    [{ row_key: "codex-id", windows: [codexWin("weekly", "weekly", 64, NOW + 5 * DAY, NOW - 3 * 3_600_000), codexWin("window-1d-0", "daily", 5, NOW + 3_600_000, NOW - 3 * 3_600_000),
      codexWin("five-hour", "five_hour", 0, NOW - 10 * DAY, NOW - 10 * DAY - MIN)] }]);
  const d: any = buildLocalUsage(codex, s, NOW);
  assert.deepEqual(d.seven_day, { used_percent: 71, window_minutes: 10080, resets_at: iso(NOW + 5 * DAY), as_of: iso(NOW - 2 * MIN), source: "auto_ping" });
  assert.deepEqual(d.one_day, { used_percent: 5, window_minutes: 1440, resets_at: iso(NOW + 3_600_000), as_of: iso(NOW - 3 * 3_600_000), source: "manager_snapshot" });
  assert.equal(d.five_hour, null);
  assert.equal(d.primary, null);
  assert.deepEqual(d.secondary, d.seven_day);
  assert.equal(d.plan_type, "prolite");
  assert.deepEqual([d.additional, d.credits_balance, d.reset_credits, d.subscription], [[], null, null, null]);
  assert.equal(d.as_of, iso(NOW - 2 * MIN));
  // An older auto-ping check does not replace a newer snapshot.
  const older: any = buildLocalUsage(codex, state([ping("codex-two.json", "x", 10, NOW - 5 * 3_600_000)],
    [{ row_key: "codex-id", windows: [codexWin("weekly", "weekly", 64, NOW + 5 * DAY, NOW - MIN)] }]), NOW);
  assert.equal(older.seven_day.used_percent, 64);
  assert.equal(older.seven_day.source, "manager_snapshot");
});

test("auto-ping alone gives a weekly % with an unknown reset time, not an invented one", () => {
  const d: any = buildLocalUsage(codex, state([ping("codex-two.json", "No five-hour limit reported", 100, NOW - MIN)], []), NOW);
  assert.deepEqual(d.seven_day, { used_percent: 100, window_minutes: 10080, resets_at: null, as_of: iso(NOW - MIN), source: "auto_ping" });
});

test("a rejected auto-ping quota check is not read as a number; 401/403 marks the sign-in expired", () => {
  const s = state([ping("claude-one.json", "quota request returned HTTP 401", 100, NOW - MIN)],
    [{ row_key: "claude-id", windows: [win("seven-day", "weekly", 30, NOW + DAY, NOW - 26 * 3_600_000)] }]);
  const p = s.autoPing.get("claude-one.json")!;
  assert.equal(p.weeklyPercent, null);
  assert.equal(p.quotaHttpStatus, 401);
  assert.equal(loginRejected(false, p), true);
  // The last stored number stays, with its real (old) time, so it reads as stale.
  const d: any = buildLocalUsage(claude, s, NOW);
  assert.equal(d.seven_day.utilization, 30);
  assert.equal(d.as_of, iso(NOW - 26 * 3_600_000));
  const limited = parseAutoPing({ accounts: [ping("claude-one.json", "quota request returned HTTP 429", 100, NOW)] }).get("claude-one.json")!;
  assert.equal(loginRejected(false, limited), false);
  assert.equal(loginRejected(true, undefined), true);
  // Accounts not on auto-ping are not read from it.
  assert.equal(parseAutoPing({ accounts: [ping("claude-one.json", "", 50, NOW, false)] }).size, 0);
});

test("after a proxy restart (no headers) the stored snapshot is shown; newer headers win again once traffic returns", () => {
  const s = state([], [{ row_key: "claude-id", windows: [win("seven-day", "weekly", 55, NOW + 2 * DAY, NOW - 4 * MIN)] }]);
  const stored: any = buildLocalUsage(claude, s, NOW);
  assert.equal(mergePassive("claude", stored, stored.as_of, null, NOW), null);
  assert.equal(stored.seven_day.utilization, 55);
  const headers = { observedAt: iso(NOW - MIN), signals: { "anthropic-ratelimit-unified-7d-utilization": "0.58",
    "anthropic-ratelimit-unified-7d-reset": String((NOW + 2 * DAY) / 1000) } };
  const merged = mergePassive("claude", stored, stored.as_of, headers, NOW);
  assert.equal(merged.seven_day.utilization, 58);
  assert.equal(merged.seven_day.source, "proxy_headers");
  assert.equal(merged.seven_day.as_of, iso(NOW - MIN));
  // Headers older than the stored observation do not replace it.
  assert.equal(mergePassive("claude", stored, stored.as_of, { ...headers, observedAt: iso(NOW - 30 * MIN) }, NOW), null);
});

test("clients read the null fields without breaking: summaries, ranking and the missing weekly case", () => {
  const d = buildLocalUsage(claude, state([], [{ row_key: "claude-id", windows: [win("seven-day", "weekly", 42, NOW + 4 * DAY, NOW - MIN)] }]), NOW);
  const snap = { data: d, staleness: "fresh" as const, ageSec: 60, fetchedAt: iso(NOW - MIN), error: null,
    account: { id: "claude-id", name: "one@example.com", family: "claude", priority: 5 }, renewal: null, expiry: null };
  const summary: any = summarizeAccount("claude3", snap as any, NOW);
  assert.equal(summary.weekly.used_percent, 42);
  assert.equal(summary.five_hour, null);
  assert.equal(summary.reset_credits, null);
  assert.equal(summary.plan, null);
  assert.equal("weekly_by_model" in summary, false);
  const ranked = suggest([summary, summarizeAccount("claude4", { ...snap, data: null } as any, NOW)]);
  assert.deepEqual(ranked.map(r => [r.account, r.usable_now, r.reset_credits_available]), [["claude3", true, null], ["claude4", false, null]]);
  assert.equal(ranked[1].blocked_reason, "no usage data yet");
});

test("ManagerClient only reads: GET auto-ping and POST quota-snapshots/query, shared across accounts and cached", async () => {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  let now = NOW;
  const client = new ManagerClient("http://manager/", "manager-key", (async (url: any, init: any) => {
    calls.push({ method: init?.method ?? "GET", url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(String(url).endsWith("/auto-ping") ? { accounts: [ping("claude-one.json", "ok", 9, NOW)] }
      : { items: [{ row_key: "claude-id", windows: [win("seven-day", "weekly", 9, NOW + DAY, NOW)] }] }), { status: 200 });
  }) as typeof fetch, 10_000, () => now);
  const first = await client.state([claude, codex]);
  await client.state([claude, codex]);
  assert.deepEqual(calls.map(c => `${c.method} ${c.url}`).sort(), ["GET http://manager/v0/management/auto-ping", "POST http://manager/v0/management/quota-snapshots/query"]);
  const query = calls.find(c => c.method === "POST")!.body;
  assert.deepEqual(query.accounts.map((a: any) => [a.row_key, a.provider, a.account.auth_file_snapshot, a.account.auth_index, a.account.auth_account_id_snapshot ?? null]),
    [["claude-id", "claude", "claude-one.json", "idx-c", null], ["codex-id", "codex", "codex-two.json", "idx-x", "ws-1"]]);
  assert.equal(query.include_inactive, true);
  assert.equal(first.snapshots.get("claude-id")!.length, 1);
  now += 11_000;
  await client.state([claude, codex]);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(c => /\/v0\/management\/(auto-ping|quota-snapshots\/query)$/.test(c.url)));
});

// ET, 2026-11-20: usage-api must make no quota/usage request to Anthropic or ChatGPT, directly or
// through CLIProxyAPI's api-call. These read the shipped source so a later change cannot quietly
// bring one back.
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []);
const code = (file: string) => readFileSync(file, "utf8").split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("no source file can reach Anthropic's or ChatGPT's usage endpoints, or the proxy's api-call", () => {
  const forbidden: Array<[RegExp, string]> = [
    [/api\.anthropic\.com/, "Anthropic host"], [/chatgpt\.com/, "ChatGPT host"], [/claude\.ai/, "claude.ai host"],
    [/oauth\/usage|oauth\/profile/, "Anthropic OAuth endpoint"], [/wham\/|accounts\/check/, "ChatGPT usage endpoint"],
    [/\$TOKEN\$/, "api-call token substitution"], [/management\(\s*["'`]api-call/, "api-call request"],
    [/auto-ping\/(run|test)/, "auto-ping trigger (it sends upstream requests)"],
  ];
  for (const file of sources(SRC)) {
    const text = code(file);
    for (const [pattern, what] of forbidden)
      assert.equal(pattern.test(text), false, `${path.relative(SRC, file)} contains ${what}`);
  }
  const hosts = new Set<string>();
  for (const file of sources(SRC)) for (const m of code(file).matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) hosts.add(m[1].toLowerCase());
  // Every host named in code: the fleet's own services, the other providers' billing APIs (left
  // as they were), and api.openai.com, which is the admin costs API and a JWT claim name.
  assert.deepEqual([...hosts].sort(), ["1mcp.etdofresh.com", "api.openai.com", "api.z.ai", "etbot.etdofresh.com", "etzminisforumx1pro.lan", "localhost",
    "openrouter.ai", "usage.etdofresh.com"].sort());
});

test("the account reader's only inputs are the proxy account list and CPA Manager's two reads", () => {
  const server = code(path.join(SRC, "server.ts"));
  assert.match(server, /new AccountPoller\(key, family, \(\) => readLocalUsage\(id\)/);
  assert.equal(/fetchUsage|fetchClaudeUsage|fetchCodexUsage|providerGet/.test(server), false);
  const local = code(path.join(SRC, "providers", "local.ts"));
  assert.deepEqual([...local.matchAll(/(autoPing|snapshots): "([^"]+)"/g)].map(m => m[2]), ["auto-ping", "quota-snapshots/query"]);
});
