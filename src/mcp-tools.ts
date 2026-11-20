// MCP tools over the usage snapshot. Most read data usage-api already holds in memory
// (or its recent-request cache); list_models fetches CLIProxyAPI's model list live, and
// refresh_usage runs one on-demand usage check for one account through the normal poller.
// The one write, clear_proxy_cooldown, clears CLIProxyAPI's runtime cooldown for exactly
// one named account; no tool can pause accounts, spend reset credits, change priorities
// or touch other proxy settings.
import type { HistorySeriesResponse, HistoryGranularity } from "./history.js";
import type { RecentExchange, ActivitySummary } from "./recent.js";
import type { ProxyAccountStatus, ClearedCooldown } from "./providers/cliproxy.js";
import { CooldownError } from "./providers/cliproxy.js";
import type { ProxyModelList } from "./proxy-models.js";
import { ProxyModelsError } from "./proxy-models.js";
import type { RefreshOutcome } from "./account-poller.js";

/** What refresh_usage needs back from the server: the outcome plus the account's state afterwards. */
export interface UsageRefresh {
  outcome: RefreshOutcome;
  snapshot: ProviderSnapshot & { dataSource?: "passive" | "active" | null; observedAt?: string | null; activeFetchedAt?: string | null };
}

export const SCOPE = "usage.read";

export interface ProviderSnapshot {
  data?: any;
  fetchedAt?: string | null;
  ageSec?: number | null;
  staleness?: string;
  error?: string | null;
  nextFetchAt?: string;
  account?: { id: string; name: string; family: string; priority?: number | null };
  renewal?: { renews_at: string; billing_cycle: string; days_until_renewal: number; source: "manual" | "provider" } | null;
  expiry?: { expires_at: string; days_until_expiry: number; source: "provider" | "manual"; ends_at: string | null } | null;
}

