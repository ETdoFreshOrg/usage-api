// Read-only MCP tools over the usage snapshot. Every tool reads data usage-api
// already holds in memory (or its recent-request cache); none of them can pause
// accounts, spend reset credits or change anything on CLIProxyAPI.
import type { HistorySeriesResponse, HistoryGranularity } from "./history.js";
import type { RecentExchange, ActivitySummary } from "./recent.js";
import type { ProxyAccountStatus } from "./providers/cliproxy.js";

export const SCOPE = "usage.read";

export interface ProviderSnapshot {
  data?: any;
  fetchedAt?: string | null;
  ageSec?: number | null;
  staleness?: string;
  error?: string | null;
  nextFetchAt?: string;
  account?: { id: string; name: string; family: string };
  renewal?: { renews_at: string; billing_cycle: string; days_until_renewal: number; source: "manual" } | null;
  expiry?: { expires_at: string; days_until_expiry: number; source: "provider" | "manual"; ends_at: string | null } | null;
}

export interface ToolContext {
  getAnalytics?: () => Promise<unknown>;
  getProviders: () => Record<string, ProviderSnapshot>;
  getProxyAccounts: () => ProxyAccountStatus[] | null;
  getActivity: (hours: number) => Promise<ActivitySummary | null>;
  getHistory: (granularity: HistoryGranularity) => HistorySeriesResponse;
  getRecent: () => Promise<RecentExchange[] | null>;
  now?: () => number;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const tools = [
  {
    name: "list_accounts",
    description: "Every Claude and Codex account usage-api is tracking, with weekly usage %, when the week resets, how far ahead or behind an even pace it is, the 5-hour window (Codex, and Claude accounts that have one; null otherwise), the 24-hour window (one_day, Codex accounts that report one; usually null), how many reset credits each account has (count only; nothing here uses one), the next subscription renewal date (set manually on usage-api; null if unknown), the subscription end date if the account will expire instead of renewing (from ChatGPT for Codex, entered by hand otherwise; null if none), whether the numbers are fresh, and the account's status on the CLIProxyAPI proxy. Also lists accounts that are paused (disabled) on the proxy, and which other providers (Z.ai, OpenRouter, OpenAI, Jev) have data. Read-only.",
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
    // Next subscription billing date, set by hand on usage-api; null if unset.
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
        notes: "reset_credits.available is a read-only count; no tool can use a reset. For Claude, weekly_available resets clear the account-wide weekly limit, fable_available ones only the Fable weekly limit, and other_available counts grants of an unrecognized kind. Codex and some Claude accounts have a 5-hour window as well as the weekly one; five_hour is null for accounts without one (or with no open session). Codex accounts can also report a 24-hour window (one_day; usually null); weekly is null if an account reports no weekly limit. pace_slack > 0 means under an even pace for that window. renewal is the next subscription billing date (America/Chicago calendar date) entered by hand, or null if unset. expiry is set when the subscription will end instead of renewing: expires_at is the last day (America/Chicago), days_until_expiry goes negative once passed, source provider means ChatGPT reported it (Codex), manual means it was entered by hand (Claude reports no end date); null means no end is known. paused_on_proxy is null when the proxy list is unavailable.",
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
    return fail("unknown_tool", "Unknown tool.");
  } catch {
    return fail("internal_error", "usage-api could not complete the request.");
  }
}
