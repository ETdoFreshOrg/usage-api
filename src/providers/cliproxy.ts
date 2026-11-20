import { throwIfRateLimited } from "../cache.js";
import { PassiveObservation, readObservation } from "../passive.js";

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
  /** CPA credential file name; identifies the account to CPA Manager (see local.ts). */
  fileName: string | null;
  /** Whether CPA reports the sign-in as rejected (expired or revoked refresh token). Read from its status only. */
  loginExpired: boolean;
}

type AuthFile = {
  id?: string; name?: string; provider?: string; type?: string; email?: string;
  auth_index?: string; disabled?: boolean; id_token?: unknown; priority?: unknown; quota?: unknown;
  status?: unknown; status_message?: unknown;
};

/** CPA marks a credential whose refresh token was rejected "unauthorized (refresh token invalid)". */
export function loginExpired(file: { status_message?: unknown }): boolean {
  return typeof file.status_message === "string" && /unauthori[sz]ed|invalid_grant|refresh token/i.test(file.status_message);
}

/**
 * Management paths this client may call. CPA's `api-call` sends an arbitrary request upstream
 * with an account's token; usage-api must never use it (ET, 2026-11-20: no outbound quota calls).
 */
export function assertLocalManagementPath(path: string) {
  if (/^\/?api-call(\/|\?|$)/.test(path) || /requests\/api-call/.test(path))
    throw new Error("usage-api does not call CLIProxyAPI's api-call (no upstream requests)");
}

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

export class CliProxyClient {
  private accounts: ProxyAccount[] = [];
  /** Claude/Codex accounts on the proxy, enabled or not, from the last listing (identity and status only, no tokens). */
  proxyAccounts: ProxyAccountStatus[] | null = null;
  constructor(private readonly baseUrl: string, private readonly key: string,
    private readonly aliases: Record<string, string> = {}, private readonly fetcher: typeof fetch = fetch) {}

  private async management(path: string, body?: unknown): Promise<any> {
    assertLocalManagementPath(path);
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
        priority: priorityOf(file.priority), observation: readObservation(file.quota),
        fileName: file.name ?? file.id ?? null, loginExpired: loginExpired(file) });
    }
    this.accounts = accounts;
    this.proxyAccounts = statuses;
    return accounts;
  }
}
