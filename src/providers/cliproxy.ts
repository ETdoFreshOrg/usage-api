import { RateLimitError, throwIfRateLimited } from "../cache.js";
import { PassiveObservation, readObservation } from "../passive.js";
import { parseClaudeUsage, parseClaudeResetCredits, planLabel, hasWeeklyWindow, claudeSubscription, ClaudeSubscription } from "./anthropic.js";
import { parseCodexUsage, parseResetCredits, parseCodexSubscription, CodexSubscription, ACCOUNTS_CHECK_URL } from "./codex.js";

export interface ProxyAccount {
  id: string;
  provider: string;
  name: string;
  email: string | null;
  authIndex: string;
  accountId: string | null;
  /** CPA's routing priority for this account; null when none is set. */
  priority: number | null;
  /** Rate-limit headers from the account's latest request through CPA (see passive.ts). */
  observation: PassiveObservation | null;
}

type AuthFile = {
  id?: string; name?: string; provider?: string; type?: string; email?: string;
  auth_index?: string; disabled?: boolean; id_token?: unknown; priority?: unknown; quota?: unknown;
};

// CPA omits priority when it was never set; a numeric string is accepted in case a build serializes it that way.
function priorityOf(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export interface ProxyAccountStatus {
  provider: string; email: string | null; enabled: boolean;
  status?: string; status_message?: string; unavailable?: boolean; success?: number; failed?: number; next_retry_after?: string | number;
}

// Only plain status fields; tokens (id_token etc.), paths and quotas stay out.
function proxyStatus(provider: string, file: AuthFile): ProxyAccountStatus {
  const f = file as Record<string, unknown>;
  const out: ProxyAccountStatus = { provider, email: file.email?.trim().toLowerCase() || null, enabled: !file.disabled };
  if (typeof f.status === "string") out.status = f.status;
  if (typeof f.status_message === "string" && f.status_message) out.status_message = f.status_message.slice(0, 300);
  if (typeof f.unavailable === "boolean") out.unavailable = f.unavailable;
  if (typeof f.success === "number") out.success = f.success;
  if (typeof f.failed === "number") out.failed = f.failed;
  if (typeof f.next_retry_after === "string" || typeof f.next_retry_after === "number") out.next_retry_after = f.next_retry_after;
  return out;
}

export class CooldownError extends Error {
  constructor(readonly code: "not_found" | "no_match" | "ambiguous" | "disabled" | "proxy_error", message: string,
    readonly candidates: string[] = []) { super(message); }
}

/** Routing state CPA reports for a credential; plain fields only, never tokens. */
export interface CooldownState {
  status: string | null; unavailable: boolean | null; quota_blocked: boolean | null; next_retry_after: string | number | null;
  cooldowns: Array<{ scope: string | null; model: string | null; reason: string | null; retry_at: string | null; http_status: number | null }>;
}

export interface ClearedCooldown {
  provider: string; email: string | null; auth_file: string | null; auth_index: string;
  models_reset: string[]; before: CooldownState; after: CooldownState | null;
}

export function cooldownState(file: AuthFile): CooldownState {
  const f = file as Record<string, any>;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    status: str(f.status),
    unavailable: typeof f.unavailable === "boolean" ? f.unavailable : null,
    quota_blocked: typeof f.quota_blocked === "boolean" ? f.quota_blocked : null,
    next_retry_after: typeof f.next_retry_after === "string" || typeof f.next_retry_after === "number" ? f.next_retry_after : null,
    cooldowns: Array.isArray(f.cooldowns) ? f.cooldowns.filter((c: any) => c && typeof c === "object").slice(0, 50).map((c: any) => ({
      scope: str(c.scope), model: str(c.model_key), reason: str(c.reason), retry_at: str(c.retry_at),
      http_status: typeof c.http_status === "number" ? c.http_status : null })) : [],
  };
}