export interface ToolContext {
  getAnalytics?: () => Promise<unknown>;
  getProviders: () => Record<string, ProviderSnapshot>;
  getProxyAccounts: () => ProxyAccountStatus[] | null;
  getActivity: (hours: number) => Promise<ActivitySummary | null>;
  getHistory: (granularity: HistoryGranularity) => HistorySeriesResponse;
  getRecent: () => Promise<RecentExchange[] | null>;
  /** Clears CLIProxyAPI's runtime cooldown for one tracked account key; absent when the proxy is not configured. */
  clearProxyCooldown?: (account: string) => Promise<ClearedCooldown>;
  /** Fresh GET /v1/models on CLIProxyAPI; absent when the proxy is not configured. */
  listModels?: () => Promise<ProxyModelList>;
  /** One on-demand usage check for one tracked account key, through its poller. */
  refreshUsage?: (account: string) => Promise<UsageRefresh | null>;
  now?: () => number;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const tools = [
  {
    name: "list_accounts",
    description: "Every Claude and Codex account usage-api is tracking, with weekly usage %, when the week resets, how far ahead or behind an even pace it is, the 5-hour window (Codex, and Claude accounts that have one; null otherwise), the 24-hour window (one_day, Codex accounts that report one; usually null), how many reset credits each account has (count only; nothing here uses one), the next subscription renewal date (from ChatGPT for Codex, set manually on usage-api otherwise; null if unknown), the subscription end date if the account will expire instead of renewing (from ChatGPT for Codex, entered by hand otherwise; null if none), whether the numbers are fresh, and the account's status on the CLIProxyAPI proxy. Also lists accounts that are paused (disabled) on the proxy, and which other providers (Z.ai, OpenRouter, OpenAI, Jev) have data. Read-only.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      provider: { type: "string", enum: ["claude", "codex"], description: "Only this provider's accounts. Omit for both." },
    } },
    annotations: { title: "List usage accounts", ...READ_ONLY },
  },
  {
    name: "get_usage",
    description: "Full usage detail for one account or provider key from list_accounts (e.g. claude, claude3, codex, codex2, zai, openrouter, openai, jev): 5-hour, 24-hour and weekly windows, per-model weekly windows, reset credits, subscription renewal and expiry dates, Codex additional limits, plan, poll status. Read-only.",
    inputSchema: { type: "object", additionalProperties: false, required: ["account"], properties: {
      account: { type: "string", description: "Account key from list_accounts, such as claude3 or codex." },
    } },
    annotations: { title: "Account usage detail", ...READ_ONLY },
  },
  {
    name: "suggest_account",
    description: "Ranks Claude and/or Codex accounts by how much work they can take right now, to help split work across accounts. Accounts that are blocked (weekly, 24-hour or 5-hour window at 100%, or no data) go last. Among usable ones, more weekly headroom ranks higher (an account with no weekly limit is ranked by its 24-hour window; ranked_by says which); spare_percent_per_day shows how much of that window can be spent per day and still finish it, so accounts whose unused allowance is about to reset can be used first. Read-only; it does not route anything.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      provider: { type: "string", enum: ["claude", "codex"], description: "Only rank this provider's accounts. Omit for both." },
    } },
    annotations: { title: "Suggest an account", ...READ_ONLY },
  },
  {
    name: "usage_history",
    description: "How one account's weekly usage % (and 5-hour and 24-hour %, where the account has them) moved over recent days, from usage-api's history. Read-only.",
    inputSchema: { type: "object", additionalProperties: false, required: ["account"], properties: {
      account: { type: "string", description: "Account key from list_accounts, such as claude or codex2." },
      days: { type: "integer", minimum: 1, maximum: 30, default: 7, description: "How many days back (1-30)." },
      granularity: { type: "string", enum: ["hourly", "daily"], default: "hourly", description: "Bucket size." },
    } },
    annotations: { title: "Usage history", ...READ_ONLY },
  },
  {
    name: "recent_requests",
    description: "Requests recorded by the CLIProxyAPI proxy: per-account request and error counts, tokens and models over the last N hours, plus the latest 20 requests (time, model, effort, ok/error). In-progress requests are not included. Read-only.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      hours: { type: "integer", minimum: 1, maximum: 168, default: 24, description: "Window for per-account counts, in hours (1-168)." },
    } },
    annotations: { title: "Recent proxy requests", ...READ_ONLY },
  },
  {
    name: "clear_proxy_cooldown",
    description: "WRITE. Use only when ET explicitly names one account and asks to clear its proxy cooldown. Clears CLIProxyAPI's own runtime cooldown / quota-exceeded routing state for exactly one Claude or Codex account (key from list_accounts, e.g. claude3 or codex2), so the proxy will try that account again right away. It does NOT reset or add upstream quota: Anthropic/OpenAI limits are unchanged, and if the account is still out of quota its next request will put it back into cooldown. It does not change priorities, enable/disable (pause) state, routing strategy, credentials or any other proxy setting. One account per call; no batch or wildcard. If the key does not map to exactly one proxy credential it refuses and lists the candidates. Returns the account, provider, auth file name, auth_index and the cooldown state before and after.",
    inputSchema: { type: "object", additionalProperties: false, required: ["account"], properties: {
      account: { type: "string", pattern: "^(claude|codex)\\d*$", description: "Exactly one account key from list_accounts, such as claude3 or codex2." },
    } },
    annotations: { title: "Clear one account's proxy cooldown", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "list_models",
    description: "The models CLIProxyAPI is serving right now: a fresh GET /v1/models against the proxy on every call (nothing cached), returning each model id with the owner/type fields the proxy gives, the count and the fetch time. This only reads the proxy's current list; it is NOT a forced refresh of the upstream provider model catalogs (the proxy refreshes those on its own schedule). Read-only.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { title: "List proxy models", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "refresh_usage",
    description: "Re-read one Claude or Codex account's quota usage (weekly, 5-hour, 24-hour %) from local state now, instead of waiting for the next scheduled read. usage-api never asks Anthropic or ChatGPT for usage: the numbers come from what CLIProxyAPI saw on the account's latest real request and from what CPA Manager's auto-ping last recorded, so this cannot make them newer than those sources are. It does not use or redeem reset credits, reset any provider quota, or touch CLIProxyAPI cooldown or routing. Returns when the read ran, when each window was observed and by which source, and freshness: fresh only if the numbers are recent; otherwise the last known values marked stale with their age, or unavailable if there are none. One account per call; no batch or wildcard.",
    inputSchema: { type: "object", additionalProperties: false, required: ["account"], properties: {
      account: { type: "string", pattern: "^(claude|codex)\\d*$", description: "Exactly one account key from list_accounts, such as claude3 or codex2." },
    } },
    annotations: { title: "Refresh one account's usage", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
] as const;

const ACCOUNT_KEY = /^(claude|codex)\d*$/;
const round = (n: number) => Math.round(n * 10) / 10;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function hoursUntil(iso: string | null | undefined, now: number): number | null {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? round(Math.max(0, (at - now) / 3_600_000)) : null;
}

function windowSummary(w: any, now: number) {
  if (!w || typeof w !== "object") return null;
  const used = num(w.used_percent ?? w.utilization) ?? 0;
  const expected = num(w.expected_percent);
  return {
    used_percent: round(used),
    remaining_percent: round(Math.max(0, 100 - used)),
    resets_at: w.resets_at ?? null,
    hours_until_reset: hoursUntil(w.resets_at, now),
    // Where an even burn across the window would be by now; positive pace_slack = under pace.
    expected_percent: expected === null ? null : round(expected),
    pace_slack: num(w.slack) === null ? null : round(w.slack),
    // When this number was observed and where it was read from (proxy_headers, manager_snapshot, auto_ping).
    ...(typeof w.as_of === "string" ? { observed_at: w.as_of, source: typeof w.source === "string" ? w.source : null } : {}),
  };
}

function status(p: ProviderSnapshot) {
  return {
    staleness: p.staleness ?? "stale",
    age_minutes: num(p.ageSec) === null ? null : round((p.ageSec as number) / 60),
    fetched_at: p.fetchedAt ?? null,
    error: p.error ?? null,
  };
}

export function summarizeAccount(key: string, p: ProviderSnapshot, now = Date.now()) {
  const d = p.data ?? null;
  const family = p.account?.family ?? key.replace(/\d+$/, "");
  const perModel: Record<string, unknown> = {};
  if (d && family === "claude") {
    for (const [field, label] of [["seven_day_sonnet", "sonnet"], ["seven_day_opus", "opus"], ["seven_day_design", "design"], ["seven_day_fable", "fable"]] as const) {
      const w = windowSummary(d[field], now);
      if (w) perModel[label] = w;
    }
  }
  return {
    account: key,
    // Configured routing metadata only; zero is explicit, unknown stays null.
    priority: num(p.account?.priority),
    provider: family,
    email: p.account?.name ?? null,
    plan: d?.subscription_type ?? d?.plan_type ?? null,
    // null when the account has no weekly limit (a Codex account reporting only a 24-hour window).
    weekly: d ? windowSummary(d.seven_day, now) : null,
    // null when the account has no 5-hour window (many Claude accounts) or none is open.
    five_hour: d ? windowSummary(d.five_hour, now) : null,
    // Codex only: a 24-hour window, null when OpenAI reports none.
    ...(family === "codex" ? { one_day: d ? windowSummary(d.one_day, now) : null } : {}),
    ...(Object.keys(perModel).length ? { weekly_by_model: perModel } : {}),
    // Read-only count of reset credits; nothing here can use one.
    reset_credits: d?.reset_credits ? {
      available: num(d.reset_credits.available_count) ?? 0,
      // Claude only: weekly clears the account-wide weekly limit, fable only the Fable one.
      ...(family === "claude" && num(d.reset_credits.weekly_available) != null ? {
        weekly_available: num(d.reset_credits.weekly_available) ?? 0,
        fable_available: num(d.reset_credits.fable_available) ?? 0,
        other_available: num(d.reset_credits.other_available) ?? 0,
      } : {}),
      next_expires_at: d.reset_credits.next_expires_at ?? null,
    } : null,
    // Next subscription billing date: the provider's own (Codex) or one set by hand; null if unknown or it will not renew.
    renewal: p.renewal ?? null,
    // When the subscription ends instead of renewing; null when it renews (or nothing says otherwise).
    expiry: p.expiry ?? null,
    status: status(p),
  };
}

function withProxy(a: ReturnType<typeof summarizeAccount>, proxy: ProxyAccountStatus[] | null) {
  const match = proxy?.find(x => x.provider === a.provider && x.email && x.email === a.email?.toLowerCase());
  if (!match) return a;
  const { provider: _p, email: _e, ...rest } = match;
  return { ...a, proxy: rest };
}

function accounts(ctx: ToolContext, provider?: string) {
  const now = (ctx.now ?? Date.now)();
  return Object.entries(ctx.getProviders())
    .filter(([key, p]) => ACCOUNT_KEY.test(key) && (!provider || (p.account?.family ?? key.replace(/\d+$/, "")) === provider))
    .map(([key, p]) => withProxy(summarizeAccount(key, p, now), ctx.getProxyAccounts()));
}

const MAIN_WINDOWS = new Set(["weekly", "five_hour", "one_day"]);

/** refresh_usage result: poll outcome, freshness that is only "fresh" when this call's check succeeded, per-window observation times. */
export function refreshResult(key: string, { outcome, snapshot }: UsageRefresh, now: number) {
  const summary = summarizeAccount(key, snapshot, now);
  const hasData = snapshot.data != null;
  // A local read always "works"; the numbers are fresh only if their own observation time is recent.
  const freshness = !hasData ? "unavailable" : outcome.ok && (snapshot.staleness ?? "fresh") === "fresh" ? "fresh" : "stale";
  // Passive data (CPA request headers) covers only the main windows; the rest come from the last active check.
  const observedAt = (window: string) => snapshot.dataSource === "passive" && MAIN_WINDOWS.has(window)
    ? snapshot.observedAt ?? null : snapshot.activeFetchedAt ?? snapshot.fetchedAt ?? null;
  const at = (iso: string | null) => (iso && Number.isFinite(Date.parse(iso)) ? round((now - Date.parse(iso)) / 60_000) : null);
  const windows: Record<string, unknown> = {};
  if (hasData) {
    for (const name of ["weekly", "five_hour", "one_day"] as const) {
      const w = (summary as any)[name];
      if (w) { const seen = w.observed_at ?? observedAt(name); windows[name] = { ...w, observed_at: seen, age_minutes: at(seen) }; }
    }
    for (const [model, w] of Object.entries((summary as any).weekly_by_model ?? {}))
      windows[`weekly_${model}`] = { ...(w as object), observed_at: observedAt(model), age_minutes: at(observedAt(model)) };
  }
  return {
    account: key, provider: summary.provider, email: summary.email,
    freshness,
    poll: {
      attempted: outcome.attempted, attempted_at: outcome.attemptedAt, ok: outcome.ok, error: outcome.error,
      skipped_reason: outcome.skippedReason, next_allowed_at: outcome.retryAt, min_interval_seconds: outcome.minIntervalSec,
    },
    last_active_check_at: snapshot.activeFetchedAt ?? null,
    last_passive_headers_at: snapshot.observedAt ?? null,
    data_age_minutes: hasData ? at(snapshot.fetchedAt ?? null) : null,
    windows: hasData ? windows : null,
    plan: summary.plan,
    reset_credits: summary.reset_credits,
    note: freshness === "fresh"
      ? "Read from local state just now (no provider was asked); see each window's observed_at for how old its number is. Nothing was reset and proxy cooldowns were not touched."
      : freshness === "stale"
        ? "Local state has nothing newer (see poll); these are the last known values, with their age. No provider was asked; nothing was reset."
        : "No usage data is available for this account yet, and this call did not get any (see poll).",
  };
}

export function suggest(list: ReturnType<typeof summarizeAccount>[]) {
  const ranked = list.map(a => {
    const weekly = a.weekly;
    const five = (a as any).five_hour as ReturnType<typeof windowSummary> | undefined;
    const day = (a as any).one_day as ReturnType<typeof windowSummary> | undefined;
    // The window that bounds the account over days: the weekly limit, or the 24-hour one where
    // there is no weekly limit.
    const main = weekly ?? day ?? null;
    let blocked: string | null = null;
    if (!main) blocked = "no usage data yet";
    else if (weekly && weekly.remaining_percent <= 0) blocked = "weekly limit reached";
    else if (day && day.remaining_percent <= 0) blocked = "24-hour limit reached";
    else if (five && five.remaining_percent <= 0) blocked = "5-hour limit reached";
    const days = main?.hours_until_reset == null ? null : Math.max(main.hours_until_reset / 24, 1 / 24);
    return {
      account: a.account, provider: a.provider, email: a.email,
      usable_now: !blocked, blocked_reason: blocked,
      ranked_by: weekly ? "weekly" : day ? "one_day" : null,
      weekly_remaining_percent: weekly?.remaining_percent ?? null,
      ...(day ? { one_day_remaining_percent: day.remaining_percent, one_day_resets_at: day.resets_at } : {}),
      ...(five ? { five_hour_remaining_percent: five.remaining_percent, five_hour_resets_at: five.resets_at } : {}),
      weekly_resets_at: weekly?.resets_at ?? null,
      spare_percent_per_day: main && days ? round(main.remaining_percent / days) : null,
      pace_slack: main?.pace_slack ?? null,
      reset_credits_available: a.reset_credits?.available ?? null,
      data_staleness: a.status.staleness,
      headroom: main?.remaining_percent ?? 0,
    };
  });
  ranked.sort((x, y) => Number(y.usable_now) - Number(x.usable_now)
    || Number(x.data_staleness === "stale") - Number(y.data_staleness === "stale")
    || y.headroom - x.headroom
    || (y.spare_percent_per_day ?? 0) - (x.spare_percent_per_day ?? 0));
  return ranked.map(({ headroom: _h, ...r }) => r);
}

const ok = (data: Record<string, unknown>) => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
const fail = (code: string, message: string) => ({ content: [{ type: "text", text: JSON.stringify({ error: code, message }) }], structuredContent: { error: code, message }, isError: true });

export async function callTool(name: string, rawArgs: unknown, ctx: ToolContext) {
  const args: Record<string, any> = rawArgs && typeof rawArgs === "object" ? rawArgs as any : {};
  const now = (ctx.now ?? Date.now)();
  const provider = args.provider;
  if (provider !== undefined && provider !== "claude" && provider !== "codex") return fail("invalid_argument", "provider must be claude or codex.");
  try {
    if (name === "list_accounts") {
      const providers = ctx.getProviders();
      const others = Object.entries(providers).filter(([key]) => !ACCOUNT_KEY.test(key))
        .map(([key, p]) => ({ provider: key, has_data: p.data != null, ...(p.data == null && p.error ? { note: p.error } : {}) }));
      const proxy = ctx.getProxyAccounts();
      const paused = proxy === null ? null : proxy.filter(a => !a.enabled).map(a => ({ provider: a.provider, email: a.email }));
      return ok({
        analytics: ctx.getAnalytics ? await ctx.getAnalytics().catch(() => null) : null,
        as_of: new Date(now).toISOString(),
        accounts: accounts(ctx, provider),
        paused_on_proxy: paused === null ? null : paused.filter(a => !provider || a.provider === provider),
        other_providers: provider ? [] : others,
        notes: "reset_credits.available is a read-only count; no tool can use a reset. For Claude, weekly_available resets clear the account-wide weekly limit, fable_available ones only the Fable weekly limit, and other_available counts grants of an unrecognized kind. Codex and some Claude accounts have a 5-hour window as well as the weekly one; five_hour is null for accounts without one (or with no open session). Codex accounts can also report a 24-hour window (one_day; usually null); weekly is null if an account reports no weekly limit. pace_slack > 0 means under an even pace for that window. renewal is the next subscription billing date (America/Chicago calendar date): source provider means ChatGPT reported it (Codex), manual means it was entered by hand (Claude reports none); null if unknown or the plan will not renew. expiry is set when the subscription will end instead of renewing: expires_at is the last day (America/Chicago), days_until_expiry goes negative once passed, source provider means ChatGPT reported it (Codex), manual means it was entered by hand (Claude reports no end date); null means no end is known. paused_on_proxy is null when the proxy list is unavailable.",
      });
    }
    if (name === "get_usage") {
      if (typeof args.account !== "string" || !args.account) return fail("invalid_argument", "account is required.");
      const p = ctx.getProviders()[args.account];
      if (!p) return fail("not_found", "No account or provider with that key. Use list_accounts.");
      if (ACCOUNT_KEY.test(args.account)) return ok({ ...summarizeAccount(args.account, p, now), raw: p.data ?? null });
      return ok({ provider: args.account, data: p.data ?? null, status: status(p) });
    }
    if (name === "suggest_account") {
      return ok({ as_of: new Date(now).toISOString(), ranking: suggest(accounts(ctx, provider)) });
    }
    if (name === "usage_history") {
      if (typeof args.account !== "string" || !ACCOUNT_KEY.test(args.account)) return fail("invalid_argument", "account must be a Claude or Codex key such as claude or codex2.");
      const days = args.days === undefined ? 7 : args.days;
      if (!Number.isInteger(days) || days < 1 || days > 30) return fail("invalid_argument", "days must be an integer from 1 to 30.");
      const granularity = args.granularity === undefined ? "hourly" : args.granularity;
      if (granularity !== "hourly" && granularity !== "daily") return fail("invalid_argument", "granularity must be hourly or daily.");
      const cutoff = now - days * 86_400_000;
      const series = ctx.getHistory(granularity).series
        .filter(s => s.provider === args.account && (s.metric === "seven_day" || s.metric === "one_day" || s.metric === "five_hour"))
        .map(s => ({ metric: s.metric === "seven_day" ? "weekly" : s.metric,
          points: s.points.filter(pt => Date.parse(pt.t) >= cutoff).slice(-400)
            .map(pt => ({ t: pt.t, used_percent: pt.value, ...(pt.expectedValue === undefined ? {} : { expected_percent: pt.expectedValue }) })) }));
      return ok({ account: args.account, granularity, days, series });
    }
    if (name === "recent_requests") {
      const hours = args.hours === undefined ? 24 : args.hours;
      if (!Number.isInteger(hours) || hours < 1 || hours > 168) return fail("invalid_argument", "hours must be an integer from 1 to 168.");
      const [recent, activity] = await Promise.all([ctx.getRecent(), ctx.getActivity(hours)]);
      return ok({
        available: recent !== null || activity !== null,
        by_account: activity,
        latest: (recent ?? []).map(r => ({ at: r.startedAt, model: r.model, effort: r.jev.effort, outcome: r.outcome })),
        notes: "by_account counts at most the newest 1000 requests in the window; total_in_window is the proxy's full count.",
      });
    }
    if (name === "clear_proxy_cooldown") {
      const extra = Object.keys(args).filter(k => k !== "account");
      if (extra.length) return fail("invalid_argument", "Only account is accepted (one account key).");
      if (typeof args.account !== "string" || !ACCOUNT_KEY.test(args.account))
        return fail("invalid_argument", "account must be exactly one Claude or Codex key from list_accounts, such as claude3 or codex2.");
      if (!ctx.getProviders()[args.account]) return fail("not_found", "No tracked account with that key. Use list_accounts.");
      if (!ctx.clearProxyCooldown) return fail("unavailable", "CLIProxyAPI is not configured on usage-api.");
      try {
        const cleared = await ctx.clearProxyCooldown(args.account);
        return ok({ account: args.account, cleared: true, ...cleared,
          note: "Only CLIProxyAPI's runtime cooldown for this credential was cleared. Upstream provider quota is unchanged; if the account is still out of quota, its next request will put it back into cooldown." });
      } catch (err) {
        if (err instanceof CooldownError) return fail(err.code, err.message);
        throw err;
      }
    }
    if (name === "list_models") {
      if (Object.keys(args).length) return fail("invalid_argument", "list_models takes no arguments.");
      if (!ctx.listModels) return fail("unavailable", "CLIProxyAPI is not configured on usage-api.");
      try {
        const list = await ctx.listModels();
        return ok({ ...list, source: "GET /v1/models on CLIProxyAPI (fresh fetch; not a forced upstream catalog refresh)" });
      } catch (err) {
        if (err instanceof ProxyModelsError) return fail(err.code, err.message);
        throw err;
      }
    }
    if (name === "refresh_usage") {
      const extra = Object.keys(args).filter(k => k !== "account");
      if (extra.length) return fail("invalid_argument", "Only account is accepted (one account key).");
      if (typeof args.account !== "string" || !ACCOUNT_KEY.test(args.account))
        return fail("invalid_argument", "account must be exactly one Claude or Codex key from list_accounts, such as claude3 or codex2.");
      if (!ctx.getProviders()[args.account]) return fail("not_found", "No tracked account with that key. Use list_accounts.");
      if (!ctx.refreshUsage) return fail("unavailable", "On-demand refresh is not available on this server.");
      const refreshed = await ctx.refreshUsage(args.account);
      if (!refreshed) return fail("not_found", "No tracked account with that key. Use list_accounts.");
      return ok(refreshResult(args.account, refreshed, (ctx.now ?? Date.now)()));
    }
    return fail("unknown_tool", "Unknown tool.");
  } catch {
    return fail("internal_error", "usage-api could not complete the request.");
  }
}
