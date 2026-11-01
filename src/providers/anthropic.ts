/**
 * Claude usage, read straight from Anthropic with a token borrowed from
 * 9router.
 *
 * GET /api/oauth/usage is the same endpoint Claude Code itself calls, so the
 * numbers here are Anthropic's own rather than anything inferred. That
 * matters most for the per-model weekly limit: Anthropic reports it as a
 * `weekly_scoped` entry in `limits[]`, which is a different figure from the
 * account-wide weekly window. The previous CLIProxyAPI-backed version read a
 * model's cached `Anthropic-Ratelimit-Unified-7d-Utilization` header and
 * labelled it "fable", but that header is the account-wide weekly value as
 * it stood when that model last ran — so Fable read roughly double its real
 * usage.
 *
 * usage-api still owns no Claude credential: 9router holds the OAuth account
 * and refreshes the token, and this module only reads it.
 */
import { findConnection } from "./ninerouter.js";
import { throwIfRateLimited } from "../cache.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const OAUTH_BETA = "oauth-2025-04-20";
// Limit-reset grants ("cedar_ember") are only reported to a current Claude Code
// CLI; other user agents get ineligible_reason "surface" / "cli_version".
// ponytail: pinned version string; bump CLAUDE_CLI_VERSION when grants report cli_version.
const RESETS_URL = `${USAGE_URL}?cedar_ember=1`;
const CLI_USER_AGENT = `claude-cli/${process.env.CLAUDE_CLI_VERSION ?? "2.1.281"} (external, cli)`;

export interface ClaudeWindow {
  utilization: number;
  resets_at: string | null;
}

// Same shape as Codex reset_credits so clients render both identically.
export interface ClaudeResetCredit {
  status: string | null;
  granted_at: string | null;
  expires_at: string | null;
  label: string | null;
}

export interface ClaudeResetCredits {
  available_count: number;
  next_expires_at: string | null;
  credits: ClaudeResetCredit[];
}

// Claude dropped its 5-hour limit (Nov 2026), so only weekly windows are reported.
export interface ClaudeUsage {
  seven_day: ClaudeWindow;
  seven_day_sonnet: ClaudeWindow | null;
  seven_day_opus: ClaudeWindow | null;
  // "Claude Design" in the web UI; the API ships it under the `omelette` codename.
  seven_day_design: ClaudeWindow | null;
  // Per-model weekly limit from the `limits[]` array (scope.model "Fable").
  seven_day_fable: ClaudeWindow | null;
  subscription_type: string | null;
  // null when the grants call failed or the account is ineligible.
  reset_credits: ClaudeResetCredits | null;
  // 9router providerConnections.id, so consumers (9gate claude-wake) can match
  // an account without calling Anthropic themselves.
  connection_id?: string;
}

// Newer responses carry per-model usage in a `limits` array instead of the
// legacy `seven_day_<model>` fields (which now come back null): entries with
// kind "weekly_scoped" scope a weekly window to one model via
// scope.model.display_name (e.g. "Fable").
interface RawLimit {
  kind?: string;
  group?: string;
  percent?: number;
  resets_at?: string;
  is_active?: boolean;
  scope?: { model?: { display_name?: string | null } | null } | null;
}

type RawWindow = { utilization?: number; resets_at?: string } | null;

export interface RawUsageResponse {
  five_hour?: RawWindow;
  seven_day?: RawWindow;
  seven_day_sonnet?: RawWindow;
  seven_day_opus?: RawWindow;
  seven_day_omelette?: RawWindow;
  limits?: RawLimit[];
}

/** True when a usage body carries the weekly window, directly or as a `weekly_all` limit. */
export function hasWeeklyWindow(json: RawUsageResponse): boolean {
  return "seven_day" in json || (json.limits ?? []).some((l) => l?.kind === "weekly_all");
}

export interface RawResetGrants {
  eligible?: boolean;
  grants?: Array<{
    label?: string;
    resets_left?: number;
    starts_at?: string;
    ends_at?: string;
    paused?: boolean;
  }>;
}

export function parseClaudeResetCredits(json: RawResetGrants | null | undefined): ClaudeResetCredits | null {
  if (!json || !json.eligible) return null;
  const credits: ClaudeResetCredit[] = [];
  for (const g of json.grants ?? []) {
    const left = Math.max(0, g.resets_left ?? 0);
    for (let i = 0; i < left; i++) {
      credits.push({
        status: g.paused ? "paused" : "available",
        granted_at: g.starts_at ?? null,
        expires_at: g.ends_at ?? null,
        label: g.label ?? null,
      });
    }
  }
  const available = credits.filter((c) => c.status === "available");
  return {
    available_count: available.length,
    next_expires_at: available.map((c) => c.expires_at).filter((e): e is string => !!e).sort()[0] ?? null,
    credits,
  };
}