function accountId(value: unknown): string | null {
  try {
    const token = typeof value === "string" && value.includes(".")
      ? JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString()) : value;
    return (token as any)?.["https://api.openai.com/auth"]?.chatgpt_account_id
      ?? (token as any)?.chatgpt_account_id ?? null;
  } catch { return null; }
}

// The plan tier almost never changes; re-reading it costs an extra upstream call per check.
const PROFILE_TTL_MS = 12 * 3_600_000;
const RESET_DETAIL_TTL_MS = Number(process.env.CODEX_RESET_CREDITS_SECONDS ?? 3 * 3600) * 1000;
// Whether a Codex plan renews changes rarely (a cancel, a resubscribe); check a few times a day.
const SUBSCRIPTION_TTL_MS = Number(process.env.CODEX_SUBSCRIPTION_SECONDS ?? 6 * 3600) * 1000;

export class CliProxyClient {
  private accounts: ProxyAccount[] = [];
  /** Claude/Codex accounts on the proxy, enabled or not, from the last listing (identity and status only, no tokens). */
  proxyAccounts: ProxyAccountStatus[] | null = null;
  private profiles = new Map<string, { at: number; label: string | null; subscription: ClaudeSubscription }>();
  /** Codex subscription state (renews or ends) per account; best effort, kept on a failed re-check. */
  private subscriptions = new Map<string, { at: number; subscription: CodexSubscription | null }>();
  /** Codex reset-credit detail per account; re-read only when the summary count changes or it ages out. */
  private resetDetails = new Map<string, { at: number; count: number; resets: ReturnType<typeof parseResetCredits> }>();
  constructor(private readonly baseUrl: string, private readonly key: string,
    private readonly aliases: Record<string, string> = {}, private readonly fetcher: typeof fetch = fetch) {}

