/**
 * Codex usage, read straight from OpenAI with a token borrowed from 9router.
 *
 * Window classification is the load-bearing detail here. OpenAI's
 * primary_window / secondary_window slots are positional, not semantic: a
 * seven-day window routinely arrives in `primary_window` with
 * `secondary_window` null. So five_hour / one_day (24 h) / seven_day is
 * decided by `limit_window_seconds`, never by slot order.
 *
 * That is also why this does not read 9router's own /api/usage endpoint.
 * 9router maps those slots by position into names like "session", and drops
 * `limit_window_seconds` entirely — so a seven-day window at 100% would be
 * reported as a five-hour one, with nothing left in the payload to detect
 * the mistake.
 *
 * usage-api owns no Codex credential: 9router holds the OAuth account and
 * refreshes the token, and this module only reads it.
 */
import { throwIfRateLimited } from "../cache.js";
import { classifyCodexWindows, CodexWindow, CodexWindows } from "../codex-windows.js";
import { findConnection, RouterConnection } from "./ninerouter.js";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

export type { CodexWindow } from "../codex-windows.js";

export interface CodexAdditionalLimit {
  name: string;
  metered_feature: string | null;
  five_hour: CodexWindow | null;
  one_day: CodexWindow | null;
  seven_day: CodexWindow | null;
  /** @deprecated Compatibility alias for five_hour. */
  primary: CodexWindow | null;
  /** @deprecated Compatibility alias for seven_day. */
  secondary: CodexWindow | null;
}

export interface CodexResetCredit {
  status: string | null;
  granted_at: string | null;
  expires_at: string | null;
}

export interface CodexResetCredits {
  available_count: number;
  next_expires_at: string | null;
  credits: CodexResetCredit[];
}

export interface CodexUsage {
  plan_type: string | null;
  five_hour: CodexWindow | null;
  /** A 24-hour window; null when OpenAI reports none (the usual case). */
  one_day: CodexWindow | null;
  seven_day: CodexWindow | null;
  /** @deprecated Compatibility alias for five_hour. */
  primary: CodexWindow | null;
  /** @deprecated Compatibility alias for seven_day. */
  secondary: CodexWindow | null;
  additional: CodexAdditionalLimit[];
  credits_balance: string | null;
  // null when reset-credits couldn't be fetched (best-effort call).
  reset_credits: CodexResetCredits | null;
}

type RawWindow = { used_percent?: number; limit_window_seconds?: number; reset_at?: number } | null;
type RawRateLimit = { primary_window?: RawWindow; secondary_window?: RawWindow } | undefined;

export interface RawCodexUsageResponse {
  plan_type?: string;
  rate_limit?: RawRateLimit;
  additional_rate_limits?: Array<{
    limit_name?: string;
    metered_feature?: string;
    rate_limit?: RawRateLimit;
  }>;
  credits?: { unlimited?: boolean; balance?: string };
  // Summary count only; the per-credit expiry detail needs the separate
  // rate-limit-reset-credits endpoint.
  rate_limit_reset_credits?: { available_count?: number };
}

export interface RawResetCreditsResponse {
  credits?: Array<{
    status?: string;
    granted_at?: string;
    expires_at?: string;
  }>;
  available_count?: number;
}

function parseWindow(w: RawWindow | undefined): CodexWindow | null {
  if (!w || typeof w.used_percent !== "number") return null;
  return {
    used_percent: w.used_percent,
    resets_at: w.reset_at ? new Date(w.reset_at * 1000).toISOString() : null,
    window_minutes: w.limit_window_seconds ? Math.round(w.limit_window_seconds / 60) : 0,
  };
}

function classifyWindows(rateLimit: RawRateLimit): CodexWindows {
  return classifyCodexWindows([parseWindow(rateLimit?.primary_window), parseWindow(rateLimit?.secondary_window)]);
}

export function parseCodexUsage(json: RawCodexUsageResponse): Omit<CodexUsage, "reset_credits"> {
  const windows = classifyWindows(json.rate_limit);
  const additional: CodexAdditionalLimit[] = (json.additional_rate_limits ?? []).map((a) => {
    const classified = classifyWindows(a.rate_limit);
    return {
      name: a.limit_name ?? "unknown",
      metered_feature: a.metered_feature ?? null,
      ...classified,
      primary: classified.five_hour,
      secondary: classified.seven_day,
    };
  });
  return {
    plan_type: json.plan_type ?? null,
    ...windows,
    primary: windows.five_hour,
    secondary: windows.seven_day,
    additional,
    credits_balance: json.credits?.unlimited ? "unlimited" : json.credits?.balance ?? null,
  };
}

export function parseResetCredits(json: RawResetCreditsResponse): CodexResetCredits {
  const credits: CodexResetCredit[] = (json.credits ?? []).map((c) => ({
    status: c.status ?? null,
    granted_at: c.granted_at ?? null,
    expires_at: c.expires_at ?? null,
  }));
  const nextExpiry = credits
    .filter((c) => c.status === "available" && c.expires_at)
    .map((c) => c.expires_at as string)
    .sort()[0] ?? null;
  return {
    available_count: json.available_count ?? credits.filter((c) => c.status === "available").length,
    next_expires_at: nextExpiry,
    credits,
  };
}

// Without ChatGPT-Account-ID, wham/usage answers for an empty account context
// (account_id "") that can read 100% used while the real workspace has quota.
function authHeaders(token: string, accountId?: string | null): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": "codex-cli",
    Accept: "application/json",
    ...(accountId ? { "ChatGPT-Account-ID": accountId } : {}),
  };
}

export interface CodexUsageFetcherOptions {
  fetchImpl?: typeof fetch;
  resolveConnection?: (account?: string) => RouterConnection;
}

export function createCodexUsageFetcher(
  options: CodexUsageFetcherOptions = {},
): (account?: string) => Promise<CodexUsage> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolve = options.resolveConnection ?? ((account?: string) => findConnection("codex", account));

  // The usage response already reports how many resets are available, so the
  // detail call is only worth making when there is at least one to describe.
  async function fetchResetCredits(headers: Record<string, string>, availableCount: number): Promise<CodexResetCredits | null> {
    if (availableCount <= 0) {
      return { available_count: availableCount, next_expires_at: null, credits: [] };
    }
    try {
      const res = await fetchImpl(RESET_CREDITS_URL, { headers });
      if (!res.ok) return null;
      return parseResetCredits((await res.json()) as RawResetCreditsResponse);
    } catch {
      return null;
    }
  }

  return async function fetchCodexUsage(account?: string): Promise<CodexUsage> {
    const connection = resolve(account);
    const headers = authHeaders(connection.accessToken, connection.accountId);
    const res = await fetchImpl(USAGE_URL, { headers });
    throwIfRateLimited(res);
    if (!res.ok) {
      throw new Error(`codex usage HTTP ${res.status} ${await res.text().catch(() => "")}`);
    }
    const json = (await res.json()) as RawCodexUsageResponse;
    return {
      ...parseCodexUsage(json),
      reset_credits: await fetchResetCredits(
        headers,
        json.rate_limit_reset_credits?.available_count ?? 0,
      ),
    };
  };
}

export const fetchCodexUsage = createCodexUsageFetcher();
