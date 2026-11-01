import { RateLimitError, throwIfRateLimited } from "../cache.js";
import { parseClaudeUsage, parseClaudeResetCredits, planLabel, hasWeeklyWindow } from "./anthropic.js";
import { parseCodexUsage, parseResetCredits } from "./codex.js";

export interface ProxyAccount {
  id: string;
  provider: string;
  name: string;
  email: string | null;
  authIndex: string;
  accountId: string | null;
}

type AuthFile = {
  id?: string; name?: string; provider?: string; type?: string; email?: string;
  auth_index?: string; disabled?: boolean; id_token?: unknown;
};

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
  private profiles = new Map<string, { at: number; label: string | null }>();
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

  async listAccounts(): Promise<ProxyAccount[]> {
    const result = await this.management("auth-files");
    if (!Array.isArray(result.files)) throw new Error("CLIProxyAPI returned an invalid account list");
    const accounts: ProxyAccount[] = [];
    for (const file of result.files as AuthFile[]) {
      const provider = file.provider ?? file.type;
      if (!provider || !["claude", "codex"].includes(provider) || file.disabled || !file.auth_index) continue;
      const email = file.email?.trim().toLowerCase() || null;
      const workspace = accountId(file.id_token);
      // Preserve public IDs from the previous source and avoid token/file-name changes renumbering accounts.
      const identity = `${provider}:${email ?? file.id ?? file.name}${workspace ? `:${workspace}` : ""}`;
      const legacy = Object.entries(this.aliases).find(([, match]) => match === identity || match === `${provider}:${email}`)?.[0];
      const id = legacy ?? `cpa:${identity}`;
      if (accounts.some(a => a.id === id)) continue;
      accounts.push({ id, provider, email, name: email ?? file.name ?? id, authIndex: file.auth_index, accountId: workspace });
    }
    this.accounts = accounts;
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
      // Only the weekly window matters (Claude has no 5-hour limit any more). It can be null while
      // idle or right after a reset, which is 0% used; only a body without it at all is bad.
      if (!hasWeeklyWindow(raw)) throw new Error("Claude usage response is missing the weekly window");
      let profile = this.profiles.get(id);
      if (!profile || Date.now() - profile.at > 3_600_000) {
        try {
          const rawProfile = await this.providerGet(account, "https://api.anthropic.com/api/oauth/profile", headers);
          profile = { at: Date.now(), label: planLabel(rawProfile) };
          this.profiles.set(id, profile);
        } catch { /* Keep a known plan if the optional profile request fails. */ }
      }
      return { ...parseClaudeUsage(raw, profile?.label ?? null, parseClaudeResetCredits(raw.cedar_ember)),
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
    if (raw.rate_limit_reset_credits?.available_count === 0) {
      resets = parseResetCredits({ available_count: 0 });
      resetCheckedAt = checkedAt;
    } else {
      try {
        const detail = await this.providerGet(account, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
          { ...headers, "OpenAI-Beta": "codex-1", Originator: "Codex Desktop" });
        resets = parseResetCredits(detail);
        resetCheckedAt = new Date().toISOString();
      } catch (err) { resetError = err instanceof Error ? err.message : "Reset-credit lookup failed"; }
    }
    return { ...parseCodexUsage(raw), reset_credits: resets, source: "cliproxyapi", checked_at: checkedAt,
      reset_credits_checked_at: resetCheckedAt, reset_credits_error: resetError };
  }
}