  private async management(path: string, body?: unknown): Promise<any> {
    const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}/v0/management/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(25_000),
    });
    throwIfRateLimited(response);
    if (!response.ok) throw new Error(`CLIProxyAPI ${path} HTTP ${response.status}`);
    return response.json();
  }

  /**
   * Resolve one tracked account (by its usage-api connection id) to exactly one CPA credential, using a
   * fresh credential listing. Matches on provider + email (+ ChatGPT workspace when the account has one),
   * across enabled and disabled files, so a duplicate login is reported instead of guessed between.
   */
  async resolveCredential(id: string): Promise<{ provider: string; email: string | null; file: AuthFile }> {
    const account = this.accounts.find(a => a.id === id);
    if (!account) throw new CooldownError("not_found", "That account is not an active credential on CLIProxyAPI.");
    const result = await this.management("auth-files");
    if (!Array.isArray(result.files)) throw new CooldownError("proxy_error", "CLIProxyAPI returned an invalid credential list.");
    const matches = (result.files as AuthFile[]).filter(f => (f.provider ?? f.type) === account.provider
      && (f.email?.trim().toLowerCase() || null) === account.email
      && (!account.accountId || accountId(f.id_token) === account.accountId));
    const names = matches.map(f => f.name ?? f.id ?? "(unnamed)");
    if (matches.length === 0) throw new CooldownError("no_match", `No CLIProxyAPI credential matches ${account.provider} ${account.email ?? account.name}.`);
    if (matches.length > 1) throw new CooldownError("ambiguous", `More than one CLIProxyAPI credential matches ${account.provider} ${account.email ?? account.name}: ${names.join(", ")}. Nothing was cleared.`, names);
    const [file] = matches;
    if (!file.auth_index) throw new CooldownError("no_match", `CLIProxyAPI credential ${names[0]} has no auth_index.`);
    if (file.disabled) throw new CooldownError("disabled", `CLIProxyAPI credential ${names[0]} is disabled (paused) on the proxy; clearing its cooldown would not re-enable it, so nothing was done.`);
    return { provider: account.provider, email: account.email, file };
  }

  /**
   * Clear CPA's runtime cooldown / quota-exceeded routing state for one credential, via
   * POST /v8/management/routing/cooldown/reset (the maintained route for v0's /reset-quota; same handler).
   * Only that credential's auth_index is sent. Upstream provider quota is not touched (CPA cannot).
   */
  async clearCooldown(id: string): Promise<ClearedCooldown> {
    const { provider, email, file } = await this.resolveCredential(id);
    const authIndex = file.auth_index as string;
    const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}/v8/management/routing/cooldown/reset`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ auth_index: authIndex }),
      signal: AbortSignal.timeout(25_000),
    });
    let body: any = null;
    try { body = await response.json(); } catch { /* non-JSON error page */ }
    if (!response.ok) {
      const detail = typeof body?.error === "string" ? `: ${body.error.split(this.key).join("[redacted]").slice(0, 200)}` : "";
      throw new CooldownError("proxy_error", `CLIProxyAPI cooldown reset HTTP ${response.status}${detail}`);
    }
    if (body?.auth_index !== authIndex) throw new CooldownError("proxy_error", "CLIProxyAPI confirmed a different credential than requested.");
    let after: CooldownState | null = null;
    try {
      const list = await this.management("auth-files");
      const now = Array.isArray(list.files) ? (list.files as AuthFile[]).find(f => f.auth_index === authIndex) : undefined;
      after = now ? cooldownState(now) : null;
    } catch { /* The reset succeeded; the after-read is best effort. */ }
    return { provider, email, auth_file: file.name ?? file.id ?? null, auth_index: authIndex,
      models_reset: Array.isArray(body.models) ? body.models.filter((m: unknown) => typeof m === "string") : [],
      before: cooldownState(file), after };
  }

  async listAccounts(): Promise<ProxyAccount[]> {
    const result = await this.management("auth-files");
    if (!Array.isArray(result.files)) throw new Error("CLIProxyAPI returned an invalid account list");
    const accounts: ProxyAccount[] = [];
    const statuses: ProxyAccountStatus[] = [];
    for (const file of result.files as AuthFile[]) {
      const provider = file.provider ?? file.type;
      if (provider && ["claude", "codex"].includes(provider)) statuses.push(proxyStatus(provider, file));
      if (!provider || !["claude", "codex"].includes(provider) || file.disabled || !file.auth_index) continue;
      const email = file.email?.trim().toLowerCase() || null;
      const workspace = accountId(file.id_token);
      // Preserve public IDs from the previous source and avoid token/file-name changes renumbering accounts.
      const identity = `${provider}:${email ?? file.id ?? file.name}${workspace ? `:${workspace}` : ""}`;
      const legacy = Object.entries(this.aliases).find(([, match]) => match === identity || match === `${provider}:${email}`)?.[0];
      const id = legacy ?? `cpa:${identity}`;
      if (accounts.some(a => a.id === id)) continue;
      accounts.push({ id, provider, email, name: email ?? file.name ?? id, authIndex: file.auth_index, accountId: workspace,
        priority: priorityOf(file.priority), observation: readObservation(file.quota) });
    }
    this.accounts = accounts;
    this.proxyAccounts = statuses;
    return accounts;
  }

  private async providerGet(account: ProxyAccount, url: string, headers: Record<string, string> = {}): Promise<any> {
    const result = await this.management("api-call", {
      authIndex: account.authIndex, method: "GET", url,
      header: { Authorization: "Bearer $TOKEN$", Accept: "application/json", ...headers },
    });
    const status = Number(result.status_code ?? result.statusCode);
    if (status === 429) {
      const header = result.header ?? result.headers ?? {};
      const retry = Object.entries(header).find(([k]) => k.toLowerCase() === "retry-after")?.[1];
      const value = Array.isArray(retry) ? retry[0] : retry;
      const { parseRetryAfter } = await import("../cache.js");
      throw new RateLimitError(parseRetryAfter(value == null ? null : String(value)));
    }
    if (!Number.isFinite(status) || status < 200 || status >= 300)
      throw new Error(`${account.provider} usage via CLIProxyAPI HTTP ${status || "unknown"}`);
    const body = typeof result.body === "string" ? JSON.parse(result.body) : result.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid provider usage response");
    return body;
  }

  async fetchUsage(id: string): Promise<unknown> {
    const account = this.accounts.find(a => a.id === id);
    if (!account) throw new Error("CLIProxyAPI account is no longer active");
    const checkedAt = new Date().toISOString();
    if (account.provider === "claude") {
      const headers = { "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": `claude-cli/${process.env.CLAUDE_CLI_VERSION ?? "2.1.306"} (external, cli)` };
      const raw = await this.providerGet(account, "https://api.anthropic.com/api/oauth/usage?cedar_ember=1", headers);
      // The weekly window is required; it can be null while idle or right after a reset, which is
      // 0% used. The 5-hour window is optional: only some accounts have one, and it is null while idle.
      if (!hasWeeklyWindow(raw)) throw new Error("Claude usage response is missing the weekly window");
      let profile = this.profiles.get(id);
      if (!profile || Date.now() - profile.at > PROFILE_TTL_MS) {
        try {
          const rawProfile = await this.providerGet(account, "https://api.anthropic.com/api/oauth/profile", headers);
          profile = { at: Date.now(), label: planLabel(rawProfile), subscription: claudeSubscription(rawProfile, new Date().toISOString()) };
          this.profiles.set(id, profile);
        } catch { /* Keep a known plan if the optional profile request fails. */ }
      }
      return { ...parseClaudeUsage(raw, profile?.label ?? null, parseClaudeResetCredits(raw.cedar_ember)),
        subscription: profile?.subscription ?? null,
        connection_id: id, source: "cliproxyapi", checked_at: checkedAt,
        reset_credits_checked_at: raw.cedar_ember ? checkedAt : null };
    }
    const headers: Record<string, string> = { "User-Agent": "codex-tui/0.149.1" };
    if (account.accountId) headers["ChatGPT-Account-ID"] = account.accountId;
    const raw = await this.providerGet(account, "https://chatgpt.com/backend-api/wham/usage", headers);
    if (!raw.rate_limit) throw new Error("Codex usage response is missing quota windows");
    let resets = null;
    let resetCheckedAt: string | null = null;
    let resetError: string | null = null;
    const count = raw.rate_limit_reset_credits?.available_count;
    const cached = this.resetDetails.get(id);
    if (count === 0) {
      resets = parseResetCredits({ available_count: 0 });
      resetCheckedAt = checkedAt;
    } else if (cached && cached.count === count && Date.now() - cached.at < RESET_DETAIL_TTL_MS) {
      resets = cached.resets;
      resetCheckedAt = new Date(cached.at).toISOString();
    } else {
      try {
        const detail = await this.providerGet(account, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
          { ...headers, "OpenAI-Beta": "codex-1", Originator: "Codex Desktop" });
        resets = parseResetCredits(detail);
        resetCheckedAt = new Date().toISOString();
        if (typeof count === "number") this.resetDetails.set(id, { at: Date.now(), count, resets });
      } catch (err) { resetError = err instanceof Error ? err.message : "Reset-credit lookup failed"; }
    }
    let sub = this.subscriptions.get(id);
    if (!sub || Date.now() - sub.at > SUBSCRIPTION_TTL_MS) {
      try {
        const body = await this.providerGet(account, ACCOUNTS_CHECK_URL, headers);
        sub = { at: Date.now(), subscription: parseCodexSubscription(body, account.accountId, new Date().toISOString()) };
        this.subscriptions.set(id, sub);
      } catch { /* Optional; keep the last known state. */ }
    }
    return { ...parseCodexUsage(raw), reset_credits: resets, subscription: sub?.subscription ?? null,
      source: "cliproxyapi", checked_at: checkedAt,
      reset_credits_checked_at: resetCheckedAt, reset_credits_error: resetError };
  }
}