export function parseClaudeUsage(
  json: RawUsageResponse,
  subscriptionType: string | null,
  resetCredits: ClaudeResetCredits | null = null,
): ClaudeUsage {
  const win = (w: RawWindow): ClaudeWindow => ({
    utilization: w?.utilization ?? 0,
    resets_at: w?.resets_at ?? null,
  });
  const optWin = (w: RawWindow): ClaudeWindow | null => (w ? win(w) : null);

  // Model-scoped weekly windows, keyed by lowercased display name.
  const scoped = new Map<string, ClaudeWindow>();
  let weeklyAll: ClaudeWindow | null = null;
  for (const limit of json.limits ?? []) {
    if (limit?.kind === "weekly_all" && typeof limit.percent === "number")
      weeklyAll = { utilization: limit.percent, resets_at: limit.resets_at ?? null };
    if (limit?.kind !== "weekly_scoped") continue;
    if (typeof limit.percent !== "number") continue;
    const name = limit.scope?.model?.display_name;
    if (typeof name !== "string" || !name) continue;
    scoped.set(name.toLowerCase(), {
      utilization: limit.percent,
      resets_at: limit.resets_at ?? null,
    });
  }

  return {
    seven_day: json.seven_day ? win(json.seven_day) : weeklyAll ?? win(null),
    seven_day_sonnet: optWin(json.seven_day_sonnet ?? null) ?? scoped.get("sonnet") ?? null,
    seven_day_opus: optWin(json.seven_day_opus ?? null) ?? scoped.get("opus") ?? null,
    seven_day_design: optWin(json.seven_day_omelette ?? null)
      ?? scoped.get("claude design") ?? scoped.get("design") ?? null,
    seven_day_fable: scoped.get("fable") ?? null,
    subscription_type: subscriptionType,
    reset_credits: resetCredits,
  };
}

// Subscription tier changes about never, so this is cached far beyond the
// poll interval; a stale label is much cheaper than a round trip per tick.
const PROFILE_TTL_MS = 30 * 60_000;

interface AnthropicProfile {
  account?: { has_claude_max?: boolean; has_claude_pro?: boolean };
  organization?: { organization_type?: string; rate_limit_tier?: string };
}

const profileCache = new Map<string, { at: number; label: string | null }>();

// Anthropic spreads the plan across three fields and none of them is a display
// string: has_claude_max/has_claude_pro pick the family, while rate_limit_tier
// is the only place the Max multiplier appears (e.g. "...claude_max_20x").
// Match on the multiplier substring so a prefix change upstream doesn't matter.
export function planLabel(profile: AnthropicProfile): string | null {
  const account = profile.account ?? {};
  const tier = profile.organization?.rate_limit_tier ?? "";
  if (account.has_claude_max) {
    if (/20x/i.test(tier)) return "Max 20x";
    if (/5x/i.test(tier)) return "Max 5x";
    return "Max";
  }
  if (account.has_claude_pro) return "Pro";
  const orgType = profile.organization?.organization_type ?? "";
  if (/enterprise/i.test(orgType)) return "Enterprise";
  if (/team/i.test(orgType)) return "Team";
  return null;
}

// The usage endpoint carries no tier at all, so the label needs this second
// request. Best-effort: the tier is a label, never a measurement, so a
// failure here degrades to the last known value (or null) rather than
// failing the whole poll.
async function fetchSubscriptionType(connectionId: string, token: string): Promise<string | null> {
  const cached = profileCache.get(connectionId);
  if (cached && Date.now() - cached.at < PROFILE_TTL_MS) return cached.label;
  try {
    const res = await fetch(PROFILE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_BETA,
        Accept: "application/json",
      },
    });
    if (!res.ok) return cached?.label ?? null;
    const label = planLabel((await res.json()) as AnthropicProfile);
    profileCache.set(connectionId, { at: Date.now(), label });
    return label;
  } catch {
    return cached?.label ?? null;
  }
}

export async function fetchClaudeUsage(account?: string): Promise<ClaudeUsage> {
  const connection = findConnection("claude", account);
  // One request: cedar_ember=1 adds the limit-reset grants to the normal usage body.
  const res = await fetch(RESETS_URL, {
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
      "anthropic-beta": OAUTH_BETA,
      "User-Agent": CLI_USER_AGENT,
      Accept: "application/json",
    },
  });
  throwIfRateLimited(res);
  if (!res.ok) {
    throw new Error(`anthropic oauth/usage HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  const json = (await res.json()) as RawUsageResponse & { cedar_ember?: RawResetGrants };
  return {
    ...parseClaudeUsage(
      json,
      await fetchSubscriptionType(connection.id, connection.accessToken),
      parseClaudeResetCredits(json.cedar_ember),
    ),
    connection_id: connection.id,
  };
}
